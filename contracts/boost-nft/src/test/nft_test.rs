//! Boost-NFT contract unit tests.
//!
//! These exercise the NFT primitives directly: mint authorization, transfer,
//! ownership queries, per-owner lists, tier metadata, and event emission.
//! The vault-side integration (milestone awarding, interest boost, transfer
//! moving the boost) is tested in `savings-vault/src/test.rs`.

use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env, IntoVal, TryFromVal, Vec,
};

use crate::{BoostNft, BoostNftClient, Error, NftData, Tier};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Register the contract and return a client.
fn setup(env: &Env) -> BoostNftClient {
    let id = env.register(BoostNft, ());
    BoostNftClient::new(env, &id)
}

/// Initialize a fresh contract with `admin` and `minter`, returning the
/// client.
fn init(env: &Env, admin: &Address, minter: &Address) -> BoostNftClient {
    let client = setup(env);
    client.initialize(admin, minter);
    client
}

/// Build a `Vec<u64>` from a slice, for asserting per-owner token lists.
fn ids(env: &Env, xs: &[u64]) -> Vec<u64> {
    let mut v = Vec::new(env);
    for x in xs {
        v.push_back(*x);
    }
    v
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

#[test]
fn tier_boost_bps_constants() {
    assert_eq!(Tier::Bronze.boost_bps(), 50);
    assert_eq!(Tier::Silver.boost_bps(), 150);
    assert_eq!(Tier::Gold.boost_bps(), 300);
}

// ---------------------------------------------------------------------------
// initialize / admin / minter
// ---------------------------------------------------------------------------

#[test]
fn initialize_sets_admin_and_minter() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    assert_eq!(client.admin(), admin);
    assert_eq!(client.minter(), minter);
    assert_eq!(client.total_supply(), 0);
}

#[test]
fn initialize_rejects_double_init() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let result = client.try_initialize(&admin, &minter);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn set_admin_requires_current_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let attacker = Address::generate(&env);
    let result = client.try_set_admin(&attacker, &Address::generate(&env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    // Current admin can rotate.
    let new_admin = Address::generate(&env);
    client.set_admin(&admin, &new_admin);
    assert_eq!(client.admin(), new_admin);
}

// ---------------------------------------------------------------------------
// mint
// ---------------------------------------------------------------------------

#[test]
fn mint_as_minter_awards_token() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let owner = Address::generate(&env);
    let token_id = client.mint(&minter, &owner, &Tier::Silver, &100_000_000);

    assert_eq!(token_id, 1);
    assert_eq!(client.owner_of(&token_id), owner);
    assert_eq!(client.tier_of(&token_id), Tier::Silver);
    assert_eq!(client.balance_of(&owner), 1);
    assert_eq!(client.tokens_of(&owner), ids(&env, &[1]));
    assert_eq!(client.total_supply(), 1);
}

#[test]
fn mint_as_admin_also_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let owner = Address::generate(&env);
    let id = client.mint(&admin, &owner, &Tier::Bronze, &10_000_000);
    assert_eq!(client.owner_of(&id), owner);
}

#[test]
fn mint_increments_ids_and_lists_per_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let id1 = client.mint(&minter, &a, &Tier::Bronze, &10_000_000);
    let id2 = client.mint(&minter, &b, &Tier::Gold, &1_000_000_000);
    let id3 = client.mint(&minter, &a, &Tier::Silver, &100_000_000);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(id3, 3);
    assert_eq!(client.balance_of(&a), 2);
    assert_eq!(client.balance_of(&b), 1);
    assert_eq!(client.tokens_of(&a), ids(&env, &[1, 3]));
    assert_eq!(client.tokens_of(&b), ids(&env, &[2]));
    assert_eq!(client.total_supply(), 3);
}

#[test]
fn mint_by_unauthorized_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let attacker = Address::generate(&env);
    let owner = Address::generate(&env);
    let result = client.try_mint(&attacker, &owner, &Tier::Bronze, &10_000_000);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    // Nothing was minted.
    assert_eq!(client.total_supply(), 0);
    assert_eq!(client.balance_of(&owner), 0);
}

#[test]
fn mint_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let client = setup(&env);
    let caller = Address::generate(&env);
    let to = Address::generate(&env);
    let result = client.try_mint(&caller, &to, &Tier::Bronze, &10_000_000);
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

#[test]
fn mint_emits_typed_event() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let owner = Address::generate(&env);
    let token_id = client.mint(&minter, &owner, &Tier::Gold, &1_000_000_000);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();

    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::TOPIC_MINTED, owner.clone(), token_id).into_val(&env);
    let decoded: (u64, Address, Tier, i128, u64) =
        TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (token_id, owner, Tier::Gold, 1_000_000_000, now));
}

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

#[test]
fn transfer_moves_ownership_and_lists() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let token_id = client.mint(&minter, &from, &Tier::Silver, &100_000_000);

    client.transfer(&from, &to, &token_id);

    assert_eq!(client.owner_of(&token_id), to);
    assert_eq!(client.balance_of(&from), 0);
    assert_eq!(client.balance_of(&to), 1);
    assert_eq!(client.tokens_of(&from), ids(&env, &[]));
    assert_eq!(client.tokens_of(&to), ids(&env, &[token_id]));
    // Tier metadata is preserved across the transfer.
    assert_eq!(client.tier_of(&token_id), Tier::Silver);
}

#[test]
fn transfer_by_non_owner_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);
    let token_id = client.mint(&minter, &owner, &Tier::Bronze, &10_000_000);

    let result = client.try_transfer(&attacker, &Address::generate(&env), &token_id);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    // Owner unchanged.
    assert_eq!(client.owner_of(&token_id), owner);
}

#[test]
fn transfer_unknown_token_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let from = Address::generate(&env);
    let result = client.try_transfer(&from, &Address::generate(&env), &999);
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

#[test]
fn transfer_without_auth_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let token_id = client.mint(&minter, &from, &Tier::Bronze, &10_000_000);

    // No more mocked auths from here.
    env.set_auths(&[]);
    let result = client.try_transfer(&from, &to, &token_id);
    assert!(
        result.is_err(),
        "transfer must fail without `from`'s authorization"
    );

    // Restore auths and confirm state is untouched.
    env.mock_all_auths();
    assert_eq!(client.owner_of(&token_id), from);
}

#[test]
fn transfer_emits_typed_event() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let token_id = client.mint(&minter, &from, &Tier::Bronze, &10_000_000);

    client.transfer(&from, &to, &token_id);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();

    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (crate::TOPIC_TRANSFERRED, from.clone(), to.clone(), token_id).into_val(&env);
    let decoded: (u64, Address, Address, u64) =
        TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded, (token_id, from, to, now));
}

// ---------------------------------------------------------------------------
// token metadata
// ---------------------------------------------------------------------------

#[test]
fn token_returns_full_metadata() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let owner = Address::generate(&env);
    let token_id = client.mint(&minter, &owner, &Tier::Gold, &1_000_000_000);

    let data: NftData = client.token(&token_id);
    assert_eq!(data.token_id, token_id);
    assert_eq!(data.owner, owner);
    assert_eq!(data.tier, Tier::Gold);
    assert_eq!(data.milestone, 1_000_000_000);
    assert_eq!(data.minted_at, env.ledger().timestamp());
}

#[test]
fn token_unknown_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let minter = Address::generate(&env);
    let client = init(&env, &admin, &minter);

    let result = client.try_token(&999);
    assert_eq!(result, Err(Ok(Error::NotFound)));
}
