#![cfg(test)]
//! Integration tests. Each remaining `#[ignore]`d test is a placeholder for
//! a contributor.
//!
//! Pattern: register the contract, register a SEP-41 mock token
//! (`StellarAssetClient` from `soroban_sdk::testutils`), initialize, then
//! exercise the entrypoint. Mirrors `savings-vault::test`'s harness shape —
//! see that module if a helper here needs a fuller reference example.
//!
//! Strategy-dependent tests use [`mock_strategy::MockStrategy`], a minimal
//! contract implementing the `deposit` / `withdraw` / `balance` interface
//! documented in `README.md` under "Strategy interface", plus one test-only
//! hook (`set_reported_balance`) to simulate yield or loss. It is enough for
//! the circuit breaker, deposit forwarding, and claim-side liquidity tests.
//! `harvest` / `migrate_strategy` tests stay ignored until those entrypoints
//! are implemented.

use soroban_sdk::testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::{token, Address, BytesN, Env, IntoVal, String, Symbol, TryFromVal, Val, Vec};

use crate::accounting::mul_div_floor;
use crate::error::Error;
use crate::events::{
    self, EVENT_SCHEMA_VERSION, TOPIC_ADMIN_SET, TOPIC_DEPOSITED, TOPIC_INIT, TOPIC_PAUSED_CHANGED,
    TOPIC_STRATEGY_CHANGED, TOPIC_STRATEGY_REGISTERED, TOPIC_UPGRADED, TOPIC_WITHDRAW_CANCELLED,
    TOPIC_WITHDRAW_CLAIMED, TOPIC_WITHDRAW_REQUESTED,
};
use crate::fees::compute_performance_fee;
use crate::types::{DataKey, StrategyInfo};
use crate::{YieldAdapter, YieldAdapterClient};

use mock_strategy::{MockStrategy, MockStrategyClient};

// ---------------------------------------------------------------------------
// Mock strategy
// ---------------------------------------------------------------------------

mod mock_strategy {
    //! Minimal strategy implementing the README's "Strategy interface".
    //!
    //! Tracks a per-depositor "reported balance" separately from the tokens
    //! it actually holds, so tests can simulate yield (report more; mint the
    //! backing tokens to the strategy if they will be withdrawn) or loss
    //! (report less) via `set_reported_balance`.

    use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

    #[contracttype]
    enum Key {
        Token,
        Balance(Address),
    }

    #[contract]
    pub struct MockStrategy;

    #[contractimpl]
    impl MockStrategy {
        pub fn __constructor(env: Env, token: Address) {
            env.storage().instance().set(&Key::Token, &token);
        }

        /// Pull `amount` from `from` (which must authorize the transfer).
        pub fn deposit(env: Env, from: Address, amount: i128) {
            from.require_auth();
            token::Client::new(&env, &Self::token(&env)).transfer(
                &from,
                &env.current_contract_address(),
                &amount,
            );
            let balance = Self::balance(env.clone(), from.clone());
            env.storage()
                .instance()
                .set(&Key::Balance(from), &(balance + amount));
        }

        /// Return `amount` to `to`.
        pub fn withdraw(env: Env, to: Address, amount: i128) {
            to.require_auth();
            let balance = Self::balance(env.clone(), to.clone());
            assert!(amount <= balance, "mock strategy: insufficient balance");
            env.storage()
                .instance()
                .set(&Key::Balance(to.clone()), &(balance - amount));
            token::Client::new(&env, &Self::token(&env)).transfer(
                &env.current_contract_address(),
                &to,
                &amount,
            );
        }

        pub fn balance(env: Env, of: Address) -> i128 {
            env.storage().instance().get(&Key::Balance(of)).unwrap_or(0)
        }

        /// Test hook: overwrite what `balance(of)` reports, without moving
        /// any tokens.
        pub fn set_reported_balance(env: Env, of: Address, amount: i128) {
            env.storage().instance().set(&Key::Balance(of), &amount);
        }

        fn token(env: &Env) -> Address {
            env.storage().instance().get(&Key::Token).unwrap()
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn setup(env: &Env) -> YieldAdapterClient<'_> {
    let contract_id = env.register(YieldAdapter, ());
    YieldAdapterClient::new(env, &contract_id)
}

/// Full setup: adapter + SEP-41 mock token + admin + treasury.
///
/// Returns `(client, admin, treasury, token_address)`.
fn setup_with_token(env: &Env) -> (YieldAdapterClient<'_>, Address, Address, Address) {
    let client = setup(env);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let token_admin = Address::generate(env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_id.address();

    client.initialize(&admin, &treasury, &token_address);

    (client, admin, treasury, token_address)
}

/// Mint `amount` of the test token to `to` (requires mocked auths).
fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token).mint(to, &amount);
}

fn balance_of(env: &Env, token: &Address, who: &Address) -> i128 {
    token::Client::new(env, token).balance(who)
}

/// Generate a user and fund them with `amount`.
fn funded_user(env: &Env, token: &Address, amount: i128) -> Address {
    let user = Address::generate(env);
    mint(env, token, &user, amount);
    user
}

/// Deploy a mock strategy for `token` and register it (not activated).
fn register_mock_strategy<'a>(
    env: &'a Env,
    client: &YieldAdapterClient,
    admin: &Address,
    token: &Address,
) -> (MockStrategyClient<'a>, u64) {
    let strategy_id = env.register(MockStrategy, (token.clone(),));
    let strategy = MockStrategyClient::new(env, &strategy_id);
    let id = client.register_strategy(admin, &strategy_id, &String::from_str(env, "mock"));
    (strategy, id)
}

