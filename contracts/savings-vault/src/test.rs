#![cfg(test)]
//! Test skeleton. Each `#[ignore]`d test is a placeholder for a contributor.
//!
//! Pattern: register the contract, register a SEP-41 token (StellarAssetClient
//! from `soroban_sdk::testutils`), initialize, then exercise the entrypoint.
//!
//! Helper [`setup_with_token`] wires a mock token, mints an initial balance to
//! the given user, and returns everything the tests need.  Tests that only need
//! the bare contract shell (no token) can still call [`setup`].

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger, LedgerInfo},
    token::StellarAssetClient,
    Address, Env, IntoVal, Map, String,
};

use crate::error::Error;
use crate::events::{TOPIC_DEPOSIT, TOPIC_WITHDRAW};
use crate::group_split;
use crate::{SavingsVault, SavingsVaultClient};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn setup(env: &Env) -> SavingsVaultClient {
    let contract_id = env.register(SavingsVault, ());
    SavingsVaultClient::new(env, &contract_id)
}

/// Full setup: vault + SEP-41 mock token + admin.
///
/// Returns `(client, admin, token_address)`.
fn setup_with_token(env: &Env) -> (SavingsVaultClient, Address, Address) {
    let client = setup(env);
    let admin = Address::generate(env);
    let token_admin = Address::generate(env);

    // Register a built-in Stellar asset contract as the mock USDC token.
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_id.address();

    client.initialize(&admin, &token_address);

    (client, admin, token_address)
}

/// Mint `amount` stroops of the vault token to `recipient` (bypasses auth for
/// test convenience).
fn mint(env: &Env, token: &Address, token_admin: &Address, recipient: &Address, amount: i128) {
    let sac = StellarAssetClient::new(env, token);
    env.mock_all_auths();
    sac.mint(recipient, &amount);
}

// ---------------------------------------------------------------------------
// Existing placeholder stubs
// ---------------------------------------------------------------------------

#[test]
fn initialize_sets_config() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, token) = setup_with_token(&env);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.token(), token);
}

#[test]
fn flexible_deposit_withdraw() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let amount = 25_000_000i128;
    mint(&env, &token, &token_admin, &owner, amount);
    client.deposit(&owner, &amount);
    let account = client.get_account(&owner);
    assert_eq!(account.owner, owner);
    assert_eq!(account.balance, amount);
    assert_eq!(client.try_get_account(&Address::generate(&env)), Err(Ok(Error::NotFound)));
}

#[test]
fn locked_respects_time_lock() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let amount = 25_000_000i128;
    mint(&env, &token, &token_admin, &owner, amount);
    let now = env.ledger().timestamp();
    let id = client.locked_create(&owner, &amount, &(now + 100));
    let top_up = 5_000_000i128;
    mint(&env, &token, &token_admin, &owner, top_up);
    client.locked_top_up(&owner, &id, &top_up);
    let plan = client.locked_plan(&id);
    assert_eq!(plan.balance, amount + top_up);
    assert_eq!(plan.unlock_at, now + 100);
}

// ---------------------------------------------------------------------------
// Issue #36 — goal milestone + claim
// ---------------------------------------------------------------------------

/// Contributing across the target boundary sets `reached_at` exactly once
/// and emits a `goal_reached` event alongside the `goal_contribution` event;
/// further contributions after the target is met neither move `reached_at`
/// nor re-emit the milestone event.
#[test]
fn goal_reaches_target() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);

    const TARGET: i128 = 100_000_000; // 100 USDC
    const FIRST: i128 = 40_000_000; // below target
    const SECOND: i128 = 70_000_000; // 40 + 70 = 110 -> crosses target
    const THIRD: i128 = 1_000_000; // contributed after already reached

    mint(&env, &token, &token_admin, &owner, FIRST + SECOND + THIRD);

    let goal_id = client.goal_create(&owner, &String::from_str(&env, "holiday"), &TARGET);

    // Contribute below the target: not yet reached. `events().all()` scopes
    // to the most recent top-level invocation, so this call's log holds
    // exactly the token transfer + the contribution event (no reached event).
    client.goal_contribute(&owner, &goal_id, &FIRST);
    let events_after_first = env.events().all().len();

    let goal = client.goal(&goal_id);
    assert_eq!(goal.saved_amount, FIRST);
    assert!(
        goal.reached_at.is_none(),
        "goal must not be reached before the target is crossed"
    );
    assert_eq!(
        events_after_first, 2,
        "a below-target contribution emits a transfer and a contribution event, no reached event"
    );

    // Contribute across the target boundary: reached_at set, and this
    // call's event log additionally carries the reached event.
    client.goal_contribute(&owner, &goal_id, &SECOND);
    let events_after_second = env.events().all().len();

    let goal = client.goal(&goal_id);
    assert_eq!(goal.saved_amount, FIRST + SECOND);
    assert!(
        goal.reached_at.is_some(),
        "reached_at must be set once the target is crossed"
    );
    let reached_at_first = goal.reached_at;
    assert_eq!(
        events_after_second, 3,
        "crossing the target emits a transfer, contribution, and reached event"
    );

    // Contribute again after already reached: reached_at unchanged, and no
    // reached event shows up in this call's log.
    client.goal_contribute(&owner, &goal_id, &THIRD);
    let events_after_third = env.events().all().len();

    let goal = client.goal(&goal_id);
    assert_eq!(
        goal.reached_at, reached_at_first,
        "reached_at must be set only once"
    );
    assert_eq!(
        events_after_third, 2,
        "a post-target contribution does not re-emit the reached event"
    );
}

/// Claiming a reached goal transfers the full saved balance back to the
/// owner and closes the goal so it cannot be claimed a second time.
#[test]
fn goal_claim_after_reached_returns_funds() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);

    const TARGET: i128 = 100_000_000; // 100 USDC

    mint(&env, &token, &token_admin, &owner, TARGET);

    let goal_id = client.goal_create(&owner, &String::from_str(&env, "holiday"), &TARGET);
    client.goal_contribute(&owner, &goal_id, &TARGET);

    let goal = client.goal(&goal_id);
    assert!(goal.reached_at.is_some(), "goal must be reached before claim");

    let token_client = soroban_sdk::token::Client::new(&env, &token);
    let owner_balance_before_claim = token_client.balance(&owner);

    client.goal_claim(&owner, &goal_id);

    let owner_balance_after_claim = token_client.balance(&owner);
    assert_eq!(
        owner_balance_after_claim - owner_balance_before_claim,
        TARGET,
        "claim must return the full saved amount to the owner"
    );

    // The goal is closed on claim; a second claim finds nothing to pay out.
    let result = client.try_goal_claim(&owner, &goal_id);
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

