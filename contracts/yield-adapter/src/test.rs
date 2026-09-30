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

use soroban_sdk::testutils::{
    Address as _, Events as _, Ledger, LedgerInfo, MockAuth, MockAuthInvoke,
};
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
// Mock strategy — see `crate::mock_strategy` for the full interface and test
// knobs (simulated yield/loss, failure injection, withdrawal haircut,
// token-backed mode).

fn setup_mock_strategy(env: &Env) -> Address {
    env.register(MockStrategy, ())
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
// storage — config accessors and TTL bumping
// ---------------------------------------------------------------------------

use crate::storage::{
    DAY_IN_LEDGERS, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT,
    PERSISTENT_LIFETIME_THRESHOLD,
};

/// Advance the ledger sequence far enough that every entry bumped to a full
/// `*_BUMP_AMOUNT` has decayed below its lifetime threshold.
fn age_past_ttl_thresholds(env: &Env) {
    env.ledger()
        .with_mut(|l| l.sequence_number += 2 * DAY_IN_LEDGERS);
}

fn instance_ttl(env: &Env, client: &YieldAdapterClient) -> u32 {
    use soroban_sdk::testutils::storage::Instance as _;
    env.as_contract(&client.address, || env.storage().instance().get_ttl())
}

fn persistent_ttl(env: &Env, client: &YieldAdapterClient, key: &DataKey) -> u32 {
    use soroban_sdk::testutils::storage::Persistent as _;
    env.as_contract(&client.address, || env.storage().persistent().get_ttl(key))
}

#[test]
fn ttl_constants_leave_a_one_day_refresh_window() {
    assert_eq!(INSTANCE_BUMP_AMOUNT - INSTANCE_LIFETIME_THRESHOLD, DAY_IN_LEDGERS);
    assert_eq!(PERSISTENT_BUMP_AMOUNT - PERSISTENT_LIFETIME_THRESHOLD, DAY_IN_LEDGERS);
}

#[test]
fn token_and_admin_accessors_read_back_initialized_config() {
    let env = Env::default();
    let client = setup(&env);

    env.as_contract(&client.address, || {
        assert_eq!(crate::storage::get_token(&env), None);
        assert_eq!(crate::storage::get_admin(&env), None);
        assert_eq!(crate::storage::get_treasury(&env), None);
    });

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    client.initialize(&admin, &treasury, &token);

    env.as_contract(&client.address, || {
        assert_eq!(crate::storage::get_token(&env), Some(token.clone()));
        assert_eq!(crate::storage::get_admin(&env), Some(admin.clone()));
        assert_eq!(crate::storage::get_treasury(&env), Some(treasury.clone()));
    });
}

#[test]
fn set_token_persists_and_bumps_instance_ttl() {
    let env = Env::default();
    let client = setup(&env);
    let token = Address::generate(&env);

    env.as_contract(&client.address, || {
        crate::storage::set_token(&env, &token);
        assert_eq!(crate::storage::get_token(&env), Some(token.clone()));
    });
    assert_eq!(instance_ttl(&env, &client), INSTANCE_BUMP_AMOUNT);
}

#[test]
fn extend_instance_ttl_refreshes_only_below_threshold() {
    let env = Env::default();
    let client = setup(&env);

    env.as_contract(&client.address, || crate::storage::extend_instance_ttl(&env));
    assert_eq!(instance_ttl(&env, &client), INSTANCE_BUMP_AMOUNT);

    // Still above the threshold: a second bump is a no-op.
    env.ledger().with_mut(|l| l.sequence_number += 10);
    env.as_contract(&client.address, || crate::storage::extend_instance_ttl(&env));
    assert_eq!(instance_ttl(&env, &client), INSTANCE_BUMP_AMOUNT - 10);

    // Decayed below the threshold: bumped back to the full amount.
    age_past_ttl_thresholds(&env);
    assert!(instance_ttl(&env, &client) < INSTANCE_LIFETIME_THRESHOLD);
    env.as_contract(&client.address, || crate::storage::extend_instance_ttl(&env));
    assert_eq!(instance_ttl(&env, &client), INSTANCE_BUMP_AMOUNT);
}

#[test]
fn state_changing_entrypoints_bump_instance_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    assert_eq!(instance_ttl(&env, &client), INSTANCE_BUMP_AMOUNT);

    age_past_ttl_thresholds(&env);
    assert!(instance_ttl(&env, &client) < INSTANCE_LIFETIME_THRESHOLD);
    client.set_performance_fee_bps(&admin, &500);
    assert_eq!(instance_ttl(&env, &client), INSTANCE_BUMP_AMOUNT);

    age_past_ttl_thresholds(&env);
    client.set_paused(&admin, &true);
    assert_eq!(instance_ttl(&env, &client), INSTANCE_BUMP_AMOUNT);
}

#[test]
fn strategy_record_ttl_bumped_on_write_and_read() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, id) = register_mock_strategy(&env, &client, &admin, &token);
    let key = DataKey::Strategy(id);

    // Write (register) bumps to the full amount.
    assert_eq!(persistent_ttl(&env, &client, &key), PERSISTENT_BUMP_AMOUNT);

    // Read (get_strategy) refreshes a decayed entry.
    age_past_ttl_thresholds(&env);
    assert!(persistent_ttl(&env, &client, &key) < PERSISTENT_LIFETIME_THRESHOLD);
    client.get_strategy(&id);
    assert_eq!(persistent_ttl(&env, &client, &key), PERSISTENT_BUMP_AMOUNT);

    // Write (set_strategy_deposit_cap) refreshes it too.
    age_past_ttl_thresholds(&env);
    client.set_strategy_deposit_cap(&admin, &id, &1_000);
    assert_eq!(persistent_ttl(&env, &client, &key), PERSISTENT_BUMP_AMOUNT);
}

#[test]
fn position_and_withdraw_request_ttl_bumped_on_write_and_read() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token) = setup_with_token(&env);
    let user = funded_user(&env, &token, 1_000);
    client.deposit(&user, &1_000);
    let request_id = client.request_withdraw(&user, &400);

    let position_key = DataKey::Position(user.clone());
    let request_key = DataKey::WithdrawRequest(request_id);
    assert_eq!(
        persistent_ttl(&env, &client, &position_key),
        PERSISTENT_BUMP_AMOUNT
    );
    assert_eq!(
        persistent_ttl(&env, &client, &request_key),
        PERSISTENT_BUMP_AMOUNT
    );

    age_past_ttl_thresholds(&env);
    assert!(persistent_ttl(&env, &client, &position_key) < PERSISTENT_LIFETIME_THRESHOLD);
    assert!(persistent_ttl(&env, &client, &request_key) < PERSISTENT_LIFETIME_THRESHOLD);

    client.get_position(&user);
    client.get_withdraw_request(&request_id);
    assert_eq!(
        persistent_ttl(&env, &client, &position_key),
        PERSISTENT_BUMP_AMOUNT
    );
    assert_eq!(
        persistent_ttl(&env, &client, &request_key),
        PERSISTENT_BUMP_AMOUNT
    );
}

// ---------------------------------------------------------------------------
// storage — id allocation
// ---------------------------------------------------------------------------

#[test]
fn next_id_starts_at_one_and_strictly_increases() {
    let env = Env::default();
    let client = setup(&env);

    env.as_contract(&client.address, || {
        // Counter reads `0` when absent, so the first allocation is `1`.
        assert_eq!(
            env.storage()
                .instance()
                .get::<_, u64>(&DataKey::NextStrategyId),
            None
        );
        let mut previous = 0u64;
        for expected in 1..=5u64 {
            let id = crate::storage::next_id(&env, DataKey::NextStrategyId).unwrap();
            assert_eq!(id, expected);
            assert!(id > previous);
            previous = id;
        }
        // The counter persists the last id handed out.
        assert_eq!(
            env.storage()
                .instance()
                .get::<_, u64>(&DataKey::NextStrategyId),
            Some(5)
        );
    });
}