/// Deploy, register, and activate a mock strategy.
fn activate_mock_strategy<'a>(
    env: &'a Env,
    client: &YieldAdapterClient,
    admin: &Address,
    token: &Address,
) -> (MockStrategyClient<'a>, u64) {
    let (strategy, id) = register_mock_strategy(env, client, admin, token);
    client.set_active_strategy(admin, &id);
    (strategy, id)
}

/// Write `DataKey::WithdrawCooldown` directly. `admin::set_withdraw_cooldown`
/// is a separate (still unimplemented) issue; the claim-side enforcement
/// tested here does not depend on how the value gets set.
fn set_withdraw_cooldown_raw(env: &Env, client: &YieldAdapterClient, seconds: u64) {
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::WithdrawCooldown, &seconds);
    });
}

/// Events emitted by the adapter itself (not the token or strategy) in the
/// most recent top-level invocation, whose first topic is `topic`.
fn adapter_events(env: &Env, client: &YieldAdapterClient, topic: &str) -> Vec<(Vec<Val>, Val)> {
    let wanted = Symbol::new(env, topic);
    let mut out = Vec::new(env);
    for (contract, topics, data) in env.events().all().iter() {
        if contract != client.address {
            continue;
        }
        let first = Symbol::try_from_val(env, &topics.get(0).unwrap()).unwrap();
        if first == wanted {
            out.push_back((topics, data));
        }
    }
    out
}

/// The single adapter event with first topic `topic` in the most recent
/// invocation. Fails the test if it fired zero or more than one time.
fn single_event(env: &Env, client: &YieldAdapterClient, topic: &str) -> (Vec<Val>, Val) {
    let matching = adapter_events(env, client, topic);
    assert_eq!(matching.len(), 1, "expected exactly one `{topic}` event");
    matching.get(0).unwrap()
}

fn decode<T: TryFromVal<Env, Val>>(env: &Env, val: &Val) -> T {
    T::try_from_val(env, val).unwrap_or_else(|_| panic!("event payload did not decode"))
}

// ---------------------------------------------------------------------------
// admin / lifecycle
// ---------------------------------------------------------------------------

#[test]
fn initialize_sets_admin_treasury_and_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury, token) = setup_with_token(&env);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.treasury(), treasury);
    assert_eq!(client.token(), token);
    assert_eq!(client.total_shares(), 0);
    assert_eq!(client.total_assets(), 0);
    assert_eq!(client.exchange_rate(), (0, 0));
    assert!(!client.is_paused());
    assert_eq!(client.withdraw_cooldown(), 0);
    assert_eq!(client.fees_accrued(), 0);
    assert_eq!(client.list_strategies().len(), 0);
}

#[test]
fn reads_before_initialize_return_not_initialized() {
    let env = Env::default();
    let client = setup(&env);
    assert_eq!(client.try_admin(), Err(Ok(Error::NotInitialized)));
    assert_eq!(client.try_treasury(), Err(Ok(Error::NotInitialized)));
    assert_eq!(client.try_token(), Err(Ok(Error::NotInitialized)));
    assert_eq!(client.total_assets(), 0);
    assert_eq!(client.total_shares(), 0);
}

#[test]
fn initialize_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury, token) = setup_with_token(&env);

    let other = Address::generate(&env);
    let result = client.try_initialize(&other, &other, &other);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));

    // Original configuration is untouched, and the rejected call emitted no
    // second `init` event.
    assert_eq!(client.admin(), admin);
    assert_eq!(client.treasury(), treasury);
    assert_eq!(client.token(), token);
    assert_eq!(adapter_events(&env, &client, TOPIC_INIT).len(), 0);
}

#[test]
fn init_event_fires_once_with_documented_payload() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    let (client, admin, treasury, token) = setup_with_token(&env);

    let (topics, data) = single_event(&env, &client, TOPIC_INIT);
    let expected_topics: Vec<Val> = (Symbol::new(&env, TOPIC_INIT),).into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(Address, Address, Address, u32, u64)>(&env, &data),
        (admin, treasury, token, EVENT_SCHEMA_VERSION, 1_700_000_000)
    );
}

#[test]
fn set_admin_rotates_admin_and_emits_admin_set_once() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(42);
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let new_admin = Address::generate(&env);

    client.set_admin(&new_admin);
    // Inspect events before any further invocation: `events().all()` only
    // holds the most recent top-level invocation's events.
    let (topics, data) = single_event(&env, &client, TOPIC_ADMIN_SET);
    let expected_topics: Vec<Val> = (Symbol::new(&env, TOPIC_ADMIN_SET),).into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(Address, Address, u64)>(&env, &data),
        (admin.clone(), new_admin.clone(), 42)
    );
    assert_eq!(client.admin(), new_admin);

    // The old admin has lost admin rights.
    assert_eq!(
        client.try_set_paused(&admin, &true),
        Err(Ok(Error::Unauthorized))
    );
    client.set_paused(&new_admin, &true);
    assert!(client.is_paused());
}

#[test]
fn set_admin_requires_current_admin_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let attacker = Address::generate(&env);

    // Only the attacker signs; the current admin's auth is missing.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_admin",
            args: (&attacker,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_admin(&attacker).is_err());
    assert_eq!(client.admin(), admin);
}