/// An unreached goal cannot be claimed and remains intact.
#[test]
fn goal_claim_before_reached_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    const TARGET: i128 = 100_000_000;
    const SAVED: i128 = 40_000_000;

    mint(&env, &token, &token_admin, &owner, SAVED);
    let goal_id = client.goal_create(&owner, &String::from_str(&env, "holiday"), &TARGET);
    client.goal_contribute(&owner, &goal_id, &SAVED);

    let result = client.try_goal_claim(&owner, &goal_id);
    assert_eq!(result, Err(Ok(Error::GoalNotReached)));
    assert_eq!(client.goal(&goal_id).saved_amount, SAVED);
}

/// Closing a group, assigning shares, and settling pays each member their
/// bps-weighted portion of the pooled contributions and fully drains the
/// group balance. Shares (34%/33%/33%) don't divide the pool evenly, so this
/// also exercises the rule that the creator (first member) absorbs the
/// rounding remainder.
#[test]
fn group_split_settles_by_shares() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let member_b = Address::generate(&env);
    let member_c = Address::generate(&env);

    const CREATOR_CONTRIB: i128 = 50_000_000;
    const MEMBER_B_CONTRIB: i128 = 30_000_000;
    const MEMBER_C_CONTRIB: i128 = 20_000_000;
    const TOTAL: i128 = CREATOR_CONTRIB + MEMBER_B_CONTRIB + MEMBER_C_CONTRIB;

    mint(&env, &token, &token_admin, &creator, CREATOR_CONTRIB);
    mint(&env, &token, &token_admin, &member_b, MEMBER_B_CONTRIB);
    mint(&env, &token, &token_admin, &member_c, MEMBER_C_CONTRIB);

    let group_id = client.group_create(&creator, &String::from_str(&env, "split-pool"));
    client.group_join(&member_b, &group_id);
    client.group_join(&member_c, &group_id);

    client.group_contribute(&creator, &group_id, &CREATOR_CONTRIB);
    client.group_contribute(&member_b, &group_id, &MEMBER_B_CONTRIB);
    client.group_contribute(&member_c, &group_id, &MEMBER_C_CONTRIB);

    client.group_close(&creator, &group_id);

    let mut shares = Map::new(&env);
    shares.set(creator.clone(), 3_334u32); // 33.34%
    shares.set(member_b.clone(), 3_333u32); // 33.33%
    shares.set(member_c.clone(), 3_333u32); // 33.33%
    client.group_set_shares(&creator, &group_id, &shares);

    let token_client = soroban_sdk::token::Client::new(&env, &token);
    let creator_before = token_client.balance(&creator);
    let member_b_before = token_client.balance(&member_b);
    let member_c_before = token_client.balance(&member_c);

    client.group_settle(&creator, &group_id);

    let creator_after = token_client.balance(&creator);
    let member_b_after = token_client.balance(&member_b);
    let member_c_after = token_client.balance(&member_c);

    let member_b_payout = TOTAL * 3_333 / group_split::TOTAL_BPS as i128;
    let member_c_payout = TOTAL * 3_333 / group_split::TOTAL_BPS as i128;
    let creator_floor_payout = TOTAL * 3_334 / group_split::TOTAL_BPS as i128;
    let remainder = TOTAL - creator_floor_payout - member_b_payout - member_c_payout;

    assert_eq!(
        member_b_after - member_b_before,
        member_b_payout,
        "member B must receive their bps-weighted share"
    );
    assert_eq!(
        member_c_after - member_c_before,
        member_c_payout,
        "member C must receive their bps-weighted share"
    );
    assert_eq!(
        creator_after - creator_before,
        creator_floor_payout + remainder,
        "creator (first member) must receive their share plus the rounding remainder"
    );

    let payouts_sum = (creator_after - creator_before)
        + (member_b_after - member_b_before)
        + (member_c_after - member_c_before);
    assert_eq!(
        payouts_sum, TOTAL,
        "payouts must exactly account for the whole pool"
    );

    let group = client.group(&group_id);
    assert_eq!(group.balance, 0, "pool must be fully drained after settle");
}

// ---------------------------------------------------------------------------
// Issue #40 — InsufficientBalance rejection
// ---------------------------------------------------------------------------

/// Flexible over-withdrawal: depositing 100 then requesting 101 must return
/// `Error::InsufficientBalance` and leave the on-chain balance unchanged.
#[test]
fn flexible_withdraw_over_balance_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    const DEPOSIT: i128 = 100_000_000; // 100 USDC (7 decimals)
    const OVER_AMOUNT: i128 = DEPOSIT + 1;

    // Fund the user's wallet so the token transfer_in can succeed.
    mint(&env, &token, &token_admin, &user, DEPOSIT);

    // Deposit the full amount.
    client.deposit(&user, &DEPOSIT);

    // Attempting to withdraw one stroop more than the balance must fail.
    let result = client.try_withdraw(&user, &OVER_AMOUNT);
    assert_eq!(
        result,
        Err(Ok(Error::InsufficientBalance)),
        "expected InsufficientBalance when withdrawing {} from a balance of {}",
        OVER_AMOUNT,
        DEPOSIT,
    );

    // Balance must remain intact after the failed withdrawal.
    let account = client.get_account(&user);
    assert_eq!(
        account.balance, DEPOSIT,
        "balance must not change after a rejected over-withdrawal",
    );
}

/// Flexible exact-balance withdrawal must succeed (boundary condition).
///
/// This is the complement of the rejection test: withdrawing exactly the
/// deposited amount must NOT return `InsufficientBalance`.
#[test]
fn flexible_withdraw_exact_balance_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    const DEPOSIT: i128 = 50_000_000; // 50 USDC

    mint(&env, &token, &token_admin, &user, DEPOSIT);
    client.deposit(&user, &DEPOSIT);

    // Withdraw the exact amount — must not error.
    client.withdraw(&user, &DEPOSIT);

    // Balance must now be zero.
    let account = client.get_account(&user);
    assert_eq!(
        account.balance, 0,
        "balance must be zero after a full withdrawal",
    );
}

