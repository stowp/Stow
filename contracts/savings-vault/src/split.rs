//! Savings-vault splitting for joint (group) accounts (#629).
//!
//! Allows the co-owners of a closed group vault to split its balance back into
//! individual [`FlexibleAccount`]s, proportional to each member's cumulative
//! contribution.
//!
//! # Lifecycle
//!
//! 1. **`request_split`** — any group member initiates the split. A
//!    [`SplitRequest`] is created with every member's approval pre-set to
//!    `false` and the requester's entry auto-approved to `true`. Only one
//!    pending (un-executed) request is allowed per group at a time.
//!
//! 2. **`approve_split`** — each remaining co-owner calls this once to record
//!    their consent. Duplicate approvals are rejected.
//!
//! 3. **`execute_split`** — permissionless once all co-owners have approved.
//!    Computes each member's proportional share of the pool based on
//!    their recorded contribution totals, credits each member's
//!    `FlexibleAccount` (creating it if absent), zeroes the group balance,
//!    and emits a `vault_split` event per member. The request is marked
//!    executed so it cannot be run twice.
//!
//! # Balance calculation
//!
//! For each member `m`:
//!
//! ```text
//! share_m = pool_balance * contribution_m / total_contributions   (floor)
//! ```
//!
//! Rounding dust (always `< n_members` stroops) is assigned to the first
//! member in `group.members` (the creator), matching the existing convention
//! in [`crate::group_split`].
//!
//! If total contributions are zero (the group was created but never funded),
//! the split is rejected with `InvalidAmount` to avoid a divide-by-zero.
//!
//! # New vaults
//!
//! Because funds are already held by this contract, no cross-contract token
//! transfer is needed: the split simply credits each member's
//! `FlexibleAccount` balance in persistent storage. Members can then use
//! the standard `withdraw` entrypoint to move their funds.

use soroban_sdk::{Address, Env, Map};

use crate::admin::require_not_paused;
use crate::error::Error;
use crate::events::{TOPIC_VAULT_SPLIT, TOPIC_VAULT_SPLIT_APPROVED, TOPIC_VAULT_SPLIT_REQUESTED};
use crate::limits;
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, FlexibleAccount, Group, SplitRequest};

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

/// Initiate a split of the joint vault identified by `group_id`.
///
/// The group must be **closed** (new members no longer accepted) before a
/// split can be requested, so the membership set is frozen and every member
/// can be pre-recorded in the approval map.
///
/// Returns the new split-request id.
///
/// ## Errors
///
/// - `NotFound`              — `group_id` does not exist.
/// - `NotAMember`            — `requester` is not a member of the group.
/// - `GroupClosed`           — the group is still open; call `group_close` first.
/// - `SplitAlreadyRequested` — a pending (un-executed) split already exists for
///                             this group.
/// - `Paused`                — the vault is admin-paused.
pub fn request_split(env: &Env, requester: Address, group_id: u64) -> Result<u64, Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    requester.require_auth();

    // Load the group.
    let gkey = DataKey::Group(group_id);
    let group: Group = env
        .storage()
        .persistent()
        .get(&gkey)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &gkey);

    // The group must be closed so membership is frozen.
    if group.open {
        return Err(Error::GroupClosed);
    }

    // Requester must be a member.
    if !group.members.iter().any(|m| m == requester) {
        return Err(Error::NotAMember);
    }

    // Only one pending split per group at a time.
    let active_key = DataKey::GroupActiveSplit(group_id);
    if env
        .storage()
        .persistent()
        .get::<_, u64>(&active_key)
        .is_some()
    {
        return Err(Error::SplitAlreadyRequested);
    }

    // Build the approval map: every member starts as `false`; requester is
    // immediately `true` (they implicitly approve their own request).
    let mut approvals: Map<Address, bool> = Map::new(env);
    for member in group.members.iter() {
        approvals.set(member.clone(), member == requester);
    }

    let now = env.ledger().timestamp();
    let id = storage::next_id(env, DataKey::NextSplitId);

    let request = SplitRequest {
        id,
        group_id,
        requester: requester.clone(),
        approvals,
        created_at: now,
        executed: false,
    };

    // Persist the request and the group-to-id index.
    let rkey = DataKey::SplitRequest(id);
    env.storage().persistent().set(&rkey, &request);
    storage::extend_persistent_ttl(env, &rkey);

    env.storage().persistent().set(&active_key, &id);
    storage::extend_persistent_ttl(env, &active_key);

    env.events().publish(
        (TOPIC_VAULT_SPLIT_REQUESTED, requester.clone(), group_id),
        (id, group_id, requester, now),
    );

    Ok(id)
}