#[test]
fn set_paused_toggles_and_emits_paused_changed_each_call() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(7);
    let (client, admin, _treasury, _token) = setup_with_token(&env);

    client.set_paused(&admin, &true);
    let (topics, data) = single_event(&env, &client, TOPIC_PAUSED_CHANGED);
    let expected_topics: Vec<Val> = (Symbol::new(&env, TOPIC_PAUSED_CHANGED),).into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(Address, bool, u64)>(&env, &data),
        (admin.clone(), true, 7)
    );
    assert!(client.is_paused());

    env.ledger().set_timestamp(8);
    client.set_paused(&admin, &false);
    let (_, data) = single_event(&env, &client, TOPIC_PAUSED_CHANGED);
    assert_eq!(
        decode::<(Address, bool, u64)>(&env, &data),
        (admin.clone(), false, 8)
    );
    assert!(!client.is_paused());

    // A rejected call emits nothing.
    let outsider = Address::generate(&env);
    assert_eq!(
        client.try_set_paused(&outsider, &true),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(adapter_events(&env, &client, TOPIC_PAUSED_CHANGED).len(), 0);
    assert!(!client.is_paused());
}

/// `admin::upgrade` itself is a separate, still-unimplemented issue (it
/// needs an uploaded Wasm to swap to). This pins the `upgraded` payload the
/// typed publisher emits, so `upgrade` only has to call it.
#[test]
fn upgraded_publisher_emits_documented_payload() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(99);
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let hash = BytesN::from_array(&env, &[7u8; 32]);

    env.as_contract(&client.address, || {
        events::publish_upgraded(&env, &admin, &hash);
    });

    let (topics, data) = single_event(&env, &client, TOPIC_UPGRADED);
    let expected_topics: Vec<Val> = (Symbol::new(&env, TOPIC_UPGRADED),).into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(Address, BytesN<32>, u64)>(&env, &data),
        (admin, hash, 99)
    );
}

#[test]
fn unauthorized_access_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let outsider = Address::generate(&env);

    // Admin-only entrypoints with an explicit `caller` reject a non-admin
    // caller with a typed error, even when that caller did sign.
    assert_eq!(
        client.try_set_paused(&outsider, &true),
        Err(Ok(Error::Unauthorized))
    );
    let strategy_addr = env.register(MockStrategy, (token.clone(),));
    assert_eq!(
        client.try_register_strategy(&outsider, &strategy_addr, &String::from_str(&env, "x")),
        Err(Ok(Error::Unauthorized))
    );
    let id = client.register_strategy(&admin, &strategy_addr, &String::from_str(&env, "x"));
    assert_eq!(
        client.try_set_active_strategy(&outsider, &id),
        Err(Ok(Error::Unauthorized))
    );
    client.set_active_strategy(&admin, &id);
    assert_eq!(
        client.try_emergency_withdraw_all(&outsider),
        Err(Ok(Error::Unauthorized))
    );

    // Owner-keyed entrypoints: a user can't act on someone else's request.
    let user = funded_user(&env, &token, 1_000);
    client.deposit(&user, &1_000);
    let request_id = client.request_withdraw(&user, &400);
    assert_eq!(
        client.try_claim_withdraw(&outsider, &request_id),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_cancel_withdraw(&outsider, &request_id),
        Err(Ok(Error::Unauthorized))
    );

    // With no auths mocked at all, every mutating entrypoint fails the
    // `require_auth` check and leaves state untouched.
    env.set_auths(&[]);
    assert!(client.try_set_admin(&outsider).is_err());
    assert!(client.try_set_paused(&admin, &true).is_err());
    assert!(client
        .try_register_strategy(
            &admin,
            &Address::generate(&env),
            &String::from_str(&env, "y")
        )
        .is_err());
    assert!(client.try_emergency_withdraw_all(&admin).is_err());
    assert!(client.try_deposit(&user, &1).is_err());
    assert!(client.try_request_withdraw(&user, &1).is_err());
    assert!(client.try_claim_withdraw(&user, &request_id).is_err());
    assert!(client.try_cancel_withdraw(&user, &request_id).is_err());

    assert_eq!(client.admin(), admin);
    assert!(!client.is_paused());
    assert_eq!(client.get_position(&user).shares, 600);
    assert_eq!(client.get_withdraw_request(&request_id).claimed_at, None);
}

// ---------------------------------------------------------------------------
// strategy registry
// ---------------------------------------------------------------------------

#[test]
fn register_strategy_rejects_duplicate_address() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (strategy, id) = register_mock_strategy(&env, &client, &admin, &token);
    assert_eq!(id, 1);

    let result =
        client.try_register_strategy(&admin, &strategy.address, &String::from_str(&env, "again"));
    assert_eq!(result, Err(Ok(Error::StrategyAlreadyRegistered)));
    assert_eq!(client.list_strategies().len(), 1);
}

#[test]
fn register_strategy_stores_record_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(500);
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (strategy, id) = register_mock_strategy(&env, &client, &admin, &token);

    let name = String::from_str(&env, "mock");
    let (topics, data) = single_event(&env, &client, TOPIC_STRATEGY_REGISTERED);
    let expected_topics: Vec<Val> =
        (Symbol::new(&env, TOPIC_STRATEGY_REGISTERED), id).into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(u64, Address, String, u64)>(&env, &data),
        (id, strategy.address.clone(), name.clone(), 500)
    );

    let expected = StrategyInfo {
        id,
        address: strategy.address.clone(),
        name,
        deposit_cap: 0,
        registered_at: 500,
        deregistered_at: None,
    };
    assert_eq!(client.get_strategy(&id), expected);
    assert_eq!(client.list_strategies(), soroban_sdk::vec![&env, expected]);

    // A second, distinct strategy gets the next id.
    let (_, id2) = register_mock_strategy(&env, &client, &admin, &token);
    assert_eq!(id2, 2);
    assert_eq!(client.list_strategies().len(), 2);
}