/// Locked over-withdrawal: once past the unlock time, attempting to withdraw
/// more than the locked plan balance must return `Error::InsufficientBalance`.
#[test]
#[ignore = "TODO(issue #40): implement locked::withdraw balance check"]
fn locked_withdraw_over_balance_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);

    const LOCKED_AMOUNT: i128 = 200_000_000; // 200 USDC
    const OVER_AMOUNT: i128 = LOCKED_AMOUNT + 1;

    mint(&env, &token, &token_admin, &owner, LOCKED_AMOUNT);

    // Set the ledger timestamp to a known value so we can control time.
    let now: u64 = 1_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: now,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    let unlock_at = now + 1_000; // one second from now

    let plan_id = client.locked_create(&owner, &LOCKED_AMOUNT, &unlock_at);

    // Advance time past the lock.
    env.ledger().set(LedgerInfo {
        timestamp: unlock_at + 1,
        protocol_version: 22,
        sequence_number: 200,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    // Lock is open; but amount exceeds balance — must fail with InsufficientBalance.
    let result = client.try_locked_withdraw(&owner, &plan_id, &OVER_AMOUNT);
    assert_eq!(
        result,
        Err(Ok(Error::InsufficientBalance)),
        "expected InsufficientBalance when withdrawing {} from locked plan with balance {}",
        OVER_AMOUNT,
        LOCKED_AMOUNT,
    );

    // Plan balance must be untouched.
    let plan = client.locked_plan(&plan_id);
    assert_eq!(
        plan.balance, LOCKED_AMOUNT,
        "locked plan balance must not change after a rejected over-withdrawal",
    );
}

/// Locked exact-balance withdrawal must succeed once the lock has expired
/// (boundary condition paired with the rejection test above).
#[test]
#[ignore = "TODO(issue #40): implement locked::withdraw balance check"]
fn locked_withdraw_exact_balance_after_unlock_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);

    const LOCKED_AMOUNT: i128 = 75_000_000; // 75 USDC

    mint(&env, &token, &token_admin, &owner, LOCKED_AMOUNT);

    let now: u64 = 2_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: now,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    let unlock_at = now + 500;
    let plan_id = client.locked_create(&owner, &LOCKED_AMOUNT, &unlock_at);

    // Advance past the lock.
    env.ledger().set(LedgerInfo {
        timestamp: unlock_at + 1,
        protocol_version: 22,
        sequence_number: 200,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    // Withdraw the exact amount — must not error.
    client.locked_withdraw(&owner, &plan_id, &LOCKED_AMOUNT);

    let plan = client.locked_plan(&plan_id);
    assert_eq!(
        plan.balance, 0,
        "locked plan balance must be zero after a full withdrawal",
    );
}

/// Locked plan: `InsufficientBalance` takes priority over `StillLocked`.
///
/// If both conditions apply (still locked AND amount exceeds balance), the
/// contract may return either error — but must not panic or transfer funds.
/// This test documents the desired precedence: implementations SHOULD check
/// the balance guard first so callers get the most actionable error.
#[test]
#[ignore = "TODO(issue #40): confirm error precedence for locked::withdraw"]
fn locked_withdraw_still_locked_and_over_balance_prefers_insufficient_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);

    const LOCKED_AMOUNT: i128 = 10_000_000; // 10 USDC

    mint(&env, &token, &token_admin, &owner, LOCKED_AMOUNT);

    let now: u64 = 3_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: now,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    let unlock_at = now + 10_000; // still in the future
    let plan_id = client.locked_create(&owner, &LOCKED_AMOUNT, &unlock_at);

    // Attempt to withdraw more than the balance while the lock is still active.
    let result = client.try_locked_withdraw(&owner, &plan_id, &(LOCKED_AMOUNT + 1));

    // Must be one of the two valid errors; must not succeed.
    assert!(
        result == Err(Ok(Error::InsufficientBalance))
            || result == Err(Ok(Error::StillLocked)),
        "expected InsufficientBalance or StillLocked, got {:?}",
        result,
    );

    // Either way, funds must not move.
    let plan = client.locked_plan(&plan_id);
    assert_eq!(plan.balance, LOCKED_AMOUNT);
}

// ---------------------------------------------------------------------------
// Issue #39 — Unauthorized access rejected
//
// Auth model recap
// ----------------
// Every state-mutating entrypoint calls `principal.require_auth()` inside the
// contract. In the Soroban test environment this means:
//
//  • `env.mock_all_auths()` — approves every auth check; used by happy-path tests.
//  • `env.mock_auths(&[...])` — approves only the listed (contract, fn, args)
//    tuples; any un-listed auth check causes the host to abort the invocation.
//
// Two distinct failure modes exist:
//
//  1. **Wrong signer / no auth provided** — the `require_auth()` call on the
//     legitimate principal is absent from the mock list, so the host panics
//     and `try_*` returns `Err(Err(_))`.
//
//  2. **Wrong principal reaches an ownership check** — auth was provided for
//     attacker, but the contract checks `plan.owner == caller` (or equivalent)
//     and returns `Error::Unauthorized`.
//
// These tests cover case 2 (the most expressive from a contract-logic standpoint):
// the attacker has valid auth for *themselves*, but the contract enforces that
// only the resource owner / admin may act.  The helper `mock_auths_for` below
// approves auth for exactly one address so the contract reaches the ownership
// guard.
// ---------------------------------------------------------------------------

// --- Admin-only: set_admin --------------------------------------------------

/// A random address must not be able to rotate the admin.
///
/// `set_admin` must require auth from the *current* admin. A caller who is not
/// the admin should be rejected with `Error::Unauthorized`.
#[test]
fn set_admin_by_non_admin_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let attacker = Address::generate(&env);

    // Attacker provides valid auth for themselves — but they are not the admin.
    let result = client.try_set_admin(&attacker);

    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "non-admin must not be able to rotate the admin address",
    );
}

// --- Owner-only: flexible::withdraw ----------------------------------------