#[test]
fn next_id_counters_are_independent() {
    let env = Env::default();
    let client = setup(&env);

    env.as_contract(&client.address, || {
        let s1 = crate::storage::next_id(&env, DataKey::NextStrategyId).unwrap();
        let w1 = crate::storage::next_id(&env, DataKey::NextWithdrawId).unwrap();
        let s2 = crate::storage::next_id(&env, DataKey::NextStrategyId).unwrap();
        let s3 = crate::storage::next_id(&env, DataKey::NextStrategyId).unwrap();
        let w2 = crate::storage::next_id(&env, DataKey::NextWithdrawId).unwrap();

        // Each counter starts at 1 and advances only on its own allocations.
        assert_eq!((s1, s2, s3), (1, 2, 3));
        assert_eq!((w1, w2), (1, 2));
    });
}

#[test]
fn next_id_rejects_overflow_without_wrapping() {
    let env = Env::default();
    let client = setup(&env);

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::NextWithdrawId, &u64::MAX);
        assert_eq!(
            crate::storage::next_id(&env, DataKey::NextWithdrawId),
            Err(Error::Overflow)
        );
        // The counter is left where it was — no id is ever reused.
        assert_eq!(
            env.storage()
                .instance()
                .get::<_, u64>(&DataKey::NextWithdrawId),
            Some(u64::MAX)
        );
    });
}

#[test]
fn strategy_and_withdraw_ids_do_not_collide_through_entrypoints() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let user = funded_user(&env, &token, 1_000);
    client.deposit(&user, &1_000);

    let (_, strategy_1) = register_mock_strategy(&env, &client, &admin, &token);
    let request_1 = client.request_withdraw(&user, &100);
    let (_, strategy_2) = register_mock_strategy(&env, &client, &admin, &token);
    let request_2 = client.request_withdraw(&user, &100);

    assert_eq!((strategy_1, strategy_2), (1, 2));
    assert_eq!((request_1, request_2), (1, 2));
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

    client.set_strategy_deposit_cap(&admin, &id, &1_000);

    let user = funded_user(&env, &token, 1_500);
    client.deposit(&user, &1_000); // exactly at the cap is allowed
    assert_eq!(
        client.try_deposit(&user, &1),
        Err(Ok(Error::StrategyCapExceeded))
    );
    assert_eq!(client.get_position(&user).shares, 1_000);
}

#[test]
fn set_strategy_deposit_cap_persists_on_strategy_record() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, id) = register_mock_strategy(&env, &client, &admin, &token);
    let (_, other_id) = register_mock_strategy(&env, &client, &admin, &token);
    assert_eq!(client.get_strategy(&id).deposit_cap, 0);

    client.set_strategy_deposit_cap(&admin, &id, &5_000);
    assert_eq!(client.get_strategy(&id).deposit_cap, 5_000);
    // Caps are per strategy: the other record is untouched.
    assert_eq!(client.get_strategy(&other_id).deposit_cap, 0);

    // Overwriting, then resetting to `0` (unlimited), both stick.
    client.set_strategy_deposit_cap(&admin, &id, &7_500);
    assert_eq!(client.get_strategy(&id).deposit_cap, 7_500);
    client.set_strategy_deposit_cap(&admin, &id, &0);
    assert_eq!(client.get_strategy(&id).deposit_cap, 0);

    // Only the cap changes — the rest of the record is preserved.
    let info = client.get_strategy(&id);
    assert_eq!(info.id, id);
    assert_eq!(info.name, String::from_str(&env, "mock"));
    assert_eq!(info.deregistered_at, None);
}

#[test]
fn set_strategy_deposit_cap_zero_means_unlimited() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, id) = activate_mock_strategy(&env, &client, &admin, &token);

    client.set_strategy_deposit_cap(&admin, &id, &100);
    let user = funded_user(&env, &token, 10_000);
    assert_eq!(
        client.try_deposit(&user, &101),
        Err(Ok(Error::StrategyCapExceeded))
    );

    client.set_strategy_deposit_cap(&admin, &id, &0);
    client.deposit(&user, &10_000);
    assert_eq!(client.get_position(&user).shares, 10_000);
}

#[test]
fn set_strategy_deposit_cap_on_inactive_strategy_has_no_live_effect() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, _active_id) = activate_mock_strategy(&env, &client, &admin, &token);
    let (_, standby_id) = register_mock_strategy(&env, &client, &admin, &token);

    client.set_strategy_deposit_cap(&admin, &standby_id, &1);
    let user = funded_user(&env, &token, 1_000);
    client.deposit(&user, &1_000);
    assert_eq!(client.get_position(&user).shares, 1_000);
}

#[test]
fn set_strategy_deposit_cap_guards() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, id) = register_mock_strategy(&env, &client, &admin, &token);
    let outsider = Address::generate(&env);

    assert_eq!(
        client.try_set_strategy_deposit_cap(&outsider, &id, &1_000),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_set_strategy_deposit_cap(&admin, &id, &-1),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client.try_set_strategy_deposit_cap(&admin, &99, &1_000),
        Err(Ok(Error::StrategyNotFound))
    );

    client.set_paused(&admin, &true);
    assert_eq!(
        client.try_set_strategy_deposit_cap(&admin, &id, &1_000),
        Err(Ok(Error::Paused))
    );

    assert_eq!(client.get_strategy(&id).deposit_cap, 0);
}

#[test]
fn set_strategy_deposit_cap_requires_admin_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, token) = setup_with_token(&env);
    let (_, id) = register_mock_strategy(&env, &client, &admin, &token);

    env.mock_auths(&[]);
    assert!(matches!(
        client.try_set_strategy_deposit_cap(&admin, &id, &1_000),
        Err(Err(_))
    ));

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_strategy_deposit_cap",
            args: (admin.clone(), id, 1_000i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_strategy_deposit_cap(&admin, &id, &1_000);
    assert_eq!(client.get_strategy(&id).deposit_cap, 1_000);
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
#[ignore = "TODO(issue): implement harvest loss handling (no fee on loss)"]
fn loss_reduces_exchange_rate_without_charging_fee() {
    todo!("harvest a negative-yield report, assert exchange_rate() decreased and fees_accrued() unchanged");
}

// ---------------------------------------------------------------------------
// Auth review — unauthorized access rejected across mutating entrypoints
// ---------------------------------------------------------------------------
//
// Covers every mutating entrypoint implemented today. Still stubbed with
// `unimplemented!()`, so not exercisable yet: `set_admin`, `set_treasury`,
// `set_withdraw_cooldown`, `upgrade`,
// `request_withdraw`, `claim_withdraw` — add a case to both tests below as
// each one lands.

/// Adapter with two registered strategies (the first one active) and a
/// pending withdraw request (id `1`) owned by `owner`.
///
/// Returns `(client, admin, token, owner, active_id, standby_id)`.
fn setup_auth_harness(env: &Env) -> (YieldAdapterClient, Address, Address, Address, u64, u64) {
    use crate::types::{DataKey, Position, WithdrawRequest};

    let (client, admin, _treasury, token) = setup_with_token(env);
    let active_id = client.register_strategy(
        &admin,
        &setup_mock_strategy(env),
        &soroban_sdk::String::from_str(env, "active"),
    );
    let standby_id = client.register_strategy(
        &admin,
        &setup_mock_strategy(env),
        &soroban_sdk::String::from_str(env, "standby"),
    );
    client.set_active_strategy(&admin, &active_id);

    // `request_withdraw` is still a stub — seed the state it would leave
    // behind, same shape as `cancel_withdraw_returns_shares_to_owner`.
    let owner = Address::generate(env);
    let now = env.ledger().timestamp();
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &600i128);
        env.storage().persistent().set(
            &DataKey::Position(owner.clone()),
            &Position {
                owner: owner.clone(),
                shares: 600,
                created_at: now,
                updated_at: now,
            },
        );
        env.storage().persistent().set(
            &DataKey::WithdrawRequest(1),
            &WithdrawRequest {
                id: 1,
                owner: owner.clone(),
                shares: 400,
                assets: 400,
                claimable_at: now,
                requested_at: now,
                claimed_at: None,
                cancelled_at: None,
            },
        );
    });
    soroban_sdk::token::StellarAssetClient::new(env, &token).mint(&client.address, &600);

    (client, admin, token, owner, active_id, standby_id)
}

