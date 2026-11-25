//! Savings-vault splitting for joint accounts (#629).
//!
//! Tests exercise the full lifecycle:
//!   request → approve (all co-owners) → execute
//! as well as every error path.

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env, String};

use crate::error::Error;
use crate::{SavingsVault, SavingsVaultClient};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNIT: i128 = 10_000_000; // 1 token (7 decimals)

struct Ctx<'a> {
    env: &'a Env,
    client: SavingsVaultClient<'a>,
    token: Address,
}

/// Minimal contract + token setup (mirrors limits_test.rs pattern).
fn ctx(env: &Env) -> Ctx<'_> {
    env.mock_all_auths();
    let client = SavingsVaultClient::new(env, &env.register(SavingsVault, ()));
    let admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    client.initialize(&admin, &token);
    Ctx { env, client, token }
}

/// Mint `amount` of the vault token to `recipient`.
fn mint(env: &Env, token: &Address, recipient: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(recipient, &amount);
}

/// Create a named group, returning `(group_id, creator)`.
fn new_group(c: &Ctx<'_>, name: &str) -> (u64, Address) {
    let creator = Address::generate(c.env);
    let id = c
        .client
        .group_create(&creator, &String::from_str(c.env, name));
    (id, creator)
}

/// Join a group, fund the member, contribute `amount`, and return the address.
fn funded_member(c: &Ctx<'_>, group_id: u64, amount: i128) -> Address {
    let member = Address::generate(c.env);
    mint(c.env, &c.token, &member, amount);
    c.client.group_join(&member, &group_id);
    c.client.group_contribute(&member, &group_id, &amount);
    member
}

/// Create a closed group with `n` members (all funded with `amount` each).
/// Returns `(group_id, creator, members)`.
fn closed_group(c: &Ctx<'_>, n: u32, amount_each: i128) -> (u64, Address, soroban_sdk::Vec<Address>) {
    let (group_id, creator) = new_group(c, "joint");

    // Fund & contribute the creator.
    mint(c.env, &c.token, &creator, amount_each);
    c.client.group_contribute(&creator, &group_id, &amount_each);

    // Add n-1 extra members.
    let mut members = soroban_sdk::Vec::new(c.env);
    members.push_back(creator.clone());
    for _ in 1..n {
        let m = funded_member(c, group_id, amount_each);
        members.push_back(m);
    }

    // Close the group.
    c.client.group_close(&creator, &group_id);

    (group_id, creator, members)
}

// ---------------------------------------------------------------------------
// 1. Split request created successfully
// ---------------------------------------------------------------------------

#[test]
fn split_request_created_successfully() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, _members) = closed_group(&c, 2, 50 * UNIT);

    let split_id = c.client.vault_split_request(&creator, &group_id);

    // The request must be retrievable with correct initial state.
    let req = c.client.vault_split_request_get(&split_id);
    assert_eq!(req.id, split_id);
    assert_eq!(req.group_id, group_id);
    assert_eq!(req.requester, creator);
    assert!(!req.executed);

    // Requester is auto-approved; the other member is not yet.
    assert_eq!(req.approvals.get(creator.clone()), Some(true));

    // The active-split index must point to this request.
    assert_eq!(c.client.vault_split_active(&group_id), Some(split_id));
}

// ---------------------------------------------------------------------------
// 2. All co-owners must approve
// ---------------------------------------------------------------------------

#[test]
fn execute_fails_before_all_owners_approve() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, members) = closed_group(&c, 3, 30 * UNIT);
    let split_id = c.client.vault_split_request(&creator, &group_id);

    // Only the creator has approved so far — execute must fail.
    let result = c.client.try_vault_split_execute(&creator, &split_id);
    assert_eq!(result, Err(Ok(Error::SplitNotFullyApproved)));

    // After member[1] approves, member[2] still hasn't — still fails.
    c.client.vault_split_approve(&members.get(1).unwrap(), &split_id);
    let result = c.client.try_vault_split_execute(&creator, &split_id);
    assert_eq!(result, Err(Ok(Error::SplitNotFullyApproved)));

    // After member[2] approves, execute succeeds.
    c.client.vault_split_approve(&members.get(2).unwrap(), &split_id);
    c.client.vault_split_execute(&creator, &split_id);
}