/// Only the account owner may withdraw from their flexible account.
///
/// A third party who provides valid auth for *themselves* must be rejected
/// even if they know the victim's address.
#[test]
#[ignore = "TODO(issue #39): implement flexible::withdraw owner check"]
fn flexible_withdraw_by_non_owner_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    const DEPOSIT: i128 = 100_000_000; // 100 USDC

    mint(&env, &token, &token_admin, &owner, DEPOSIT);
    client.deposit(&owner, &DEPOSIT);

    // Switch: only attacker's auth is approved from here on.
    // The contract must compare attacker != owner and return Unauthorized.
    env.mock_all_auths(); // reset, then re-mock as attacker-only
    let result = client.try_withdraw(&attacker, &DEPOSIT);

    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "attacker must not withdraw from another user's flexible account",
    );

    // Owner's balance must be untouched.
    env.mock_all_auths();
    let account = client.get_account(&owner);
    assert_eq!(account.balance, DEPOSIT);
}

// --- Owner-only: locked::top_up --------------------------------------------

/// Only the plan owner may top-up a locked plan.
#[test]
fn locked_top_up_by_non_owner_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    const AMOUNT: i128 = 50_000_000; // 50 USDC

    // Mint enough for both the initial create and the attempted top-up.
    mint(&env, &token, &token_admin, &owner, AMOUNT);
    mint(&env, &token, &token_admin, &attacker, AMOUNT);

    let now: u64 = 1_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: now,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    let plan_id = client.locked_create(&owner, &AMOUNT, &(now + 1_000));

    // Attacker attempts to top-up the owner's plan.
    let result = client.try_locked_top_up(&attacker, &plan_id, &AMOUNT);

    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "attacker must not top-up another user's locked plan",
    );

    // Plan balance must not change.
    let plan = client.locked_plan(&plan_id);
    assert_eq!(plan.balance, AMOUNT);
}

// --- Owner-only: locked::withdraw ------------------------------------------

/// Only the plan owner may withdraw from a locked plan, even after it unlocks.
#[test]
#[ignore = "TODO(issue #39): implement locked::withdraw owner check"]
fn locked_withdraw_by_non_owner_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    const AMOUNT: i128 = 80_000_000; // 80 USDC

    mint(&env, &token, &token_admin, &owner, AMOUNT);

    let now: u64 = 2_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: now,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    let unlock_at = now + 500;
    let plan_id = client.locked_create(&owner, &AMOUNT, &unlock_at);

    // Advance past the lock so `StillLocked` is not a confound.
    env.ledger().set(LedgerInfo {
        timestamp: unlock_at + 1,
        protocol_version: 22,
        sequence_number: 200,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    // Attacker attempts to drain the now-unlocked plan.
    let result = client.try_locked_withdraw(&attacker, &plan_id, &AMOUNT);

    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "attacker must not withdraw from another user's locked plan after unlock",
    );

    let plan = client.locked_plan(&plan_id);
    assert_eq!(plan.balance, AMOUNT);
}

// --- Owner-only: goal::claim -----------------------------------------------

/// Only the goal owner may claim the funds once the target is reached.
#[test]
#[ignore = "TODO(issue #39): implement goal::claim owner check"]
fn goal_claim_by_non_owner_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    const TARGET: i128 = 100_000_000; // 100 USDC

    mint(&env, &token, &token_admin, &owner, TARGET);

    let goal_id = client
        .goal_create(&owner, &soroban_sdk::String::from_str(&env, "holiday"), &TARGET);

    // Owner contributes the full target so the goal is reached.
    client.goal_contribute(&owner, &goal_id, &TARGET);

    // Attacker tries to claim a goal they don't own.
    let result = client.try_goal_claim(&attacker, &goal_id);

    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "attacker must not claim another user's completed goal",
    );

    // Goal's saved amount must be intact.
    let goal = client.goal(&goal_id);
    assert_eq!(goal.saved_amount, TARGET);
}

// --- Creator-only: group::close --------------------------------------------

/// Only the group creator may close a group to new members.
#[test]
#[ignore = "TODO(issue #39): implement group::close creator check"]
fn group_close_by_non_creator_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let creator = Address::generate(&env);
    let non_creator = Address::generate(&env);

    let group_id = client
        .group_create(&creator, &soroban_sdk::String::from_str(&env, "pool-a"));

    // Non-creator attempts to close the group.
    let result = client.try_group_close(&non_creator, &group_id);

    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "non-creator must not be able to close a group",
    );

    // Group must still be open.
    let group = client.group(&group_id);
    assert!(group.open, "group must remain open after rejected close attempt");
}

// --- Creator-only: group::set_shares ---------------------------------------

/// Only the group creator may configure the member share splits.
#[test]
#[ignore = "TODO(issue #39): implement group_split::set_shares creator check"]
fn group_set_shares_by_non_creator_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let creator = Address::generate(&env);
    let member = Address::generate(&env);
    let non_creator = Address::generate(&env);

    let group_id = client
        .group_create(&creator, &soroban_sdk::String::from_str(&env, "pool-b"));

    // Add a second member so a valid 10 000-bps split can be constructed.
    client.group_join(&member, &group_id);
    client.group_close(&creator, &group_id);

    // Build a valid shares map that sums to 10_000 bps.
    let mut shares = soroban_sdk::Map::new(&env);
    shares.set(creator.clone(), 5_000u32);
    shares.set(member.clone(), 5_000u32);

    // Non-creator attempts to set shares.
    let result = client.try_group_set_shares(&non_creator, &group_id, &shares);

    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "non-creator must not be able to set group shares",
    );
}

// --- Member-only: group::contribute ----------------------------------------

/// A non-member cannot contribute to a group pool.
#[test]
#[ignore = "TODO(issue #39): implement group::contribute membership check"]
fn group_contribute_by_non_member_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let outsider = Address::generate(&env);

    const AMOUNT: i128 = 20_000_000; // 20 USDC
    mint(&env, &token, &token_admin, &outsider, AMOUNT);

    let group_id = client
        .group_create(&creator, &soroban_sdk::String::from_str(&env, "pool-c"));

    // Outsider has never called group_join; must be rejected.
    let result = client.try_group_contribute(&outsider, &group_id, &AMOUNT);

    assert_eq!(
        result,
        Err(Ok(Error::NotAMember)),
        "non-member must not contribute to a group pool",
    );

    // Pool balance must remain zero.
    let group = client.group(&group_id);
    assert_eq!(group.balance, 0);
}