#[test]
fn get_strategy_unknown_id_is_strategy_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    assert_eq!(
        client.try_get_strategy(&1),
        Err(Ok(Error::StrategyNotFound))
    );
    assert_eq!(
        client.try_set_active_strategy(&admin, &1),
        Err(Ok(Error::StrategyNotFound))
    );
}

#[test]
fn set_active_strategy_emits_changed_and_rejects_second_activation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(10);
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, id1) = register_mock_strategy(&env, &client, &admin, &token);
    let (_, id2) = register_mock_strategy(&env, &client, &admin, &token);

    client.set_active_strategy(&admin, &id1);
    let (topics, data) = single_event(&env, &client, TOPIC_STRATEGY_CHANGED);
    let expected_topics: Vec<Val> = (Symbol::new(&env, TOPIC_STRATEGY_CHANGED),).into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(Option<u64>, Option<u64>, i128, u64)>(&env, &data),
        (None, Some(id1), 0, 10)
    );

    assert_eq!(
        client.try_set_active_strategy(&admin, &id2),
        Err(Ok(Error::StrategyAlreadyActive))
    );
}

#[test]
fn deregistered_strategy_cannot_be_activated() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, id) = register_mock_strategy(&env, &client, &admin, &token);

    // `deregister_strategy` is a separate issue; mark it deregistered directly.
    env.as_contract(&client.address, || {
        let key = DataKey::Strategy(id);
        let mut info: StrategyInfo = env.storage().persistent().get(&key).unwrap();
        info.deregistered_at = Some(1);
        env.storage().persistent().set(&key, &info);
    });

    assert_eq!(
        client.try_set_active_strategy(&admin, &id),
        Err(Ok(Error::StrategyNotFound))
    );
}

// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------

#[test]
fn deposit_mints_shares_proportional_to_exchange_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let user = funded_user(&env, &token, 1_000);

    // On the very first deposit, shares must be minted 1:1 with assets.
    let minted = client.deposit(&user, &1_000);
    assert_eq!(minted, 1_000);
    assert_eq!(client.get_position(&user).shares, 1_000);
    assert_eq!(client.total_shares(), 1_000);
    assert_eq!(client.total_assets(), 1_000);
    assert_eq!(balance_of(&env, &token, &user), 0);
    assert_eq!(balance_of(&env, &token, &client.address), 1_000);

    // Simulate the pool growing 1_000 -> 1_500 (a donation stands in for
    // harvested yield): a later depositor gets proportionally fewer shares.
    let donor = funded_user(&env, &token, 500);
    token::Client::new(&env, &token).transfer(&donor, &client.address, &500);
    assert_eq!(client.exchange_rate(), (1_500, 1_000));

    let second = funded_user(&env, &token, 300);
    assert_eq!(client.deposit(&second, &300), 200); // 300 * 1000 / 1500
    assert_eq!(client.total_shares(), 1_200);

    // Non-dividing amount rounds down (favoring the adapter): 100 * 1200 /
    // 1800 = 66.67 -> 66.
    let third = funded_user(&env, &token, 100);
    assert_eq!(client.deposit(&third, &100), 66);
}

#[test]
fn deposit_rejects_invalid_amounts() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let user = funded_user(&env, &token, 10);

    assert_eq!(client.try_deposit(&user, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(
        client.try_deposit(&user, &-5),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(client.try_get_position(&user), Err(Ok(Error::NotFound)));

    // A deposit so small it would mint 0 shares is rejected rather than
    // silently donated: pool of 1 share backed by 1_000 assets.
    client.deposit(&user, &1);
    let donor = funded_user(&env, &token, 999);
    token::Client::new(&env, &token).transfer(&donor, &client.address, &999);
    let tiny = funded_user(&env, &token, 5);
    assert_eq!(client.try_deposit(&tiny, &5), Err(Ok(Error::InvalidAmount)));
    assert_eq!(balance_of(&env, &token, &tiny), 5);
}

#[test]
fn deposit_emits_deposited_with_expected_fields() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_234);
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let user = funded_user(&env, &token, 700);

    client.deposit(&user, &300);
    let (topics, data) = single_event(&env, &client, TOPIC_DEPOSITED);
    let expected_topics: Vec<Val> =
        (Symbol::new(&env, TOPIC_DEPOSITED), user.clone()).into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(Address, i128, i128, i128, u64)>(&env, &data),
        (user.clone(), 300, 300, 300, 1_234)
    );

    // Second deposit: position_shares is the cumulative position.
    client.deposit(&user, &400);
    let (_, data) = single_event(&env, &client, TOPIC_DEPOSITED);
    assert_eq!(
        decode::<(Address, i128, i128, i128, u64)>(&env, &data),
        (user.clone(), 400, 400, 700, 1_234)
    );

    // A failed deposit emits nothing.
    assert_eq!(client.try_deposit(&user, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(adapter_events(&env, &client, TOPIC_DEPOSITED).len(), 0);
}

/// Exact auth tree, no `mock_all_auths`: the user signs only for
/// `deposit` + their own token transfer into the adapter; the adapter's
/// onward transfer into the strategy is authorized by the adapter itself
/// (`authorize_as_current_contract`), not by the user.
#[test]
fn deposit_forwards_to_active_strategy_with_exact_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (strategy, _) = activate_mock_strategy(&env, &client, &admin, &token);
    let user = funded_user(&env, &token, 1_000);

    env.mock_auths(&[MockAuth {
        address: &user,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "deposit",
            args: (&user, 1_000i128).into_val(&env),
            sub_invokes: &[MockAuthInvoke {
                contract: &token,
                fn_name: "transfer",
                args: (&user, &client.address, 1_000i128).into_val(&env),
                sub_invokes: &[],
            }],
        },
    }]);
    assert_eq!(client.deposit(&user, &1_000), 1_000);

    assert_eq!(balance_of(&env, &token, &client.address), 0);
    assert_eq!(balance_of(&env, &token, &strategy.address), 1_000);
    assert_eq!(strategy.balance(&client.address), 1_000);
    assert_eq!(client.total_assets(), 1_000);
}