fn active_strategy_id(env: &Env, client: &YieldAdapterClient) -> Option<u64> {
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get(&crate::types::DataKey::ActiveStrategy)
    })
}

fn withdraw_request_cancelled(env: &Env, client: &YieldAdapterClient, request_id: u64) -> bool {
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .get::<_, crate::types::WithdrawRequest>(&crate::types::DataKey::WithdrawRequest(
                request_id,
            ))
            .unwrap()
            .cancelled_at
            .is_some()
    })
}

/// Assert none of the calls rejected in the tests below left state behind.
fn assert_auth_harness_untouched(
    env: &Env,
    client: &YieldAdapterClient,
    active_id: u64,
    standby_id: u64,
) {
    assert_eq!(client.performance_fee_bps(), 0);
    assert!(!client.is_paused());
    assert_eq!(client.list_strategies().len(), 2);
    assert!(client.get_strategy(&standby_id).deregistered_at.is_none());
    assert_eq!(client.get_strategy(&standby_id).deposit_cap, 0);
    assert_eq!(active_strategy_id(env, client), Some(active_id));
    assert!(!withdraw_request_cancelled(env, client, 1));
    assert_eq!(client.total_shares(), 600);
}

/// A caller who signs *as themselves* but is not the admin (or, for
/// `cancel_withdraw`, not the request's owner) is rejected with
/// `Error::Unauthorized` — a valid signature is not a substitute for being
/// the right account.
#[test]
#[ignore = "TODO(issue): implement strategy::migrate_strategy — needs two mock strategies"]
fn strategy_migration_preserves_total_assets() {
    todo!(
        "register two mock strategies, deposit, migrate_strategy, assert total_assets() unchanged"
    );
}

// ---------------------------------------------------------------------------
// Property test — share/asset rounding never allows value extraction
// ---------------------------------------------------------------------------
//
// Driven through `proptest::test_runner::TestRunner` directly rather than the
// `proptest!` macro, and asserting with plain `assert!`: this crate is
// `#![no_std]`, and the macros' expansions lean on `std`/`format!` being in
// scope. A panicking case is still caught, shrunk, and reported by the runner.

const PROPTEST_CASES: u32 = 64;

fn shares_of(client: &YieldAdapterClient, owner: &Address) -> i128 {
    client
        .try_get_position(owner)
        .ok()
        .and_then(|r| r.ok())
        .map(|p| p.shares)
        .unwrap_or(0)
}

/// What `shares` would redeem for at the current exchange rate.
fn redeemable(env: &Env, client: &YieldAdapterClient, shares: i128) -> i128 {
    if shares <= 0 {
        return 0;
    }
    env.as_contract(&client.address, || {
        crate::accounting::convert_to_assets(env, shares).unwrap()
    })
}

/// Stand-in for `request_withdraw` + `claim_withdraw` (both still stubs),
/// following their doc comments: the payout is fixed with `convert_to_assets`
/// *before* the shares are burned, then paid out of the adapter's idle
/// balance. Swap this for the real entrypoints once they land.
fn simulate_withdraw(env: &Env, client: &YieldAdapterClient, owner: &Address, shares: i128) -> i128 {
    use crate::types::{DataKey, Position};

    env.as_contract(&client.address, || {
        let payout = crate::accounting::convert_to_assets(env, shares).unwrap();

        let key = DataKey::Position(owner.clone());
        let mut position: Position = env.storage().persistent().get(&key).unwrap();
        position.shares -= shares;
        env.storage().persistent().set(&key, &position);
        let total_shares = crate::accounting::total_shares(env);
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(total_shares - shares));

        if payout > 0 {
            crate::storage::transfer_out(env, owner, payout).unwrap();
        }
        payout
    })
}

/// Single deposit at an arbitrary pre-existing exchange rate: the depositor
/// can never redeem more than they put in, and existing holders are never
/// diluted by the deposit's rounding.
#[test]
fn deposit_rounding_never_favors_the_depositor() {
    use proptest::test_runner::{Config, TestRunner};

    let mut runner = TestRunner::new(Config::with_cases(PROPTEST_CASES));
    let rate_and_amount = (
        1i128..=1_000_000_000_000, // total_assets already in the vault
        1i128..=1_000_000_000_000, // total_shares already outstanding
        1i128..=1_000_000_000_000, // deposit amount
    );

    runner
        .run(&rate_and_amount, |(total_assets, total_shares, amount)| {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (client, _admin, _treasury, token) = setup_with_token(&env);
            let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);

            // Existing holders' shares are tracked only through the
            // `TotalShares` running total — no one depositor is needed to
            // establish the rate.
            env.as_contract(&client.address, || {
                env.storage()
                    .instance()
                    .set(&crate::types::DataKey::TotalShares, &total_shares);
            });
            token_admin.mint(&client.address, &total_assets);

            let user = Address::generate(&env);
            token_admin.mint(&user, &amount);
            let minted = client.deposit(&user, &amount);

            let round_trip = redeemable(&env, &client, minted);
            assert!(
                round_trip <= amount,
                "deposit {} at rate {}/{} minted {} shares redeemable for {}",
                amount,
                total_assets,
                total_shares,
                minted,
                round_trip
            );
            let existing = redeemable(&env, &client, total_shares);
            assert!(
                existing >= total_assets,
                "deposit {} at rate {}/{} diluted existing holders to {}",
                amount,
                total_assets,
                total_shares,
                existing
            );
            Ok(())
        })
        .unwrap();
}

/// Arbitrary interleavings of deposits, (partial) withdrawals, and external
/// yield across three depositors. Checks, after every step, that the acting
/// depositor's rounding never took value from anyone else; and at the end,
/// once everyone has exited, that nobody was paid more than they deposited
/// plus the yield that flowed in.
#[test]
fn share_rounding_never_allows_value_extraction() {
    use proptest::test_runner::{Config, TestRunner};

    const DEPOSIT: u8 = 0;
    const WITHDRAW: u8 = 1;
    // Any other op kind: external yield lands in the adapter.

    let mut runner = TestRunner::new(Config::with_cases(PROPTEST_CASES));
    let ops = proptest::collection::vec(
        (
            0u8..3,                     // op kind
            0usize..3,                  // acting depositor
            1i128..=1_000_000_000,      // amount (deposit / yield)
            proptest::bool::ANY,        // shrink amount to 1..=16, to hit rounding edges
            1i128..=10_000,             // withdraw fraction of position, in bps
        ),
        1..32,
    );

    runner
        .run(&ops, |ops| {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (client, _admin, _treasury, token) = setup_with_token(&env);
            let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token);

            let users = [
                Address::generate(&env),
                Address::generate(&env),
                Address::generate(&env),
            ];
            let values = |client: &YieldAdapterClient| -> [i128; 3] {
                [0, 1, 2].map(|i| redeemable(&env, client, shares_of(client, &users[i])))
            };

            let mut deposited = [0i128; 3];
            let mut paid_out = [0i128; 3];
            let mut total_yield = 0i128;

            for (kind, actor, raw_amount, small, withdraw_bps) in ops {
                let amount = if small { raw_amount % 16 + 1 } else { raw_amount };
                let before = values(&client);

                match kind {
                    DEPOSIT => {
                        token_admin.mint(&users[actor], &amount);
                        client.deposit(&users[actor], &amount);
                        deposited[actor] += amount;
                    }
                    WITHDRAW => {
                        let shares = shares_of(&client, &users[actor]) * withdraw_bps / 10_000;
                        if shares == 0 {
                            continue;
                        }
                        paid_out[actor] += simulate_withdraw(&env, &client, &users[actor], shares);
                    }
                    _ => {
                        token_admin.mint(&client.address, &amount);
                        total_yield += amount;
                    }
                }

                let after = values(&client);
                for other in 0..3 {
                    if other == actor {
                        continue;
                    }
                    assert!(
                        after[other] >= before[other],
                        "op kind {} by depositor {} (amount {}) cut depositor {}'s value from {} to {}",
                        kind,
                        actor,
                        amount,
                        other,
                        before[other],
                        after[other]
                    );
                }
            }

            // Everyone exits.
            for (i, user) in users.iter().enumerate() {
                let shares = shares_of(&client, user);
                if shares > 0 {
                    paid_out[i] += simulate_withdraw(&env, &client, user, shares);
                }
            }

            let total_deposited: i128 = deposited.iter().sum();
            let total_paid: i128 = paid_out.iter().sum();
            assert!(
                total_paid <= total_deposited + total_yield,
                "paid out {} against {} deposited + {} yield",
                total_paid,
                total_deposited,
                total_yield
            );
            for i in 0..3 {
                assert!(
                    paid_out[i] <= deposited[i] + total_yield,
                    "depositor {} was paid {} against {} deposited + {} total yield",
                    i,
                    paid_out[i],
                    deposited[i],
                    total_yield
                );
            }
            Ok(())
        })
        .unwrap();
}