// --- Double-initialize guard -----------------------------------------------

/// Calling `initialize` a second time must return `Error::AlreadyInitialized`.
///
/// This is the admin-lifecycle equivalent of an auth check: only the first
/// caller (during deployment) should be able to set the admin and token.
#[test]
fn initialize_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);

    // Any address can try — the guard is idempotency, not identity.
    let second_admin = Address::generate(&env);
    let result = client.try_initialize(&second_admin, &token);

    assert_eq!(
        result,
        Err(Ok(Error::AlreadyInitialized)),
        "initialize must be callable exactly once",
    );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Issue #31 — Auth review: require_auth on all mutations
//
// Two ways an unauthorized call is rejected (see the case 1 / case 2 recap
// above the #39 tests):
//
//  1. No valid authorization exists for the principal at all — disabling
//     mocked auth (`env.set_auths(&[])`) or never enabling it means the
//     principal's `require_auth()` call inside the contract has nothing to
//     match, so the host rejects the invocation and `try_*` returns
//     `Err(Err(_))`.
//  2. The principal *did* authorize (any signer can under `mock_all_auths`),
//     but the contract compares the claimed identity against a stored
//     owner/creator field and returns a typed `Error::Unauthorized`.
//
// These tests cover every state-changing entrypoint touched by this issue in
// flexible.rs, locked.rs, and group.rs.
// ---------------------------------------------------------------------------

/// `deposit` must require `from`'s authorization — funding isn't needed
/// since the auth check happens before anything else.
#[test]
fn deposit_without_signer_auth_rejected() {
    let env = Env::default();
    let (client, _admin, _token) = setup_with_token(&env);
    let user = Address::generate(&env);

    let result = client.try_deposit(&user, &10_000_000i128);

    assert!(
        result.is_err(),
        "deposit must fail without `from`'s authorization"
    );
}

/// `withdraw` must require `owner`'s authorization.
#[test]
fn withdraw_without_signer_auth_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);

    const AMOUNT: i128 = 20_000_000;
    mint(&env, &token, &token_admin, &owner, AMOUNT);
    client.deposit(&owner, &AMOUNT);

    // Disable mocking: no more auths are considered valid from here on.
    env.set_auths(&[]);

    let result = client.try_withdraw(&owner, &AMOUNT);
    assert!(
        result.is_err(),
        "withdraw must fail without `owner`'s authorization"
    );
}

/// `locked_create` must require `owner`'s authorization.
#[test]
fn locked_create_without_signer_auth_rejected() {
    let env = Env::default();
    let (client, _admin, _token) = setup_with_token(&env);
    let owner = Address::generate(&env);

    let result = client.try_locked_create(&owner, &10_000_000i128, &1_000u64);

    assert!(
        result.is_err(),
        "locked_create must fail without `owner`'s authorization"
    );
}

/// `locked_top_up` must reject a caller who is not the plan's owner, even
/// though they validly authorized *themselves* (case 2).
#[test]
fn locked_top_up_by_non_owner_rejected_issue31() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    const AMOUNT: i128 = 30_000_000;
    mint(&env, &token, &token_admin, &owner, AMOUNT);
    mint(&env, &token, &token_admin, &attacker, AMOUNT);

    let plan_id = client.locked_create(&owner, &AMOUNT, &1_000_000u64);

    let result = client.try_locked_top_up(&attacker, &plan_id, &AMOUNT);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "attacker must not top-up another user's locked plan",
    );

    let plan = client.locked_plan(&plan_id);
    assert_eq!(plan.balance, AMOUNT, "plan balance must be untouched");
}

/// `locked_withdraw` must reject a caller who is not the plan's owner.
#[test]
fn locked_withdraw_by_non_owner_rejected_issue31() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    const AMOUNT: i128 = 40_000_000;
    mint(&env, &token, &token_admin, &owner, AMOUNT);

    // `min_persistent_entry_ttl` set well above the sequence-number jump
    // below (100 -> 200) so the `LockedPlan` entry is not archived before
    // the withdrawal attempt — this test is about the ownership check, not
    // persistent-entry TTL behavior.
    let now: u64 = 1_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: now,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 3_110_400,
        max_entry_ttl: 3_110_400,
    });
    let unlock_at = now + 500;
    let plan_id = client.locked_create(&owner, &AMOUNT, &unlock_at);

    env.ledger().set(LedgerInfo {
        timestamp: unlock_at + 1,
        protocol_version: 22,
        sequence_number: 200,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 3_110_400,
        max_entry_ttl: 3_110_400,
    });

    let result = client.try_locked_withdraw(&attacker, &plan_id, &AMOUNT);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "attacker must not withdraw from another user's locked plan",
    );

    let plan = client.locked_plan(&plan_id);
    assert_eq!(plan.balance, AMOUNT, "plan balance must be untouched");
}

/// `group_payout_equal` was missing `require_auth` on `caller` entirely —
/// anyone could relay the call unauthenticated. It is intentionally
/// permissionless (payouts go to members, not to `caller`), but every
/// invocation must still be attributable to a real signer.
#[test]
fn group_payout_equal_without_signer_auth_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let creator = Address::generate(&env);

    const AMOUNT: i128 = 10_000_000;
    mint(&env, &token, &token_admin, &creator, AMOUNT);

    let group_id = client.group_create(&creator, &String::from_str(&env, "payout-auth"));
    client.group_contribute(&creator, &group_id, &AMOUNT);
    client.group_close(&creator, &group_id);

    // Disable mocking: `caller.require_auth()` now has nothing to match.
    env.set_auths(&[]);

    let result = client.try_group_payout_equal(&creator, &group_id);
    assert!(
        result.is_err(),
        "group_payout_equal must fail without a signed caller",
    );
}

/// `set_admin` must require the *current* admin's authorization.
#[test]
fn set_admin_without_admin_auth_rejected() {
    let env = Env::default();
    let (client, _admin, _token) = setup_with_token(&env);
    let new_admin = Address::generate(&env);

    let result = client.try_set_admin(&new_admin);

    assert!(
        result.is_err(),
        "set_admin must fail without the current admin's authorization"
    );
}