#[test]
fn deposit_rejects_when_active_strategy_cap_exceeded() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, id) = activate_mock_strategy(&env, &client, &admin, &token);

    // `set_strategy_deposit_cap` is a separate issue; set the cap directly.
    env.as_contract(&client.address, || {
        let key = DataKey::Strategy(id);
        let mut info: StrategyInfo = env.storage().persistent().get(&key).unwrap();
        info.deposit_cap = 1_000;
        env.storage().persistent().set(&key, &info);
    });

    let user = funded_user(&env, &token, 1_500);
    client.deposit(&user, &1_000); // exactly at the cap is allowed
    assert_eq!(
        client.try_deposit(&user, &1),
        Err(Ok(Error::StrategyCapExceeded))
    );
    assert_eq!(client.get_position(&user).shares, 1_000);
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

#[test]
fn withdraw_round_trip_returns_correct_assets() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let user = funded_user(&env, &token, 5_000);

    client.deposit(&user, &5_000);
    let request_id = client.request_withdraw(&user, &5_000);
    assert_eq!(client.get_position(&user).shares, 0);
    assert_eq!(client.total_shares(), 0);

    let request = client.get_withdraw_request(&request_id);
    assert_eq!(request.shares, 5_000);
    assert_eq!(request.assets, 5_000);

    let paid = client.claim_withdraw(&user, &request_id);
    assert_eq!(paid, 5_000);
    assert_eq!(balance_of(&env, &token, &user), 5_000);
    assert_eq!(balance_of(&env, &token, &client.address), 0);
    assert_eq!(client.total_assets(), 0);
    assert!(client
        .get_withdraw_request(&request_id)
        .claimed_at
        .is_some());

    assert_eq!(
        client.try_claim_withdraw(&user, &request_id),
        Err(Ok(Error::WithdrawAlreadyResolved))
    );
}

#[test]
fn pending_withdraw_does_not_inflate_remaining_holders_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let alice = funded_user(&env, &token, 1_000);
    let bob = funded_user(&env, &token, 1_000);
    client.deposit(&alice, &1_000);
    client.deposit(&bob, &1_000);

    client.request_withdraw(&alice, &1_000);
    // Alice's 1_000 is still held by the adapter but owed to her; it must
    // not count toward Bob's value.
    assert_eq!(balance_of(&env, &token, &client.address), 2_000);
    assert_eq!(client.exchange_rate(), (1_000, 1_000));

    // A new depositor during the pending window is priced fairly too.
    let carol = funded_user(&env, &token, 500);
    assert_eq!(client.deposit(&carol, &500), 500);
}

#[test]
fn claim_before_cooldown_elapsed_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    set_withdraw_cooldown_raw(&env, &client, 3_600);
    let user = funded_user(&env, &token, 100);

    client.deposit(&user, &100);
    let request_id = client.request_withdraw(&user, &100);
    assert_eq!(client.get_withdraw_request(&request_id).claimable_at, 4_600);

    assert_eq!(
        client.try_claim_withdraw(&user, &request_id),
        Err(Ok(Error::CooldownNotElapsed))
    );
    env.ledger().set_timestamp(4_599);
    assert_eq!(
        client.try_claim_withdraw(&user, &request_id),
        Err(Ok(Error::CooldownNotElapsed))
    );

    env.ledger().set_timestamp(4_600);
    assert_eq!(client.claim_withdraw(&user, &request_id), 100);
}

#[test]
fn cancel_withdraw_returns_shares_to_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let user = funded_user(&env, &token, 1_000);

    client.deposit(&user, &1_000);
    let request_id = client.request_withdraw(&user, &400);
    assert_eq!(client.get_position(&user).shares, 600);
    assert_eq!(client.total_shares(), 600);

    client.cancel_withdraw(&user, &request_id);
    assert_eq!(client.get_position(&user).shares, 1_000);
    assert_eq!(client.total_shares(), 1_000);
    assert_eq!(client.exchange_rate(), (1_000, 1_000));
    assert!(client
        .get_withdraw_request(&request_id)
        .cancelled_at
        .is_some());

    assert_eq!(
        client.try_cancel_withdraw(&user, &request_id),
        Err(Ok(Error::WithdrawAlreadyResolved))
    );
    assert_eq!(
        client.try_claim_withdraw(&user, &request_id),
        Err(Ok(Error::WithdrawAlreadyResolved))
    );
}

#[test]
fn cancel_withdraw_remints_at_current_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let alice = funded_user(&env, &token, 1_000);
    let bob = funded_user(&env, &token, 1_000);
    client.deposit(&alice, &1_000);
    client.deposit(&bob, &1_000);

    // Alice fixes 500 assets out; then the pool (Bob's side) doubles.
    let request_id = client.request_withdraw(&alice, &500);
    let donor = funded_user(&env, &token, 1_500);
    token::Client::new(&env, &token).transfer(&donor, &client.address, &1_500);
    assert_eq!(client.exchange_rate(), (3_000, 1_500));

    // Re-minting 500 assets at 2 assets/share yields 250 shares, not 500.
    client.cancel_withdraw(&alice, &request_id);
    assert_eq!(client.get_position(&alice).shares, 750);
    assert_eq!(client.exchange_rate(), (3_500, 1_750));
}