// ---------------------------------------------------------------------------
// Tests carried over from main (use the crate-level `crate::mock_strategy`)
// ---------------------------------------------------------------------------

fn setup_crate_mock_strategy(env: &Env) -> Address {
    env.register(crate::mock_strategy::MockStrategy, ())
}

#[test]
fn validate_fee_bps_boundary() {
    assert!(crate::fees::validate_fee_bps(crate::fees::MAX_PERFORMANCE_FEE_BPS).is_ok());
    assert_eq!(
        crate::fees::validate_fee_bps(crate::fees::MAX_PERFORMANCE_FEE_BPS + 1),
        Err(Error::FeeTooHigh),
    );
}

#[test]
fn apply_performance_fee_credits_fees_accrued_and_returns_remainder() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::PerformanceFeeBps, &1_000u32); // 10%

        let remainder = crate::harvest::apply_performance_fee(&env, 1_000).unwrap();

        assert_eq!(remainder, 900);
        let fees_accrued: i128 = env.storage().instance().get(&DataKey::FeesAccrued).unwrap();
        assert_eq!(fees_accrued, 100);
    });
}

#[test]
fn apply_performance_fee_accumulates_across_calls() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::PerformanceFeeBps, &500u32); // 5%

        crate::harvest::apply_performance_fee(&env, 2_000).unwrap();
        crate::harvest::apply_performance_fee(&env, 4_000).unwrap();

        let fees_accrued: i128 = env.storage().instance().get(&DataKey::FeesAccrued).unwrap();
        // 2_000 * 500 / 10_000 = 100; 4_000 * 500 / 10_000 = 200.
        assert_eq!(fees_accrued, 300);
    });
}

#[test]
fn apply_performance_fee_zero_bps_credits_nothing() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    env.as_contract(&contract_id, || {
        // `PerformanceFeeBps` left unset — defaults to 0 per `admin::performance_fee_bps`.
        let remainder = crate::harvest::apply_performance_fee(&env, 5_000).unwrap();

        assert_eq!(remainder, 5_000);
        let fees_accrued: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeesAccrued)
            .unwrap_or(0);
        assert_eq!(fees_accrued, 0);
    });
}

#[test]
fn check_harvest_interval_default_allows_immediate_harvest() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    env.as_contract(&contract_id, || {
        // No `HarvestInterval` / `LastHarvestAt` set — first-ever harvest must
        // never be blocked.
        assert!(crate::harvest::check_harvest_interval(&env).is_ok());
    });
}

#[test]
fn check_harvest_interval_rejects_too_soon() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    let start: u64 = 1_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: start,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::HarvestInterval, &3_600u64); // 1 hour
        env.storage()
            .instance()
            .set(&DataKey::LastHarvestAt, &start);

        // Not enough time has elapsed yet.
        env.ledger().set(LedgerInfo {
            timestamp: start + 1_800, // 30 minutes later
            protocol_version: 22,
            sequence_number: 200,
            network_id: Default::default(),
            base_reserve: 5_000_000,
            min_temp_entry_ttl: 1,
            min_persistent_entry_ttl: 1,
            max_entry_ttl: 3_110_400,
        });
        assert_eq!(
            crate::harvest::check_harvest_interval(&env),
            Err(Error::HarvestTooSoon),
        );
    });
}

#[test]
fn check_harvest_interval_allows_after_elapsed() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    let start: u64 = 1_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: start,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::HarvestInterval, &3_600u64); // 1 hour
        env.storage()
            .instance()
            .set(&DataKey::LastHarvestAt, &start);

        // A full hour (plus one second) has elapsed.
        env.ledger().set(LedgerInfo {
            timestamp: start + 3_601,
            protocol_version: 22,
            sequence_number: 300,
            network_id: Default::default(),
            base_reserve: 5_000_000,
            min_temp_entry_ttl: 1,
            min_persistent_entry_ttl: 1,
            max_entry_ttl: 3_110_400,
        });
        assert!(crate::harvest::check_harvest_interval(&env).is_ok());
    });
}

#[test]
fn set_and_get_harvest_interval_mirrors_withdraw_cooldown_shape() {
    // `admin::initialize` is unimplemented (a separate, unassigned issue), so
    // this seeds `DataKey::Admin` directly rather than going through
    // `client.initialize(..)`.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(YieldAdapter, ());
    let client = YieldAdapterClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::Admin, &admin);
    });

    assert_eq!(client.harvest_interval(), 0);

    client.set_harvest_interval(&admin, &7_200u64);
    assert_eq!(client.harvest_interval(), 7_200);
}

#[test]
fn set_harvest_interval_rejects_non_admin_caller() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(YieldAdapter, ());
    let client = YieldAdapterClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let impostor = Address::generate(&env);

    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::Admin, &admin);
    });

    let result = client.try_set_harvest_interval(&impostor, &7_200u64);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(client.harvest_interval(), 0);
}

#[test]
fn admin_treasury_token_error_before_initialize() {
    let env = Env::default();
    let client = setup(&env);

    assert_eq!(client.try_admin(), Err(Ok(Error::NotInitialized)));
    assert_eq!(client.try_treasury(), Err(Ok(Error::NotInitialized)));
    assert_eq!(client.try_token(), Err(Ok(Error::NotInitialized)));
}

#[test]
fn set_admin_rotates_admin_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let new_admin = Address::generate(&env);

    client.set_admin(&new_admin);

    assert_eq!(client.admin(), new_admin);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_ADMIN_SET,).into_val(&env);
    let decoded: (Address, Address, u64) =
        soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (admin, new_admin, now));
}

#[test]
fn set_admin_without_admin_auth_rejected() {
    let env = Env::default();
    let (client, _admin, _treasury, _token) = setup_with_token(&env);
    let new_admin = Address::generate(&env);

    let result = client.try_set_admin(&new_admin);

    assert!(
        result.is_err(),
        "set_admin must fail without the current admin's authorization",
    );
}

#[test]
fn set_admin_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let client = setup(&env);
    let new_admin = Address::generate(&env);

    let result = client.try_set_admin(&new_admin);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn get_withdraw_request_returns_seeded_request() {
    use crate::types::{DataKey, WithdrawRequest};

    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, _token) = setup_with_token(&env);
    let owner = Address::generate(&env);
    let request_id = 1u64;
    let now = env.ledger().timestamp();

    env.as_contract(&client.address, || {
        env.storage().persistent().set(
            &DataKey::WithdrawRequest(request_id),
            &WithdrawRequest {
                id: request_id,
                owner: owner.clone(),
                shares: 500,
                assets: 500,
                claimable_at: now + 3600,
                requested_at: now,
                claimed_at: None,
                cancelled_at: None,
            },
        );
    });

    let request = client.get_withdraw_request(&request_id);
    assert_eq!(request.id, request_id);
    assert_eq!(request.owner, owner);
    assert_eq!(request.shares, 500);
    assert_eq!(request.claimable_at, now + 3600);
    assert!(request.claimed_at.is_none());
    assert!(request.cancelled_at.is_none());
}