/// `set_deposit_cap` must require the current admin's authorization.
#[test]
fn set_deposit_cap_without_admin_auth_rejected() {
    let env = Env::default();
    let (client, _admin, _token) = setup_with_token(&env);

    let result = client.try_set_deposit_cap(&100_000_000i128);

    assert!(
        result.is_err(),
        "set_deposit_cap must fail without the admin's authorization"
    );
}

// ---------------------------------------------------------------------------
// Issue #32 — Overflow-safe i128 arithmetic audit
// ---------------------------------------------------------------------------

/// Depositing into an account already at `i128::MAX` must return a typed
/// `Overflow` error instead of panicking or wrapping, and must leave the
/// balance untouched.
#[test]
fn deposit_overflow_rejected_with_typed_error() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    mint(&env, &token, &token_admin, &user, i128::MAX);
    client.deposit(&user, &i128::MAX);

    mint(&env, &token, &token_admin, &user, 1);
    let result = client.try_deposit(&user, &1);

    assert_eq!(
        result,
        Err(Ok(Error::Overflow)),
        "depositing past i128::MAX must return a typed Overflow error",
    );

    let account = client.get_account(&user);
    assert_eq!(
        account.balance,
        i128::MAX,
        "balance must be unchanged after a rejected overflowing deposit",
    );
}

/// `group_split::settle` must reject a per-member share computation that
/// would overflow `i128` with a typed error, rather than panicking, and
/// must leave the pool balance untouched (settlement did not proceed).
#[test]
fn group_split_settle_overflow_rejected_with_typed_error() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let member = Address::generate(&env);

    // Large enough that `balance * 5_000` overflows i128.
    const HALF: i128 = i128::MAX / 2;

    mint(&env, &token, &token_admin, &creator, HALF);
    mint(&env, &token, &token_admin, &member, HALF);

    let group_id = client.group_create(&creator, &String::from_str(&env, "overflow-pool"));
    client.group_join(&member, &group_id);
    client.group_contribute(&creator, &group_id, &HALF);
    client.group_contribute(&member, &group_id, &HALF);
    client.group_close(&creator, &group_id);

    let mut shares = Map::new(&env);
    shares.set(creator.clone(), 5_000u32);
    shares.set(member.clone(), 5_000u32);
    client.group_set_shares(&creator, &group_id, &shares);

    let result = client.try_group_settle(&creator, &group_id);
    assert_eq!(
        result,
        Err(Ok(Error::Overflow)),
        "settling a pool whose balance*bps overflows i128 must return a typed error",
    );

    let group = client.group(&group_id);
    assert_eq!(
        group.balance,
        HALF + HALF,
        "pool must be untouched after a rejected overflowing settle",
    );
}

// ---------------------------------------------------------------------------
// Issue #48 — Per-account deposit cap policy
// ---------------------------------------------------------------------------

/// With no cap ever configured (defaults to `0`), deposits of any size
/// succeed.
#[test]
fn deposit_cap_defaults_to_unlimited() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    const LARGE: i128 = 1_000_000_000_000;
    mint(&env, &token, &token_admin, &user, LARGE);
    client.deposit(&user, &LARGE);

    let account = client.get_account(&user);
    assert_eq!(account.balance, LARGE);
}

/// A deposit that lands exactly on the configured cap succeeds.
#[test]
fn deposit_at_cap_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    const CAP: i128 = 100_000_000;
    client.set_deposit_cap(&CAP);

    mint(&env, &token, &token_admin, &user, CAP);
    client.deposit(&user, &CAP);

    let account = client.get_account(&user);
    assert_eq!(account.balance, CAP);
}

/// A deposit that would push the balance past the configured cap is
/// rejected, and the balance is left unchanged.
#[test]
fn deposit_beyond_cap_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    const CAP: i128 = 100_000_000;
    client.set_deposit_cap(&CAP);

    mint(&env, &token, &token_admin, &user, CAP + 1);
    client.deposit(&user, &CAP);

    let result = client.try_deposit(&user, &1);
    assert_eq!(
        result,
        Err(Ok(Error::DepositCapExceeded)),
        "deposit pushing balance past the cap must be rejected",
    );

    let account = client.get_account(&user);
    assert_eq!(account.balance, CAP, "balance must not change on a rejected deposit");
}

/// Raising the cap takes effect immediately: a deposit that was rejected
/// under the old (lower) cap succeeds once the admin raises it, without
/// needing to re-deploy or wait.
#[test]
fn deposit_cap_change_takes_effect_immediately() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    const CAP_LOW: i128 = 10_000_000;
    const CAP_HIGH: i128 = 50_000_000;
    const AMOUNT: i128 = CAP_LOW + 1;

    client.set_deposit_cap(&CAP_LOW);
    mint(&env, &token, &token_admin, &user, AMOUNT);

    let result = client.try_deposit(&user, &AMOUNT);
    assert_eq!(result, Err(Ok(Error::DepositCapExceeded)));

    client.set_deposit_cap(&CAP_HIGH);

    client.deposit(&user, &AMOUNT);
    let account = client.get_account(&user);
    assert_eq!(account.balance, AMOUNT);
}

/// A negative cap is rejected as an invalid amount.
#[test]
fn set_deposit_cap_rejects_negative() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);

    let result = client.try_set_deposit_cap(&-1i128);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

// ---------------------------------------------------------------------------
// goal::get_goal
// ---------------------------------------------------------------------------

/// `goal()` returns the goal as created, and errors `NotFound` for an id
/// that was never created.
#[test]
fn get_goal_returns_created_goal_and_not_found_for_unknown_id() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let owner = Address::generate(&env);

    const TARGET: i128 = 100_000_000;
    const CONTRIBUTION: i128 = 40_000_000;

    mint(&env, &token, &token_admin, &owner, CONTRIBUTION);

    let goal_id = client.goal_create(&owner, &String::from_str(&env, "holiday"), &TARGET);
    client.goal_contribute(&owner, &goal_id, &CONTRIBUTION);

    let goal = client.goal(&goal_id);
    assert_eq!(goal.id, goal_id);
    assert_eq!(goal.owner, owner);
    assert_eq!(goal.target_amount, TARGET);
    assert_eq!(goal.saved_amount, CONTRIBUTION);
    assert!(goal.reached_at.is_none());

    let result = client.try_goal(&(goal_id + 1));
    assert!(
        matches!(result, Err(Ok(Error::NotFound))),
        "expected Err(Ok(Error::NotFound)) for an unknown goal id"
    );
}