/// Record `approver`'s consent to split request `split_id`.
///
/// Once every co-owner has approved, `execute_split` becomes callable.
///
/// ## Errors
///
/// - `NotFound`           — `split_id` does not exist.
/// - `SplitNotPending`    — the request has already been executed.
/// - `NotAMember`         — `approver` is not a member of the referenced group.
/// - `SplitAlreadyApproved` — `approver` has already approved this request.
/// - `Paused`             — the vault is admin-paused.
pub fn approve_split(env: &Env, approver: Address, split_id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    approver.require_auth();

    let rkey = DataKey::SplitRequest(split_id);
    let mut request: SplitRequest = env
        .storage()
        .persistent()
        .get(&rkey)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &rkey);

    if request.executed {
        return Err(Error::SplitNotPending);
    }

    // Confirm the approver is in the approval map (i.e. a group member).
    // `approvals` is built from `group.members` at request time, so presence
    // in the map is equivalent to group membership.
    let already = request
        .approvals
        .get(approver.clone())
        .ok_or(Error::NotAMember)?;

    if already {
        return Err(Error::SplitAlreadyApproved);
    }

    request.approvals.set(approver.clone(), true);
    env.storage().persistent().set(&rkey, &request);
    storage::extend_persistent_ttl(env, &rkey);

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_VAULT_SPLIT_APPROVED, approver.clone(), split_id),
        (split_id, request.group_id, approver, now),
    );

    Ok(())
}