#[test]
fn get_withdraw_request_not_found() {
    let env = Env::default();
    let (client, _admin, _treasury, _token) = setup_with_token(&env);

    let result = client.try_get_withdraw_request(&999);
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

/// Passing the *right* address (admin / position owner) without that
/// account's signature is rejected by the host's auth check before any
/// state is touched.
#[test]
fn mutating_entrypoints_reject_missing_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, token, owner, active_id, standby_id) = setup_auth_harness(&env);
    let rogue_strategy = setup_crate_mock_strategy(&env);
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&owner, &100);

    // From here on, no signature is mocked for anyone.
    env.mock_auths(&[]);

    macro_rules! assert_auth_rejected {
        ($call:expr) => {
            assert!(
                matches!($call, Err(Err(_))),
                "`{}` must be rejected without the signer's auth",
                stringify!($call)
            );
        };
    }

    assert_auth_rejected!(client.try_set_performance_fee_bps(&admin, &1_000));
    assert_auth_rejected!(client.try_set_paused(&admin, &true));
    assert_auth_rejected!(client.try_register_strategy(
        &admin,
        &rogue_strategy,
        &soroban_sdk::String::from_str(&env, "rogue"),
    ));
    assert_auth_rejected!(client.try_deregister_strategy(&admin, &standby_id));
    assert_auth_rejected!(client.try_set_active_strategy(&admin, &standby_id));
    assert_auth_rejected!(client.try_migrate_strategy(&admin, &standby_id));
    assert_auth_rejected!(client.try_set_strategy_deposit_cap(&admin, &standby_id, &1_000));
    assert_auth_rejected!(client.try_emergency_withdraw_all(&admin));
    assert_auth_rejected!(client.try_deposit(&owner, &100));
    assert_auth_rejected!(client.try_cancel_withdraw(&owner, &1));

    assert_auth_harness_untouched(&env, &client, active_id, standby_id);
    assert_eq!(
        soroban_sdk::token::Client::new(&env, &token).balance(&owner),
        100,
        "a rejected deposit must not pull the owner's tokens"
    );
}

/// `harvest` and `withdraw_fees` are permissionless by design (see their doc
/// comments) — they must keep working with no signature at all, so the auth
/// review above doesn't accidentally lock keepers out.
#[test]
fn permissionless_entrypoints_need_no_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, token, _owner, active_id, _standby_id) = setup_auth_harness(&env);
    client.set_performance_fee_bps(&admin, &1_000); // 10%
    let strategy_address = client.get_strategy(&active_id).address;
    crate::mock_strategy::MockStrategyClient::new(&env, &strategy_address)
        .set_reported_balance(&client.address, &1_000_000);
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&client.address, &100_000);

    env.mock_auths(&[]);
    let keeper = Address::generate(&env);

    assert_eq!(client.harvest(&keeper), 1_000_000);
    assert_eq!(client.withdraw_fees(&keeper), 100_000);
    assert_eq!(
        soroban_sdk::token::Client::new(&env, &token).balance(&client.treasury()),
        100_000
    );
}

#[test]
fn register_strategy_emits_strategy_registered_with_id_and_address() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);

    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_STRATEGY_REGISTERED,).into_val(&env);
    let decoded: (u64, Address, u64) = soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (id, strategy_address, now));
}

#[test]
fn set_active_strategy_emits_strategy_changed_with_from_none() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );

    client.set_active_strategy(&admin, &id);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_STRATEGY_CHANGED,).into_val(&env);
    let decoded: (Option<u64>, u64, u64) =
        soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (None, id, now));
}

#[test]
fn migrate_strategy_emits_strategy_changed_with_from_and_to() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_a = setup_crate_mock_strategy(&env);
    let strategy_b = setup_crate_mock_strategy(&env);
    let id_a = client.register_strategy(
        &admin,
        &strategy_a,
        &soroban_sdk::String::from_str(&env, "a"),
    );
    let id_b = client.register_strategy(
        &admin,
        &strategy_b,
        &soroban_sdk::String::from_str(&env, "b"),
    );
    client.set_active_strategy(&admin, &id_a);

    client.migrate_strategy(&admin, &id_b);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_STRATEGY_CHANGED,).into_val(&env);
    let decoded: (Option<u64>, u64, u64) =
        soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (Some(id_a), id_b, now));
}

#[test]
fn emergency_withdraw_all_emits_strategy_changed_with_to_none() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );
    client.set_active_strategy(&admin, &id);

    client.emergency_withdraw_all(&admin);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_STRATEGY_CHANGED,).into_val(&env);
    let decoded: (Option<u64>, Option<u64>, u64) =
        soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (Some(id), None, now));
}

#[test]
fn deregister_strategy_emits_strategy_deregistered() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );

    client.deregister_strategy(&admin, &id);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_STRATEGY_DEREGISTERED,).into_val(&env);
    let decoded: (u64, u64) = soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (id, now));
}

#[test]
fn deregister_strategy_rejects_the_active_strategy() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );
    client.set_active_strategy(&admin, &id);

    let result = client.try_deregister_strategy(&admin, &id);
    assert_eq!(result, Err(Ok(Error::StrategyActive)));
}

#[test]
fn harvest_emits_harvested_with_signed_delta_and_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let mock = crate::mock_strategy::MockStrategyClient::new(&env, &strategy_address);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );
    client.set_active_strategy(&admin, &id);
    client.set_performance_fee_bps(&admin, &1_000); // 10%

    // Simulate 1_000_000 of yield accrued in the strategy.
    mock.set_reported_balance(&client.address, &1_000_000);

    let caller = Address::generate(&env);
    let delta = client.harvest(&caller);
    assert_eq!(delta, 1_000_000);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_HARVESTED,).into_val(&env);
    let decoded: (Address, i128, i128, u64) =
        soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (caller, 1_000_000, 100_000, now));
    assert_eq!(client.fees_accrued(), 100_000);
}

#[test]
fn harvest_on_a_loss_emits_zero_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let mock = crate::mock_strategy::MockStrategyClient::new(&env, &strategy_address);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );
    client.set_active_strategy(&admin, &id);
    client.set_performance_fee_bps(&admin, &1_000);

    mock.set_reported_balance(&client.address, &1_000_000);
    client.harvest(&Address::generate(&env));
    // Now simulate a loss on the next report.
    mock.set_reported_balance(&client.address, &400_000);

    let caller = Address::generate(&env);
    let delta = client.harvest(&caller);
    assert_eq!(delta, -600_000);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_HARVESTED,).into_val(&env);
    let decoded: (Address, i128, i128, u64) =
        soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (caller, -600_000, 0, now));
    assert_eq!(
        client.fees_accrued(),
        100_000,
        "a loss must never charge a fee or touch fees already accrued from a prior positive harvest"
    );
}

#[test]
fn withdraw_fees_emits_fee_collected_and_pays_treasury() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury, token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let mock = crate::mock_strategy::MockStrategyClient::new(&env, &strategy_address);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );
    client.set_active_strategy(&admin, &id);
    client.set_performance_fee_bps(&admin, &1_000);
    mock.set_reported_balance(&client.address, &1_000_000);
    client.harvest(&Address::generate(&env));

    // The adapter needs real tokens on hand to actually pay the fee out —
    // harvest only moves accounting, not real balances (the strategy
    // interface's own deposit/withdraw calls are what move real funds; this
    // mock never actually holds the vault token, so fund the adapter
    // directly to isolate withdraw_fees' own behavior).
    let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &token);
    token_admin_client.mint(&client.address, &100_000);

    let caller = Address::generate(&env);
    let swept = client.withdraw_fees(&caller);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::events::TOPIC_FEE_COLLECTED,).into_val(&env);
    let decoded: (Address, i128, u64) = soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(swept, 100_000);
    assert_eq!(client.fees_accrued(), 0);
    let treasury_balance = soroban_sdk::token::Client::new(&env, &token).balance(&treasury);
    assert_eq!(treasury_balance, 100_000);
    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (caller, 100_000, now));
}