// ---------------------------------------------------------------------------
// group_split::set_shares
// ---------------------------------------------------------------------------

/// Shares whose bps values don't sum to `TOTAL_BPS` are rejected, and the
/// group's stored shares are left untouched.
#[test]
fn group_set_shares_rejects_invalid_sum() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let creator = Address::generate(&env);
    let member_b = Address::generate(&env);

    let group_id = client.group_create(&creator, &String::from_str(&env, "split-pool"));
    client.group_join(&member_b, &group_id);
    client.group_close(&creator, &group_id);

    let mut shares = Map::new(&env);
    shares.set(creator.clone(), 5_000u32);
    shares.set(member_b.clone(), 4_000u32); // 5_000 + 4_000 = 9_000 != TOTAL_BPS

    let result = client.try_group_set_shares(&creator, &group_id, &shares);
    assert_eq!(result, Err(Ok(Error::InvalidShares)));
}

/// A shares map naming an address that never joined the group is rejected,
/// even if the bps values would otherwise sum correctly.
#[test]
fn group_set_shares_rejects_non_member_key() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let creator = Address::generate(&env);
    let member_b = Address::generate(&env);
    let outsider = Address::generate(&env);

    let group_id = client.group_create(&creator, &String::from_str(&env, "split-pool"));
    client.group_join(&member_b, &group_id);
    client.group_close(&creator, &group_id);

    let mut shares = Map::new(&env);
    shares.set(creator.clone(), 5_000u32);
    shares.set(outsider.clone(), 5_000u32); // outsider never joined

    let result = client.try_group_set_shares(&creator, &group_id, &shares);
    assert_eq!(result, Err(Ok(Error::InvalidShares)));
}

/// Valid shares that sum to exactly `TOTAL_BPS` and name only group members
/// are stored and emit a `group_shares_set` event.
#[test]
fn group_set_shares_stores_valid_shares() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let creator = Address::generate(&env);
    let member_b = Address::generate(&env);

    let group_id = client.group_create(&creator, &String::from_str(&env, "split-pool"));
    client.group_join(&member_b, &group_id);
    client.group_close(&creator, &group_id);

    let mut shares = Map::new(&env);
    shares.set(creator.clone(), 6_000u32);
    shares.set(member_b.clone(), 4_000u32);

    client.group_set_shares(&creator, &group_id, &shares);
    let event_count = env.events().all().len();
    assert_eq!(
        event_count, 1,
        "set_shares emits exactly one group_shares_set event"
    );

    let group = client.group(&group_id);
    assert_eq!(group.shares_bps.get(creator.clone()), Some(6_000u32));
    assert_eq!(group.shares_bps.get(member_b.clone()), Some(4_000u32));
}

// ---------------------------------------------------------------------------
// flexible::deposit / flexible::withdraw events
// ---------------------------------------------------------------------------

/// `deposit` emits a `deposit` event with the (from, amount, new_balance,
/// timestamp) data tuple described in the events registry.
#[test]
fn deposit_emits_typed_event_with_expected_topic_and_data() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    const AMOUNT: i128 = 25_000_000;

    mint(&env, &token, &token_admin, &user, AMOUNT);

    client.deposit(&user, &AMOUNT);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();

    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (TOPIC_DEPOSIT, user.clone()).into_val(&env);
    let decoded_data: (Address, i128, i128, u64) =
        soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded_data, (user, AMOUNT, AMOUNT, now));
}

/// `withdraw` emits a `withdraw` event with the (owner, amount,
/// new_balance, timestamp) data tuple described in the events registry.
#[test]
fn withdraw_emits_typed_event_with_expected_topic_and_data() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, token) = setup_with_token(&env);
    let token_admin = Address::generate(&env);
    let user = Address::generate(&env);

    const DEPOSIT_AMOUNT: i128 = 25_000_000;
    const WITHDRAW_AMOUNT: i128 = 10_000_000;

    mint(&env, &token, &token_admin, &user, DEPOSIT_AMOUNT);
    client.deposit(&user, &DEPOSIT_AMOUNT);

    client.withdraw(&user, &WITHDRAW_AMOUNT);

    let now = env.ledger().timestamp();
    let events = env.events().all();
    let (contract_id, topics, data) = events.last().unwrap().clone();
    let remaining_balance = DEPOSIT_AMOUNT - WITHDRAW_AMOUNT;

    let expected_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (TOPIC_WITHDRAW, user.clone()).into_val(&env);
    let decoded_data: (Address, i128, i128, u64) =
        soroban_sdk::TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(contract_id, client.address);
    assert_eq!(topics, expected_topics);
    assert_eq!(decoded_data, (user, WITHDRAW_AMOUNT, remaining_balance, now));
}

// ---------------------------------------------------------------------------
// Issue #47 — Emergency pause (admin)
//
// An admin-only `set_paused(bool)` toggles a flag that rejects mutating
// entrypoints with `Error::Paused` while paused. Reads remain available
// while paused, and the admin can unpause to resume normal operation.
// ---------------------------------------------------------------------------

/// While paused, a mutating entrypoint (`group_create`) is rejected with
/// `Error::Paused`; reads (`admin`, `is_paused`) keep working; and after the
/// admin unpauses, the same mutating call succeeds.
#[test]
fn paused_blocks_writes_and_admin_can_unpause() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _token) = setup_with_token(&env);
    let creator = Address::generate(&env);

    client.set_paused(&admin, &true);
    assert!(client.is_paused(), "vault must report paused after set_paused(true)");

    let result = client.try_group_create(&creator, &soroban_sdk::String::from_str(&env, "pool"));
    assert_eq!(
        result,
        Err(Ok(Error::Paused)),
        "mutating entrypoints must be rejected with Paused while paused",
    );

    // Reads remain available while paused.
    assert_eq!(client.admin(), admin);

    client.set_paused(&admin, &false);
    assert!(!client.is_paused(), "vault must report unpaused after set_paused(false)");

    let group_id = client.group_create(&creator, &soroban_sdk::String::from_str(&env, "pool"));
    let group = client.group(&group_id);
    assert_eq!(group.creator, creator, "group_create must succeed once unpaused");
}