/// Execute a fully-approved split request.
///
/// Permissionless once all co-owners have approved — any signed `caller` may
/// trigger settlement; funds always go to the recorded members, never to
/// `caller`.
///
/// For each member `m`:
///
/// ```text
/// share_m = pool_balance * contribution_m / total_contributions   (floor)
/// ```
///
/// Rounding dust is added to the first member's share (the group creator,
/// `members[0]`). Each member's share is credited to their `FlexibleAccount`
/// (created if absent). The group pool is zeroed, the active-split index is
/// removed, and the request is marked executed.
///
/// ## Errors
///
/// - `NotFound`              — `split_id` does not exist.
/// - `SplitNotPending`       — the request has already been executed.
/// - `SplitNotFullyApproved` — at least one co-owner has not yet approved.
/// - `InvalidAmount`         — total contributions are zero (unfunded group).
/// - `Overflow`              — arithmetic overflow on a per-member computation.
/// - `Paused`                — the vault is admin-paused.
pub fn execute_split(env: &Env, caller: Address, split_id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    caller.require_auth();

    let rkey = DataKey::SplitRequest(split_id);
    let mut request: SplitRequest = env
        .storage()
        .persistent()
        .get(&rkey)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &rkey);

    if request.executed {
        return Err(Error::SplitNotPending);
    }

    // All co-owners must have approved.
    for (_member, approved) in request.approvals.iter() {
        if !approved {
            return Err(Error::SplitNotFullyApproved);
        }
    }

    // Load the group.
    let group_id = request.group_id;
    let gkey = DataKey::Group(group_id);
    let mut group: Group = env
        .storage()
        .persistent()
        .get(&gkey)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &gkey);

    let pool = group.balance;
    let now = env.ledger().timestamp();

    // --- Compute contribution totals --------------------------------------

    // Sum each member's recorded contribution.  `limits::member_total` reads
    // `DataKey::GroupContribution(group_id, member)` and returns `0` when
    // absent (member joined but never contributed).
    let mut total_contributions: i128 = 0;
    for member in group.members.iter() {
        let contrib = limits::member_total(env, group_id, &member);
        total_contributions = total_contributions
            .checked_add(contrib)
            .ok_or(Error::Overflow)?;
    }

    // Guard: a group with zero total contributions cannot be split by ratio.
    // (This also prevents divide-by-zero below.)
    if total_contributions == 0 {
        return Err(Error::InvalidAmount);
    }

    // --- First pass: compute floor shares ---------------------------------
    //
    // Iterate `group.members` (ordered Vec) so the remainder assignment is
    // deterministic regardless of map iteration order.
    let mut floor_shares: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(env);
    let mut distributed: i128 = 0;

    for member in group.members.iter() {
        let contrib = limits::member_total(env, group_id, &member);
        // pool * contrib / total_contributions — both checked to prevent silent
        // overflow on large balances.
        let raw = pool
            .checked_mul(contrib)
            .ok_or(Error::Overflow)?;
        let share = raw
            .checked_div(total_contributions)
            .ok_or(Error::Overflow)?;
        distributed = distributed.checked_add(share).ok_or(Error::Overflow)?;
        floor_shares.push_back(share);
    }

    // The remainder is in [0, n_members) stroops; assign to member[0]
    // (the group creator) to guarantee the pool drains to exactly 0.
    let remainder = pool.checked_sub(distributed).ok_or(Error::Overflow)?;

    // --- Second pass: credit FlexibleAccounts and emit events -------------
    for (index, member) in group.members.iter().enumerate() {
        let mut share = floor_shares.get(index as u32).unwrap_or(0);

        if index == 0 {
            share = share.checked_add(remainder).ok_or(Error::Overflow)?;
        }

        // Credit the member's FlexibleAccount (create if absent).
        // Note: no token transfer is needed — funds are already held by the
        // contract.  We adjust the on-chain balance directly.
        let fkey = DataKey::Flexible(member.clone());
        let existing: Option<FlexibleAccount> = env.storage().persistent().get(&fkey);
        if existing.is_some() {
            storage::extend_persistent_ttl(env, &fkey);
        }
        let mut account = existing.unwrap_or(FlexibleAccount {
            owner: member.clone(),
            balance: 0,
            created_at: now,
            updated_at: now,
        });

        account.balance = account.balance.checked_add(share).ok_or(Error::Overflow)?;
        account.updated_at = now;

        env.storage().persistent().set(&fkey, &account);
        storage::extend_persistent_ttl(env, &fkey);

        // Emit one vault_split event per new vault, even for a zero-share
        // member (possible if they joined but never contributed).
        env.events().publish(
            (TOPIC_VAULT_SPLIT, member.clone(), split_id),
            (split_id, group_id, member, share, now),
        );
    }

    // --- Finalise ---------------------------------------------------------

    // Zero the group pool.
    group.balance = 0;
    env.storage().persistent().set(&gkey, &group);
    storage::extend_persistent_ttl(env, &gkey);

    // Remove the active-split index so a new split could theoretically be
    // requested later (though the pool is now empty).
    let active_key = DataKey::GroupActiveSplit(group_id);
    env.storage().persistent().remove(&active_key);

    // Mark the request executed to prevent double-execution.
    request.executed = true;
    env.storage().persistent().set(&rkey, &request);
    storage::extend_persistent_ttl(env, &rkey);

    Ok(())
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/// Read a split request by id, or `NotFound`.
pub fn get_split_request(env: &Env, split_id: u64) -> Result<SplitRequest, Error> {
    let key = DataKey::SplitRequest(split_id);
    let request = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(request)
}

/// Return the active (un-executed) split-request id for `group_id`, if any.
pub fn active_split_id(env: &Env, group_id: u64) -> Option<u64> {
    let key = DataKey::GroupActiveSplit(group_id);
    env.storage().persistent().get(&key)
}