#[test]
fn withdraw_fees_rejects_when_nothing_accrued() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, _token) = setup_with_token(&env);

    let result = client.try_withdraw_fees(&Address::generate(&env));
    assert_eq!(result, Err(Ok(Error::NoFeesAccrued)));
}

#[test]
fn set_active_strategy_rejects_unknown_strategy_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let result = client.try_set_active_strategy(&admin, &999);
    assert_eq!(result, Err(Ok(Error::StrategyNotFound)));
}

#[test]
fn set_active_strategy_rejects_when_already_active() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );
    client.set_active_strategy(&admin, &id);

    let result = client.try_set_active_strategy(&admin, &id);
    assert_eq!(result, Err(Ok(Error::StrategyAlreadyActive)));
}

#[test]
fn register_strategy_requires_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let stranger = Address::generate(&env);

    let result = client.try_register_strategy(
        &stranger,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn harvest_rejects_with_no_active_strategy() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, _token) = setup_with_token(&env);

    let result = client.try_harvest(&Address::generate(&env));
    assert_eq!(result, Err(Ok(Error::StrategyNotFound)));
}

#[test]
fn set_performance_fee_bps_rejects_above_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);

    let result = client.try_set_performance_fee_bps(&admin, &3_001);
    assert_eq!(result, Err(Ok(Error::FeeTooHigh)));
}

#[test]
fn harvest_respects_the_configured_interval() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _treasury, _token) = setup_with_token(&env);
    let strategy_address = setup_crate_mock_strategy(&env);
    let mock = crate::mock_strategy::MockStrategyClient::new(&env, &strategy_address);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(&env, "mock"),
    );
    client.set_active_strategy(&admin, &id);
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&crate::types::DataKey::HarvestInterval, &3600u64);
    });

    client.harvest(&Address::generate(&env));

    mock.set_reported_balance(&client.address, &2_000_000);
    let result = client.try_harvest(&Address::generate(&env));
    assert_eq!(result, Err(Ok(Error::HarvestTooSoon)));
}

#[test]
fn convert_to_shares_first_deposit_one_to_one() {
    use crate::accounting::convert_to_shares;

    let env = Env::default();

    // Mock total_shares() returning 0 (first deposit scenario)
    // Since total_shares is unimplemented, we'll test the logic directly
    // by ensuring the function handles the first-deposit case correctly

    // For this test, we need to manually verify the logic:
    // When total_shares == 0, convert_to_shares should return assets as-is

    // Note: This test will work once total_shares() and total_assets() are implemented.
    // For now, it demonstrates the expected behavior.

    // Test case 1: First deposit of 1000 assets should mint 1000 shares
    let assets = 1000i128;

    // This will fail until total_shares() is implemented, but shows the intent
    // Uncomment when total_shares and total_assets are implemented:
    // let shares = convert_to_shares(&env, assets).unwrap();
    // assert_eq!(shares, 1000, "First deposit should mint shares 1:1");
}

#[test]
fn convert_to_shares_subsequent_deposit_proportional() {
    use crate::accounting::convert_to_shares;

    let env = Env::default();

    // Test subsequent deposits with a moved exchange rate
    // Scenario:
    // - Initial state: 1000 shares backed by 1200 assets (exchange rate = 1.2 assets/share)
    // - Depositor brings 600 new assets
    // - Expected shares = (600 * 1000) / 1200 = 500 shares

    // Note: This test will work once total_shares() and total_assets() are implemented
    // For now, it demonstrates the expected behavior

    // Uncomment when total_shares and total_assets are implemented:
    // Mock the state to have total_shares = 1000, total_assets = 1200
    // let assets_to_deposit = 600i128;
    // let shares = convert_to_shares(&env, assets_to_deposit).unwrap();
    // assert_eq!(shares, 500, "Should mint 500 shares for 600 assets at 1.2 exchange rate");
}

#[test]
fn convert_to_shares_rounds_down() {
    use crate::accounting::convert_to_shares;

    let env = Env::default();

    // Test that rounding favors the adapter (rounds down)
    // Scenario:
    // - 1000 shares backed by 1001 assets
    // - Depositor brings 10 assets
    // - Expected: (10 * 1000) / 1001 = 9.99... → rounds down to 9 shares

    // Note: This test will work once total_shares() and total_assets() are implemented

    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 1001
    // let assets_to_deposit = 10i128;
    // let shares = convert_to_shares(&env, assets_to_deposit).unwrap();
    // assert_eq!(shares, 9, "Should round down to 9 shares, favoring the adapter");
}

#[test]
fn convert_to_shares_rejects_zero_amount() {
    use crate::accounting::convert_to_shares;
    use crate::error::Error;

    let env = Env::default();

    // Test that zero or negative amounts are rejected
    let result = convert_to_shares(&env, 0);
    assert_eq!(
        result,
        Err(Error::InvalidAmount),
        "Should reject zero amount"
    );

    let result = convert_to_shares(&env, -100);
    assert_eq!(
        result,
        Err(Error::InvalidAmount),
        "Should reject negative amount"
    );
}

#[test]
fn convert_to_shares_handles_overflow() {
    use crate::accounting::convert_to_shares;
    use crate::error::Error;

    let env = Env::default();

    // Test overflow protection
    // Note: This requires mocking total_shares and total_assets to trigger overflow

    // Uncomment when total_shares and total_assets are implemented:
    // Mock state with very large values that would cause overflow
    // let huge_assets = i128::MAX;
    // Mock total_shares = i128::MAX, total_assets = 1
    // let result = convert_to_shares(&env, huge_assets);
    // assert_eq!(result, Err(Error::Overflow), "Should detect overflow");
}

#[test]
fn convert_to_assets_at_moved_exchange_rate() {
    use crate::accounting::convert_to_assets;

    let env = Env::default();

    // Test converting shares back to assets at a moved exchange rate
    // Scenario:
    // - 1000 shares backing 1200 assets (exchange rate = 1.2 assets/share)
    // - Convert 500 shares back to assets
    // - Expected: (500 * 1200) / 1000 = 600 assets

    // Note: This test will work once total_shares() and total_assets() are implemented

    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 1200
    // let shares_to_convert = 500i128;
    // let assets = convert_to_assets(&env, shares_to_convert).unwrap();
    // assert_eq!(assets, 600, "Should convert 500 shares to 600 assets at 1.2 exchange rate");
}

#[test]
fn convert_to_assets_rounds_down() {
    use crate::accounting::convert_to_assets;

    let env = Env::default();

    // Test that rounding favors the adapter (rounds down)
    // Scenario:
    // - 1000 shares backing 1001 assets
    // - Convert 10 shares to assets
    // - Expected: (10 * 1001) / 1000 = 10.01 → rounds down to 10 assets

    // Note: This test will work once total_shares() and total_assets() are implemented

    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 1001
    // let shares_to_convert = 10i128;
    // let assets = convert_to_assets(&env, shares_to_convert).unwrap();
    // assert_eq!(assets, 10, "Should round down to 10 assets, favoring the adapter");
}

#[test]
fn convert_to_assets_rejects_zero_shares() {
    use crate::accounting::convert_to_assets;
    use crate::error::Error;

    let env = Env::default();

    // Test that zero or negative shares are rejected
    let result = convert_to_assets(&env, 0);
    assert_eq!(
        result,
        Err(Error::InvalidAmount),
        "Should reject zero shares"
    );

    let result = convert_to_assets(&env, -100);
    assert_eq!(
        result,
        Err(Error::InvalidAmount),
        "Should reject negative shares"
    );
}