/// Only the admin may pause/unpause the vault.
#[test]
fn set_paused_by_non_admin_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let attacker = Address::generate(&env);

    let result = client.try_set_paused(&attacker, &true);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "non-admin must not be able to pause the vault",
    );
    assert!(!client.is_paused(), "vault must remain unpaused after a rejected pause attempt");
}

// ---------------------------------------------------------------------------
// Issue #30 — Audit and extend error codes
//
// Every documented Error variant must be reachable and asserted at least
// once. The tests above already cover AlreadyInitialized,
// DepositCapExceeded, InsufficientBalance, InvalidAmount, InvalidShares,
// NotAMember, NotFound, Overflow, Paused, StillLocked, and Unauthorized.
// The four tests below cover the remaining variants: NotInitialized,
// InvalidUnlockTime, GoalNotReached, and GroupClosed.
// ---------------------------------------------------------------------------

/// Every entrypoint that touches the configured token must reject with
/// `NotInitialized` before `initialize` has ever been called.
#[test]
fn uninitialized_vault_rejects_with_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();

    let client = setup(&env);
    let owner = Address::generate(&env);

    let deposit_result = client.try_deposit(&owner, &1_000_000);
    assert_eq!(
        deposit_result,
        Err(Ok(Error::NotInitialized)),
        "deposit on an uninitialized vault must fail with NotInitialized",
    );

    let locked_result = client.try_locked_create(&owner, &1_000_000, &1);
    assert_eq!(
        locked_result,
        Err(Ok(Error::NotInitialized)),
        "locked_create on an uninitialized vault must fail with NotInitialized",
    );
}

/// `locked_create` must reject an `unlock_at` that is not strictly in the
/// future (at or before the current ledger timestamp).
#[test]
fn locked_create_rejects_unlock_at_not_in_future() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let owner = Address::generate(&env);

    let now = env.ledger().timestamp();

    let at_now = client.try_locked_create(&owner, &1_000_000, &now);
    assert_eq!(
        at_now,
        Err(Ok(Error::InvalidUnlockTime)),
        "unlock_at == now must be rejected as not strictly in the future",
    );

    if now > 0 {
        let in_past = client.try_locked_create(&owner, &1_000_000, &(now - 1));
        assert_eq!(
            in_past,
            Err(Ok(Error::InvalidUnlockTime)),
            "unlock_at in the past must be rejected",
        );
    }
}

/// `goal_claim` must reject with `GoalNotReached` while the goal's
/// `saved_amount` is still below its `target_amount`.
#[test]
fn goal_claim_before_target_reached_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let owner = Address::generate(&env);
    let name = soroban_sdk::String::from_str(&env, "unreached goal");

    let goal_id = client.goal_create(&owner, &name, &1_000_000_000);

    let result = client.try_goal_claim(&owner, &goal_id);
    assert_eq!(
        result,
        Err(Ok(Error::GoalNotReached)),
        "claiming a goal before its target is reached must fail with GoalNotReached",
    );
}

/// `group_join` must reject with `GroupClosed` once the group's creator
/// has closed it.
#[test]
fn group_join_after_close_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin, _token) = setup_with_token(&env);
    let creator = Address::generate(&env);
    let latecomer = Address::generate(&env);
    let name = soroban_sdk::String::from_str(&env, "closed pool");

    let group_id = client.group_create(&creator, &name);
    client.group_close(&creator, &group_id);

    let result = client.try_group_join(&latecomer, &group_id);
    assert_eq!(
        result,
        Err(Ok(Error::GroupClosed)),
        "joining a closed group must fail with GroupClosed",
    );
}

// ---------------------------------------------------------------------------
// Issue #41 — Property test: split rounding sums to pool
//
// Weighted settlement must never create or destroy funds via rounding: for
// any valid share configuration (bps values summing to `TOTAL_BPS`) and any
// pool balance, the computed per-member payouts must sum to exactly the
// pool, and every individual payout must be non-negative.
// ---------------------------------------------------------------------------

mod group_split_properties {
    use crate::group_split::{compute_payouts, TOTAL_BPS};
    use proptest::prelude::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, Map};

    /// Build a valid `shares_bps` map from arbitrary positive `weights`:
    /// each member's bps is proportional to its weight, and the last
    /// member absorbs whatever rounding remainder is needed so the shares
    /// sum to exactly `TOTAL_BPS` (a precondition `set_shares` enforces
    /// on-chain).
    fn shares_from_weights(env: &Env, weights: &[u32]) -> (soroban_sdk::Vec<Address>, Map<Address, u32>) {
        let mut addrs: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(env);
        for _ in weights {
            addrs.push_back(Address::generate(env));
        }

        let total_weight: u64 = weights.iter().map(|w| *w as u64).sum();
        let mut shares: Map<Address, u32> = Map::new(env);
        let mut distributed: u32 = 0;

        for (i, w) in weights.iter().enumerate() {
            let member = addrs.get(i as u32).unwrap();
            let bps = if i + 1 == weights.len() {
                TOTAL_BPS - distributed
            } else {
                let bps = ((*w as u64) * (TOTAL_BPS as u64) / total_weight) as u32;
                distributed += bps;
                bps
            };
            shares.set(member, bps);
        }

        (addrs, shares)
    }

    proptest! {
        /// For any valid shares configuration and any non-negative pool
        /// balance, settlement conserves the pool exactly: the sum of
        /// computed payouts equals the pool, and no payout is negative.
        #[test]
        fn split_rounding_sums_to_pool(
            weights in proptest::collection::vec(1u32..=1_000u32, 1..=8),
            pool in 0i128..=1_000_000_000_000_000i128,
        ) {
            let env = Env::default();
            let (addrs, shares) = shares_from_weights(&env, &weights);
            let remainder_recipient = addrs.get(0).unwrap();

            let payouts = compute_payouts(&env, &shares, pool, &remainder_recipient);

            let mut sum: i128 = 0;
            for (_member, amount) in payouts.iter() {
                prop_assert!(amount >= 0, "every payout must be non-negative, got {}", amount);
                sum += amount;
            }

            prop_assert_eq!(sum, pool, "sum of payouts must equal the pool exactly");
        }
    }
}