#[test]
fn withdraw_more_shares_than_owned_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let owner = Address::generate(&env);

    let result = client.try_request_withdraw(&owner, &1i128);
    assert_eq!(
        result,
        Err(Ok(Error::NotFound)),
        "a request_withdraw from an owner with no position must fail with NotFound, not panic",
    );

    let user = funded_user(&env, &token, 100);
    client.deposit(&user, &100);
    assert_eq!(
        client.try_request_withdraw(&user, &101),
        Err(Ok(Error::InsufficientBalance))
    );
    assert_eq!(
        client.try_request_withdraw(&user, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(client.get_position(&user).shares, 100);
    assert_eq!(
        client.try_claim_withdraw(&user, &77),
        Err(Ok(Error::NotFound))
    );
    assert_eq!(
        client.try_cancel_withdraw(&user, &77),
        Err(Ok(Error::NotFound))
    );
    assert_eq!(
        client.try_get_withdraw_request(&77),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn claim_pulls_shortfall_from_active_strategy() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (strategy, _) = activate_mock_strategy(&env, &client, &admin, &token);
    let user = funded_user(&env, &token, 1_000);

    client.deposit(&user, &1_000);
    assert_eq!(balance_of(&env, &token, &client.address), 0);

    let request_id = client.request_withdraw(&user, &600);
    assert_eq!(client.claim_withdraw(&user, &request_id), 600);
    assert_eq!(balance_of(&env, &token, &user), 600);
    assert_eq!(strategy.balance(&client.address), 400);
    assert_eq!(client.total_assets(), 400);
}

#[test]
fn withdraw_events_fire_with_expected_fields() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(2_000);
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    set_withdraw_cooldown_raw(&env, &client, 60);
    let user = funded_user(&env, &token, 1_000);
    client.deposit(&user, &1_000);

    // withdraw_requested
    let first = client.request_withdraw(&user, &300);
    let (topics, data) = single_event(&env, &client, TOPIC_WITHDRAW_REQUESTED);
    let expected_topics: Vec<Val> = (
        Symbol::new(&env, TOPIC_WITHDRAW_REQUESTED),
        user.clone(),
        first,
    )
        .into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(u64, Address, i128, i128, u64, u64)>(&env, &data),
        (first, user.clone(), 300, 300, 2_060, 2_000)
    );

    // withdraw_cancelled
    env.ledger().set_timestamp(2_010);
    client.cancel_withdraw(&user, &first);
    let (topics, data) = single_event(&env, &client, TOPIC_WITHDRAW_CANCELLED);
    let expected_topics: Vec<Val> = (
        Symbol::new(&env, TOPIC_WITHDRAW_CANCELLED),
        user.clone(),
        first,
    )
        .into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(u64, Address, i128, i128, u64)>(&env, &data),
        (first, user.clone(), 300, 300, 2_010)
    );

    // withdraw_claimed
    let second = client.request_withdraw(&user, &250);
    env.ledger().set_timestamp(2_070);
    client.claim_withdraw(&user, &second);
    let (topics, data) = single_event(&env, &client, TOPIC_WITHDRAW_CLAIMED);
    let expected_topics: Vec<Val> = (
        Symbol::new(&env, TOPIC_WITHDRAW_CLAIMED),
        user.clone(),
        second,
    )
        .into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(u64, Address, i128, u64)>(&env, &data),
        (second, user.clone(), 250, 2_070)
    );

    // Failed calls emit none of the withdraw events.
    assert_eq!(
        client.try_claim_withdraw(&user, &second),
        Err(Ok(Error::WithdrawAlreadyResolved))
    );
    assert_eq!(
        adapter_events(&env, &client, TOPIC_WITHDRAW_CLAIMED).len(),
        0
    );
    assert_eq!(
        client.try_request_withdraw(&user, &10_000),
        Err(Ok(Error::InsufficientBalance))
    );
    assert_eq!(
        adapter_events(&env, &client, TOPIC_WITHDRAW_REQUESTED).len(),
        0
    );
}

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

/// `harvest` is also on the pause blocklist, but `harvest::harvest` is a
/// separate, still-unimplemented issue, so it is not exercised here.
#[test]
fn paused_blocks_mutations_but_not_claim_withdraw() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, strategy_id) = register_mock_strategy(&env, &client, &admin, &token);
    let user = funded_user(&env, &token, 1_000);
    client.deposit(&user, &1_000);
    let to_claim = client.request_withdraw(&user, &300);
    let to_cancel = client.request_withdraw(&user, &200);

    client.set_paused(&admin, &true);

    assert_eq!(client.try_deposit(&user, &1), Err(Ok(Error::Paused)));
    assert_eq!(
        client.try_request_withdraw(&user, &1),
        Err(Ok(Error::Paused))
    );
    let other = Address::generate(&env);
    assert_eq!(
        client.try_register_strategy(&admin, &other, &String::from_str(&env, "p")),
        Err(Ok(Error::Paused))
    );
    assert_eq!(
        client.try_set_active_strategy(&admin, &strategy_id),
        Err(Ok(Error::Paused))
    );

    // Users mid-withdrawal are never trapped, and reads keep working.
    assert_eq!(client.claim_withdraw(&user, &to_claim), 300);
    client.cancel_withdraw(&user, &to_cancel);
    assert_eq!(client.get_position(&user).shares, 700);
    assert_eq!(client.total_assets(), 700);

    client.set_paused(&admin, &false);
    let more = funded_user(&env, &token, 10);
    assert_eq!(client.deposit(&more, &10), 10);
}