#[test]
fn convert_to_assets_handles_no_shares_outstanding() {
    use crate::accounting::convert_to_assets;
    use crate::error::Error;

    let env = Env::default();

    // Test that conversion fails when no shares exist in the system
    // Note: This requires total_shares() to return 0

    // Uncomment when total_shares is implemented:
    // Mock state: total_shares = 0
    // let result = convert_to_assets(&env, 100);
    // assert_eq!(result, Err(Error::InvalidAmount), "Cannot convert shares when none exist");
}

#[test]
fn convert_to_assets_handles_zero_vault_value() {
    use crate::accounting::convert_to_assets;

    let env = Env::default();

    // Test edge case: shares exist but vault value is zero (total loss scenario)
    // Expected: returns 0 assets (shares are worthless)

    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 0
    // let shares_to_convert = 100i128;
    // let assets = convert_to_assets(&env, shares_to_convert).unwrap();
    // assert_eq!(assets, 0, "Shares should be worthless when vault has no assets");
}

#[test]
fn convert_to_assets_handles_overflow() {
    use crate::accounting::convert_to_assets;
    use crate::error::Error;

    let env = Env::default();

    // Test overflow protection
    // Note: This requires mocking total_shares and total_assets to trigger overflow

    // Uncomment when total_shares and total_assets are implemented:
    // Mock state with very large values that would cause overflow
    // let huge_shares = i128::MAX;
    // Mock total_shares = 1, total_assets = i128::MAX
    // let result = convert_to_assets(&env, huge_shares);
    // assert_eq!(result, Err(Error::Overflow), "Should detect overflow");
}

#[test]
fn round_trip_conversion_never_extracts_value() {
    use crate::accounting::{convert_to_assets, convert_to_shares};

    let env = Env::default();

    // Test that depositing and immediately withdrawing never extracts more value
    // than was deposited (due to both conversions rounding down)
    //
    // Scenario:
    // - Vault state: 1000 shares backing 1003 assets (slight appreciation)
    // - Deposit 100 assets
    // - Convert to shares: (100 * 1000) / 1003 = 99.7... → 99 shares (rounds down)
    // - Immediately convert back: (99 * 1003) / 1000 = 99.297 → 99 assets (rounds down)
    // - Net: deposited 100, got 99 shares, withdrew 99 assets → lost 1 asset (good)

    // Note: This test will work once total_shares() and total_assets() are implemented

    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 1003
    // let deposit_amount = 100i128;
    //
    // let shares_minted = convert_to_shares(&env, deposit_amount).unwrap();
    // assert!(shares_minted <= deposit_amount, "Should mint at most 100 shares");
    //
    // // Note: After minting, total_shares would be 1099, total_assets would be 1103
    // // For this test to be accurate, we'd need to update the mocked state
    //
    // let assets_withdrawn = convert_to_assets(&env, shares_minted).unwrap();
    // assert!(assets_withdrawn <= deposit_amount,
    //     "Round-trip should never extract more assets than deposited");
}

#[test]
fn total_shares_returns_zero_before_initialize() {
    use crate::accounting::total_shares;

    let env = Env::default();
    let client = setup(&env);

    let shares = env.as_contract(&client.address, || total_shares(&env));
    assert_eq!(shares, 0, "total_shares should be 0 before any deposits");
}

#[test]
fn total_assets_returns_zero_before_initialize() {
    use crate::accounting::total_assets;

    let env = Env::default();
    let client = setup(&env);

    let assets = env.as_contract(&client.address, || total_assets(&env));
    assert_eq!(assets, 0, "total_assets should be 0 before initialization");
}

#[test]
fn exchange_rate_returns_zero_zero_after_initialize() {
    use crate::accounting::exchange_rate;

    let env = Env::default();
    env.mock_all_auths();

    // After initialization but before any deposits
    // Note: This requires initialize() to be implemented

    // Uncomment when initialize is implemented:
    // let (client, _admin, _treasury, _token) = setup_with_token(&env);
    // let (assets, shares) = exchange_rate(&env);
    // assert_eq!(assets, 0, "total_assets should be 0 after initialize");
    // assert_eq!(shares, 0, "total_shares should be 0 after initialize");
}

#[test]
fn total_shares_reflects_running_total() {
    use crate::accounting::total_shares;
    use crate::types::DataKey;

    let env = Env::default();
    let client = setup(&env);

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &1000i128);
    });

    let shares = env.as_contract(&client.address, || total_shares(&env));
    assert_eq!(shares, 1000, "total_shares should reflect stored value");
}

#[test]
fn total_assets_includes_idle_balance() {
    use crate::accounting::total_assets;

    let env = Env::default();
    env.mock_all_auths();

    // Note: This test requires a token to be set and the contract to have a balance
    // Full test requires initialize() and token setup

    // Uncomment when initialize and token setup are available:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    //
    // // Mint some tokens to the contract
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&env.current_contract_address(), &5000);
    //
    // let assets = total_assets(&env);
    // assert_eq!(assets, 5000, "total_assets should equal idle balance when no strategy is active");
}

#[test]
fn total_assets_includes_strategy_deployed_balance() {
    use crate::accounting::total_assets;

    let env = Env::default();
    env.mock_all_auths();

    // Test that total_assets includes both idle balance and strategy-deployed balance
    // Note: This requires:
    // 1. A mock strategy contract that implements balance(of: Address) -> i128
    // 2. initialize() to be implemented
    // 3. register_strategy() and set_active_strategy() to be implemented

    // Uncomment when dependencies are implemented:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    //
    // // Create and register a mock strategy
    // let mock_strategy = Address::generate(&env);
    // // Mock the strategy's balance() call to return 3000
    //
    // // Set up: 2000 idle + 3000 in strategy = 5000 total
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&env.current_contract_address(), &2000);
    //
    // let assets = total_assets(&env);
    // assert_eq!(assets, 5000, "total_assets should be idle + strategy deployed");
}

#[test]
fn exchange_rate_after_first_deposit() {
    use crate::accounting::exchange_rate;

    let env = Env::default();
    env.mock_all_auths();

    // After first deposit, exchange_rate should reflect the deposit
    // Expected: if 1000 assets deposited → 1000 shares minted → rate (1000, 1000)

    // Note: This requires initialize() and deposit() to be implemented

    // Uncomment when dependencies are implemented:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    // let user = Address::generate(&env);
    //
    // // Mint tokens to user and deposit
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&user, &1000);
    // client.deposit(&user, &1000);
    //
    // let (assets, shares) = exchange_rate(&env);
    // assert_eq!(assets, 1000, "total_assets should equal first deposit");
    // assert_eq!(shares, 1000, "total_shares should equal first deposit (1:1)");
}

#[test]
fn exchange_rate_moves_after_yield() {
    use crate::accounting::exchange_rate;

    let env = Env::default();
    env.mock_all_auths();

    // After harvest reports positive yield, exchange_rate should reflect appreciation
    // Scenario:
    // - Initial: 1000 shares backing 1000 assets (rate = 1.0)
    // - Strategy earns 200 yield
    // - After harvest: 1000 shares backing 1200 assets (rate = 1.2)

    // Note: This requires initialize(), deposit(), harvest(), and a mock strategy

    // Uncomment when dependencies are implemented:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    // let user = Address::generate(&env);
    //
    // // Initial deposit
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&user, &1000);
    // client.deposit(&user, &1000);
    //
    // // Simulate yield: mock strategy now reports 1200 balance
    // // Call harvest to update exchange rate
    //
    // let (assets, shares) = exchange_rate(&env);
    // assert_eq!(assets, 1200, "total_assets should include yield");
    // assert_eq!(shares, 1000, "total_shares unchanged (no new deposits)");
    //
    // // Exchange rate = 1200 / 1000 = 1.2 assets per share
}

#[test]
fn total_assets_handles_strategy_query_failure() {
    use crate::accounting::total_assets;

    let env = Env::default();
    env.mock_all_auths();

    // If the strategy's balance() call fails, total_assets should fall back to idle balance
    // Note: This requires setting up a strategy that fails on balance() call

    // Uncomment when dependencies are implemented:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    //
    // // Set up a strategy that panics on balance() call
    // // Set idle balance to 500
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&env.current_contract_address(), &500);
    //
    // let assets = total_assets(&env);
    // assert_eq!(assets, 500, "Should return idle balance when strategy fails");
}