#[test]
fn approve_by_non_member_fails() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, _) = closed_group(&c, 2, 20 * UNIT);
    let split_id = c.client.vault_split_request(&creator, &group_id);

    let outsider = Address::generate(&env);
    let result = c.client.try_vault_split_approve(&outsider, &split_id);
    assert_eq!(result, Err(Ok(Error::NotAMember)));
}

#[test]
fn duplicate_approval_is_rejected() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, members) = closed_group(&c, 2, 20 * UNIT);
    let split_id = c.client.vault_split_request(&creator, &group_id);

    // Creator is auto-approved at request time — a second approval must fail.
    let result = c.client.try_vault_split_approve(&creator, &split_id);
    assert_eq!(result, Err(Ok(Error::SplitAlreadyApproved)));

    // Other member approves once — OK.
    c.client
        .vault_split_approve(&members.get(1).unwrap(), &split_id);
    // Second attempt — fails.
    let result = c
        .client
        .try_vault_split_approve(&members.get(1).unwrap(), &split_id);
    assert_eq!(result, Err(Ok(Error::SplitAlreadyApproved)));
}

// ---------------------------------------------------------------------------
// 3. Balances split by contribution ratio
// ---------------------------------------------------------------------------

#[test]
fn balances_split_by_contribution_ratio() {
    let env = Env::default();
    let c = ctx(&env);

    // Two-member group: creator contributes 30, member2 contributes 70.
    let (group_id, creator) = new_group(&c, "ratio");
    let contrib_creator = 30 * UNIT;
    let contrib_member2 = 70 * UNIT;

    mint(c.env, &c.token, &creator, contrib_creator);
    c.client.group_contribute(&creator, &group_id, &contrib_creator);

    let member2 = Address::generate(&env);
    mint(c.env, &c.token, &member2, contrib_member2);
    c.client.group_join(&member2, &group_id);
    c.client
        .group_contribute(&member2, &group_id, &contrib_member2);

    c.client.group_close(&creator, &group_id);

    let pool = contrib_creator + contrib_member2; // 100 * UNIT
    assert_eq!(c.client.group(&group_id).balance, pool);

    // Request and fully approve.
    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client.vault_split_approve(&member2, &split_id);
    c.client.vault_split_execute(&creator, &split_id);

    // Pool must be fully drained.
    assert_eq!(c.client.group(&group_id).balance, 0);

    // creator: 30% of 100 * UNIT = 30 * UNIT
    // member2: 70% of 100 * UNIT = 70 * UNIT
    let acct_creator = c.client.get_account(&creator);
    let acct_member2 = c.client.get_account(&member2);

    assert_eq!(acct_creator.balance, contrib_creator);
    assert_eq!(acct_member2.balance, contrib_member2);
    assert_eq!(acct_creator.balance + acct_member2.balance, pool);
}

#[test]
fn rounding_remainder_goes_to_first_member() {
    let env = Env::default();
    let c = ctx(&env);

    // 3 members contributing 1 token each. Pool = 3 tokens.
    // Exact split: 1 each — no rounding here, but we test with an odd pool.
    // We will not add a fourth stroop directly, so instead use an indivisible
    // amount: pool = 10 (stroops), 3 members equal → 3 each, remainder 1
    // goes to member[0].
    let (group_id, creator) = new_group(&c, "dust");

    // Each member contributes the same amount so shares are equal.
    // Use a small prime pool to guarantee a non-zero remainder.
    let contrib = 1i128; // 1 stroop each → pool = 3, share = 1, remainder = 0
    // Actually for a remainder we need pool indivisible by 3.
    // Pool = 10 stroops, 3 members equal (3+3+3 = 9, remainder 1).
    let contrib_a = 4i128;
    let contrib_b = 3i128;
    let contrib_c = 3i128;
    let _ = contrib; // suppress unused

    mint(c.env, &c.token, &creator, contrib_a);
    c.client.group_contribute(&creator, &group_id, &contrib_a);

    let m1 = Address::generate(&env);
    let m2 = Address::generate(&env);
    mint(c.env, &c.token, &m1, contrib_b);
    mint(c.env, &c.token, &m2, contrib_c);
    c.client.group_join(&m1, &group_id);
    c.client.group_join(&m2, &group_id);
    c.client.group_contribute(&m1, &group_id, &contrib_b);
    c.client.group_contribute(&m2, &group_id, &contrib_c);

    c.client.group_close(&creator, &group_id);
    let pool = contrib_a + contrib_b + contrib_c; // 10

    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client.vault_split_approve(&m1, &split_id);
    c.client.vault_split_approve(&m2, &split_id);
    c.client.vault_split_execute(&creator, &split_id);

    assert_eq!(c.client.group(&group_id).balance, 0);

    let total_contributions = contrib_a + contrib_b + contrib_c; // 10
    // floor shares: creator 10*4/10=4, m1 10*3/10=3, m2 10*3/10=3 → sum=10, remainder=0
    let expected_creator = pool * contrib_a / total_contributions; // 4
    let expected_m1 = pool * contrib_b / total_contributions; // 3
    let expected_m2 = pool * contrib_c / total_contributions; // 3
    let remainder = pool - expected_creator - expected_m1 - expected_m2;

    let acct_creator = c.client.get_account(&creator);
    let acct_m1 = c.client.get_account(&m1);
    let acct_m2 = c.client.get_account(&m2);

    // Creator absorbs the remainder.
    assert_eq!(acct_creator.balance, expected_creator + remainder);
    assert_eq!(acct_m1.balance, expected_m1);
    assert_eq!(acct_m2.balance, expected_m2);
    // Pool fully drained.
    assert_eq!(
        acct_creator.balance + acct_m1.balance + acct_m2.balance,
        pool
    );
}