// ---------------------------------------------------------------------------
// circuit breaker (#242)
// ---------------------------------------------------------------------------

#[test]
fn emergency_withdraw_all_pulls_funds_and_preserves_total_assets() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(3_000);
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (strategy, strategy_id) = activate_mock_strategy(&env, &client, &admin, &token);
    let user = funded_user(&env, &token, 1_000);
    client.deposit(&user, &1_000);

    // Strategy earned 250 of yield (backed by real tokens).
    mint(&env, &token, &strategy.address, 250);
    strategy.set_reported_balance(&client.address, &1_250);
    let assets_before = client.total_assets();
    let shares_before = client.total_shares();
    assert_eq!(assets_before, 1_250);

    let recovered = client.emergency_withdraw_all(&admin);
    assert_eq!(recovered, 1_250);

    let (topics, data) = single_event(&env, &client, TOPIC_STRATEGY_CHANGED);
    let expected_topics: Vec<Val> = (Symbol::new(&env, TOPIC_STRATEGY_CHANGED),).into_val(&env);
    assert_eq!(topics, expected_topics);
    assert_eq!(
        decode::<(Option<u64>, Option<u64>, i128, u64)>(&env, &data),
        (Some(strategy_id), None, 1_250, 3_000)
    );

    // Funds are back in the adapter; accounting is unchanged.
    assert_eq!(balance_of(&env, &token, &client.address), 1_250);
    assert_eq!(balance_of(&env, &token, &strategy.address), 0);
    assert_eq!(strategy.balance(&client.address), 0);
    assert_eq!(client.total_assets(), assets_before);
    assert_eq!(client.total_shares(), shares_before);

    // Strategy is still registered, not deregistered.
    assert_eq!(client.get_strategy(&strategy_id).deregistered_at, None);

    // No active strategy any more: a second pull has nothing to pull from.
    assert_eq!(
        client.try_emergency_withdraw_all(&admin),
        Err(Ok(Error::StrategyNotFound))
    );
}

#[test]
fn deposits_continue_idle_after_emergency_withdraw_all() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (strategy, strategy_id) = activate_mock_strategy(&env, &client, &admin, &token);
    let alice = funded_user(&env, &token, 1_000);
    client.deposit(&alice, &1_000);

    client.emergency_withdraw_all(&admin);

    // Deposits still work and are held idle (not forwarded anywhere).
    let bob = funded_user(&env, &token, 500);
    assert_eq!(client.deposit(&bob, &500), 500);
    assert_eq!(balance_of(&env, &token, &client.address), 1_500);
    assert_eq!(strategy.balance(&client.address), 0);
    assert_eq!(client.total_assets(), 1_500);

    // Withdrawals are served from idle funds.
    let request_id = client.request_withdraw(&alice, &1_000);
    assert_eq!(client.claim_withdraw(&alice, &request_id), 1_000);

    // The same strategy can be re-activated after investigation; only new
    // deposits flow back into it.
    client.set_active_strategy(&admin, &strategy_id);
    let carol = funded_user(&env, &token, 200);
    client.deposit(&carol, &200);
    assert_eq!(strategy.balance(&client.address), 200);
    assert_eq!(balance_of(&env, &token, &client.address), 500);
    assert_eq!(client.total_assets(), 700);
}

#[test]
fn emergency_withdraw_all_works_while_paused_and_with_nothing_deployed() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(5);
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, strategy_id) = activate_mock_strategy(&env, &client, &admin, &token);
    client.set_paused(&admin, &true);

    assert_eq!(client.emergency_withdraw_all(&admin), 0);
    let (_, data) = single_event(&env, &client, TOPIC_STRATEGY_CHANGED);
    assert_eq!(
        decode::<(Option<u64>, Option<u64>, i128, u64)>(&env, &data),
        (Some(strategy_id), None, 0, 5)
    );
}

#[test]
fn emergency_withdraw_all_guards() {
    let env = Env::default();
    env.mock_all_auths();

    // Before initialize.
    let uninitialized = setup(&env);
    let someone = Address::generate(&env);
    assert_eq!(
        uninitialized.try_emergency_withdraw_all(&someone),
        Err(Ok(Error::NotInitialized))
    );

    // No active strategy.
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    assert_eq!(
        client.try_emergency_withdraw_all(&admin),
        Err(Ok(Error::StrategyNotFound))
    );
    assert_eq!(
        adapter_events(&env, &client, TOPIC_STRATEGY_CHANGED).len(),
        0
    );
}

// ---------------------------------------------------------------------------
// overflow safety (#249)
// ---------------------------------------------------------------------------

#[test]
fn mul_div_floor_is_overflow_safe() {
    let env = Env::default();
    // Intermediate product far beyond i128 still resolves exactly.
    assert_eq!(
        mul_div_floor(&env, i128::MAX, i128::MAX, i128::MAX),
        Ok(i128::MAX)
    );
    assert_eq!(
        mul_div_floor(&env, 10i128.pow(30), 10i128.pow(30), 10i128.pow(30)),
        Ok(10i128.pow(30))
    );
    // Rounds down.
    assert_eq!(mul_div_floor(&env, 7, 1, 2), Ok(3));
    // Quotient that doesn't fit, and division by zero, are typed errors.
    assert_eq!(mul_div_floor(&env, i128::MAX, 2, 1), Err(Error::Overflow));
    assert_eq!(mul_div_floor(&env, 1, 1, 0), Err(Error::Overflow));
}