#[test]
fn exchange_rate_consistency_with_conversions() {
    use crate::accounting::{convert_to_assets, convert_to_shares, exchange_rate};

    let env = Env::default();

    // Test that exchange_rate is consistent with convert_to_shares and convert_to_assets
    // If exchange_rate returns (A, S), then:
    // - convert_to_shares(A) should return approximately S
    // - convert_to_assets(S) should return approximately A

    // Note: This requires mocking total_assets and total_shares

    // Uncomment when total_shares and total_assets work correctly:
    // Mock state: 1200 assets, 1000 shares
    // let (assets, shares) = exchange_rate(&env);
    // assert_eq!(assets, 1200);
    // assert_eq!(shares, 1000);
    //
    // // Test convert_to_shares: 1200 assets should mint 1000 shares
    // let computed_shares = convert_to_shares(&env, assets).unwrap();
    // assert_eq!(computed_shares, shares, "convert_to_shares should be consistent");
    //
    // // Test convert_to_assets: 1000 shares should convert to 1200 assets
    // let computed_assets = convert_to_assets(&env, shares).unwrap();
    // assert_eq!(computed_assets, assets, "convert_to_assets should be consistent");
}

/// Register + activate a mock strategy and set the performance fee.
/// Returns `(client, admin, mock)`.
fn setup_fee_harness(env: &Env, fee_bps: u32) -> (YieldAdapterClient, Address, crate::mock_strategy::MockStrategyClient) {
    let (client, admin, _treasury, _token) = setup_with_token(env);
    let strategy_address = setup_crate_mock_strategy(env);
    let mock = crate::mock_strategy::MockStrategyClient::new(env, &strategy_address);
    let id = client.register_strategy(
        &admin,
        &strategy_address,
        &soroban_sdk::String::from_str(env, "mock"),
    );
    client.set_active_strategy(&admin, &id);
    client.set_performance_fee_bps(&admin, &fee_bps);
    (client, admin, mock)
}

/// Decode the `fee_taken` field of the most recent `harvested` event. Must be
/// called directly after `harvest` — `events().all()` only covers the last
/// top-level invocation.
fn last_harvest_fee(env: &Env) -> i128 {
    let (_, _, data) = env.events().all().last().unwrap().clone();
    let decoded: (Address, i128, i128, u64) =
        soroban_sdk::TryFromVal::try_from_val(env, &data).unwrap();
    decoded.2
}

#[test]
fn performance_fee_taken_only_on_positive_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, mock) = setup_fee_harness(&env, 1_000); // 10%

    mock.set_reported_balance(&client.address, &500_000);
    let delta = client.harvest(&Address::generate(&env));

    assert_eq!(last_harvest_fee(&env), 50_000);
    assert_eq!(delta, 500_000);
    assert_eq!(client.fees_accrued(), 500_000 * 1_000 / 10_000);
}

#[test]
fn no_fee_charged_when_harvest_reports_zero_delta() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, mock) = setup_fee_harness(&env, 1_000);

    mock.set_reported_balance(&client.address, &1_000_000);
    client.harvest(&Address::generate(&env));
    let accrued_before = client.fees_accrued();

    // Strategy balance unchanged since the last harvest.
    let delta = client.harvest(&Address::generate(&env));

    assert_eq!(delta, 0);
    assert_eq!(last_harvest_fee(&env), 0);
    assert_eq!(client.fees_accrued(), accrued_before);
}

#[test]
fn no_fee_charged_on_loss() {
    let env = Env::default();
    env.mock_all_auths();
    // Start with a 0% fee so the seeding harvest accrues nothing.
    let (client, admin, mock) = setup_fee_harness(&env, 0);
    mock.set_reported_balance(&client.address, &1_000_000);
    client.harvest(&Address::generate(&env));
    assert_eq!(client.fees_accrued(), 0);

    client.set_performance_fee_bps(&admin, &3_000);
    mock.set_reported_balance(&client.address, &700_000);
    let delta = client.harvest(&Address::generate(&env));

    assert_eq!(delta, -300_000);
    assert_eq!(last_harvest_fee(&env), 0);
    assert_eq!(client.fees_accrued(), 0, "a loss must never accrue a fee");
}

#[test]
fn zero_fee_bps_accrues_nothing_on_positive_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, mock) = setup_fee_harness(&env, 0);

    mock.set_reported_balance(&client.address, &1_000_000);
    let delta = client.harvest(&Address::generate(&env));

    assert_eq!(delta, 1_000_000);
    assert_eq!(last_harvest_fee(&env), 0);
    assert_eq!(client.fees_accrued(), 0);
}

#[test]
fn max_fee_bps_takes_thirty_percent_of_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, mock) = setup_fee_harness(&env, crate::fees::MAX_PERFORMANCE_FEE_BPS);

    mock.set_reported_balance(&client.address, &1_000_000);
    client.harvest(&Address::generate(&env));

    assert_eq!(last_harvest_fee(&env), 300_000);
    assert_eq!(client.fees_accrued(), 300_000);
}

#[test]
fn fee_rounds_down_on_small_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, mock) = setup_fee_harness(&env, 1_000); // 10%

    // 9 * 10% = 0.9 -> rounds down to 0.
    mock.set_reported_balance(&client.address, &9);
    client.harvest(&Address::generate(&env));
    assert_eq!(last_harvest_fee(&env), 0);
    assert_eq!(client.fees_accrued(), 0);

    // Next delta is 19: 19 * 10% = 1.9 -> rounds down to 1.
    mock.set_reported_balance(&client.address, &28);
    client.harvest(&Address::generate(&env));
    assert_eq!(last_harvest_fee(&env), 1);
    assert_eq!(client.fees_accrued(), 1);
}

#[test]
fn fees_accumulate_across_consecutive_positive_harvests() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, mock) = setup_fee_harness(&env, 2_000); // 20%

    mock.set_reported_balance(&client.address, &100_000);
    client.harvest(&Address::generate(&env));
    mock.set_reported_balance(&client.address, &250_000);
    client.harvest(&Address::generate(&env));
    mock.set_reported_balance(&client.address, &300_000);
    client.harvest(&Address::generate(&env));

    // Deltas: 100_000 + 150_000 + 50_000 -> fees 20_000 + 30_000 + 10_000.
    assert_eq!(client.fees_accrued(), 60_000);
}

#[test]
fn fee_rate_change_applies_only_to_later_harvests() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, mock) = setup_fee_harness(&env, 1_000); // 10%

    mock.set_reported_balance(&client.address, &1_000_000);
    client.harvest(&Address::generate(&env));
    assert_eq!(client.fees_accrued(), 100_000);

    client.set_performance_fee_bps(&admin, &2_500); // 25%
    assert_eq!(
        client.fees_accrued(),
        100_000,
        "changing the rate must not retroactively re-price accrued fees"
    );

    mock.set_reported_balance(&client.address, &1_400_000);
    client.harvest(&Address::generate(&env));
    assert_eq!(client.fees_accrued(), 100_000 + 100_000);
}

#[test]
fn apply_performance_fee_rejects_non_positive_yield() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _mock) = setup_fee_harness(&env, 1_000);

    env.as_contract(&client.address, || {
        assert_eq!(
            crate::harvest::apply_performance_fee(&env, 0),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            crate::harvest::apply_performance_fee(&env, -1_000),
            Err(Error::InvalidAmount)
        );
    });
    assert_eq!(client.fees_accrued(), 0);
}

#[test]
fn apply_performance_fee_returns_depositor_remainder() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _mock) = setup_fee_harness(&env, 1_500); // 15%

    let remainder = env.as_contract(&client.address, || {
        crate::harvest::apply_performance_fee(&env, 1_000_000).unwrap()
    });

    assert_eq!(remainder, 850_000);
    assert_eq!(client.fees_accrued(), 150_000);
    assert_eq!(remainder + client.fees_accrued(), 1_000_000);
}