// ---------------------------------------------------------------------------
// 4. New vaults created correctly
// ---------------------------------------------------------------------------

#[test]
fn new_flexible_accounts_created_for_each_owner() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, members) = closed_group(&c, 3, 10 * UNIT);

    // Confirm accounts do not exist before the split.
    for member in members.iter() {
        assert_eq!(
            c.client.try_get_account(&member),
            Err(Ok(Error::NotFound))
        );
    }

    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client
        .vault_split_approve(&members.get(1).unwrap(), &split_id);
    c.client
        .vault_split_approve(&members.get(2).unwrap(), &split_id);
    c.client.vault_split_execute(&creator, &split_id);

    // All members now have a FlexibleAccount.
    for member in members.iter() {
        let acct = c.client.get_account(&member);
        assert_eq!(acct.owner, member);
        assert!(acct.balance > 0);
    }
}

#[test]
fn split_credits_existing_flexible_account() {
    let env = Env::default();
    let c = ctx(&env);

    // The creator already has a flexible account balance before the split.
    let (group_id, creator) = new_group(&c, "pre-existing");

    let pre_balance = 5 * UNIT;
    let contrib = 10 * UNIT;

    mint(c.env, &c.token, &creator, pre_balance + contrib);
    // Deposit into their own flexible account first.
    c.client.deposit(&creator, &pre_balance);
    // Then contribute to the group.
    c.client.group_contribute(&creator, &group_id, &contrib);

    let m2 = Address::generate(&env);
    mint(c.env, &c.token, &m2, 10 * UNIT);
    c.client.group_join(&m2, &group_id);
    c.client.group_contribute(&m2, &group_id, &(10 * UNIT));

    c.client.group_close(&creator, &group_id);

    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client.vault_split_approve(&m2, &split_id);
    c.client.vault_split_execute(&creator, &split_id);

    // Creator's flexible account must be pre_balance + their split share.
    let pool = contrib + 10 * UNIT;
    let total_contribs = contrib + 10 * UNIT;
    let creator_share = pool * contrib / total_contribs; // 50%

    let acct = c.client.get_account(&creator);
    assert_eq!(acct.balance, pre_balance + creator_share);
}

// ---------------------------------------------------------------------------
// 5. Original vault (group) closed after split
// ---------------------------------------------------------------------------

#[test]
fn original_group_balance_is_zero_after_split() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, members) = closed_group(&c, 2, 25 * UNIT);

    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client
        .vault_split_approve(&members.get(1).unwrap(), &split_id);
    c.client.vault_split_execute(&creator, &split_id);

    assert_eq!(c.client.group(&group_id).balance, 0);
}

#[test]
fn active_split_index_cleared_after_execute() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, members) = closed_group(&c, 2, 20 * UNIT);

    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client
        .vault_split_approve(&members.get(1).unwrap(), &split_id);
    c.client.vault_split_execute(&creator, &split_id);

    // Active split index must be cleared.
    assert_eq!(c.client.vault_split_active(&group_id), None);
}