#[test]
fn performance_fee_math_is_overflow_safe() {
    let env = Env::default();
    assert_eq!(compute_performance_fee(&env, 1_000_001, 1_000), Ok(100_000));
    assert_eq!(compute_performance_fee(&env, 0, 3_000), Ok(0));
    // A strategy reporting an absurd yield cannot make fee math panic.
    assert_eq!(
        compute_performance_fee(&env, i128::MAX, 3_000),
        Ok(i128::MAX / 10_000 * 3_000 + (i128::MAX % 10_000) * 3_000 / 10_000)
    );
    assert_eq!(
        compute_performance_fee(&env, 100, 3_001),
        Err(Error::FeeTooHigh)
    );
    assert_eq!(
        compute_performance_fee(&env, -1, 100),
        Err(Error::InvalidAmount)
    );
}

#[test]
fn large_balances_do_not_spuriously_overflow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    // 1e20 * 1e20 = 1e40 would overflow a naive i128 `assets * shares`.
    let big = 10i128.pow(20);
    let alice = funded_user(&env, &token, big);
    let bob = funded_user(&env, &token, big);
    client.deposit(&alice, &big);
    assert_eq!(client.deposit(&bob, &big), big);

    let request_id = client.request_withdraw(&alice, &big);
    assert_eq!(client.get_withdraw_request(&request_id).assets, big);
    assert_eq!(client.claim_withdraw(&alice, &request_id), big);
}

#[test]
fn deposit_after_near_total_loss_returns_overflow_not_panic() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (strategy, _) = activate_mock_strategy(&env, &client, &admin, &token);

    let big = 10i128.pow(20);
    let alice = funded_user(&env, &token, big);
    client.deposit(&alice, &big);

    // Strategy reports a near-total loss: 1e20 shares now backed by 1 stroop,
    // so pricing a 1e19 deposit needs 1e39 shares — beyond i128::MAX.
    strategy.set_reported_balance(&client.address, &1);
    let bob = funded_user(&env, &token, 10i128.pow(19));
    assert_eq!(
        client.try_deposit(&bob, &10i128.pow(19)),
        Err(Ok(Error::Overflow))
    );
    assert_eq!(client.try_get_position(&bob), Err(Ok(Error::NotFound)));
    assert_eq!(balance_of(&env, &token, &bob), 10i128.pow(19));
    assert_eq!(client.total_shares(), big);

    // Total loss: shares outstanding but zero assets -> typed error too.
    strategy.set_reported_balance(&client.address, &0);
    assert_eq!(client.try_deposit(&bob, &1), Err(Ok(Error::Overflow)));
}

#[test]
fn total_assets_overflow_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let user = funded_user(&env, &token, 200);
    client.deposit(&user, &100); // held idle (no strategy yet)

    let (strategy, _) = activate_mock_strategy(&env, &client, &admin, &token);
    // A hostile strategy reports i128::MAX; idle (100) + i128::MAX overflows.
    strategy.set_reported_balance(&client.address, &i128::MAX);

    // `total_assets` / `exchange_rate` are infallible-typed entrypoints, so
    // the typed error surfaces as the raw contract error code.
    let overflow = soroban_sdk::Error::from_contract_error(Error::Overflow as u32);
    assert_eq!(client.try_total_assets(), Err(Ok(overflow)));
    assert_eq!(client.try_exchange_rate(), Err(Ok(overflow)));
    assert_eq!(client.try_deposit(&user, &100), Err(Ok(Error::Overflow)));
    assert_eq!(
        client.try_request_withdraw(&user, &50),
        Err(Ok(Error::Overflow))
    );
}

#[test]
fn total_shares_overflow_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let whale = funded_user(&env, &token, i128::MAX);
    client.deposit(&whale, &i128::MAX);
    assert_eq!(client.total_shares(), i128::MAX);

    // 1 more asset prices at 1 share, but total shares would exceed i128.
    let user = funded_user(&env, &token, 1);
    assert_eq!(client.try_deposit(&user, &1), Err(Ok(Error::Overflow)));
    assert_eq!(client.total_shares(), i128::MAX);
}

// ---------------------------------------------------------------------------
// Placeholder stubs — one per contributor issue
// ---------------------------------------------------------------------------

#[test]
#[ignore = "TODO(issue): implement harvest::harvest — needs a mock strategy contract"]
fn harvest_increases_exchange_rate_for_depositors() {
    todo!("deposit, simulate strategy yield, harvest, assert exchange_rate() increased");
}

#[test]
#[ignore = "TODO(issue): implement harvest::apply_performance_fee"]
fn performance_fee_taken_only_on_positive_yield() {
    todo!("harvest a positive-yield report, assert fees_accrued() == yield * fee_bps / 10_000");
}

#[test]
#[ignore = "TODO(issue): implement harvest loss handling (no fee on loss)"]
fn loss_reduces_exchange_rate_without_charging_fee() {
    todo!("harvest a negative-yield report, assert exchange_rate() decreased and fees_accrued() unchanged");
}

#[test]
#[ignore = "TODO(issue): implement strategy::migrate_strategy — needs two mock strategies"]
fn strategy_migration_preserves_total_assets() {
    todo!(
        "register two mock strategies, deposit, migrate_strategy, assert total_assets() unchanged"
    );
}

#[test]
#[ignore = "TODO(issue): property test — share/asset rounding never allows value extraction"]
fn share_rounding_never_allows_value_extraction() {
    todo!("proptest: for arbitrary sequences of deposit/request_withdraw/claim_withdraw, assert sum of payouts never exceeds sum of deposits plus harvested yield");
}