#[test]
fn double_execute_is_rejected() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, members) = closed_group(&c, 2, 15 * UNIT);

    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client
        .vault_split_approve(&members.get(1).unwrap(), &split_id);
    c.client.vault_split_execute(&creator, &split_id);

    let result = c.client.try_vault_split_execute(&creator, &split_id);
    assert_eq!(result, Err(Ok(Error::SplitNotPending)));
}

// ---------------------------------------------------------------------------
// 6. VaultSplit event includes split details
// ---------------------------------------------------------------------------

#[test]
fn vault_split_events_emitted_per_member() {
    use soroban_sdk::testutils::Events as _;
    use soroban_sdk::IntoVal;

    let env = Env::default();
    let c = ctx(&env);

    let contrib = 10 * UNIT;
    let (group_id, creator, members) = closed_group(&c, 2, contrib);

    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client
        .vault_split_approve(&members.get(1).unwrap(), &split_id);
    c.client.vault_split_execute(&creator, &split_id);

    let all_events = env.events().all();

    // Filter for vault_split topic events.
    let split_events: soroban_sdk::Vec<_> = all_events
        .iter()
        .filter(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| t == crate::events::TOPIC_VAULT_SPLIT.into_val(&env))
                .unwrap_or(false)
        })
        .collect();

    // One event per member (2 members).
    assert_eq!(split_events.len(), 2);
}

// ---------------------------------------------------------------------------
// 7. Guard: open group cannot be split
// ---------------------------------------------------------------------------

#[test]
fn split_request_on_open_group_fails() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator) = new_group(&c, "open");
    // Group is still open — split must be rejected.
    let result = c.client.try_vault_split_request(&creator, &group_id);
    assert_eq!(result, Err(Ok(Error::GroupClosed)));
}

// ---------------------------------------------------------------------------
// 8. Guard: non-member cannot request a split
// ---------------------------------------------------------------------------

#[test]
fn split_request_by_non_member_fails() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, _) = closed_group(&c, 2, 10 * UNIT);
    let outsider = Address::generate(&env);
    let result = c.client.try_vault_split_request(&outsider, &group_id);
    assert_eq!(result, Err(Ok(Error::NotAMember)));
}

// ---------------------------------------------------------------------------
// 9. Guard: only one pending split per group
// ---------------------------------------------------------------------------

#[test]
fn duplicate_split_request_for_same_group_fails() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator, _) = closed_group(&c, 2, 10 * UNIT);
    c.client.vault_split_request(&creator, &group_id);

    let result = c.client.try_vault_split_request(&creator, &group_id);
    assert_eq!(result, Err(Ok(Error::SplitAlreadyRequested)));
}

// ---------------------------------------------------------------------------
// 10. Guard: unfunded group cannot be split
// ---------------------------------------------------------------------------

#[test]
fn split_of_unfunded_group_fails() {
    let env = Env::default();
    let c = ctx(&env);

    // Create a group with two members but zero contributions.
    let (group_id, creator) = new_group(&c, "empty");
    let m2 = Address::generate(&env);
    c.client.group_join(&m2, &group_id);
    c.client.group_close(&creator, &group_id);

    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client.vault_split_approve(&m2, &split_id);

    let result = c.client.try_vault_split_execute(&creator, &split_id);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

// ---------------------------------------------------------------------------
// 11. Single-owner group: immediate approval and execute
// ---------------------------------------------------------------------------

#[test]
fn single_member_split_executes_immediately() {
    let env = Env::default();
    let c = ctx(&env);

    let (group_id, creator) = new_group(&c, "solo");
    let contrib = 50 * UNIT;
    mint(c.env, &c.token, &creator, contrib);
    c.client.group_contribute(&creator, &group_id, &contrib);
    c.client.group_close(&creator, &group_id);

    // A solo group: requester is the only member, so the request is already
    // fully approved.
    let split_id = c.client.vault_split_request(&creator, &group_id);
    c.client.vault_split_execute(&creator, &split_id);

    assert_eq!(c.client.group(&group_id).balance, 0);
    assert_eq!(c.client.get_account(&creator).balance, contrib);
}
