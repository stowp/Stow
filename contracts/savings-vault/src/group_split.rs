//! Group-split savings — a shared pool settled back to members by agreed shares.
//!
//! Shares are expressed in basis points (bps) and must sum to 10_000.

use soroban_sdk::{Address, Env, Map, Vec};

use crate::admin::require_not_paused;
use crate::error::Error;
use crate::events::{TOPIC_GROUP_SHARES_SET, TOPIC_GROUP_SPLIT_SETTLED};
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, Group};

pub const TOTAL_BPS: u32 = 10_000;

/// Compute each member's payout for a `pool` split by `shares_bps`.
///
/// Each member's raw share is `pool * bps / TOTAL_BPS` (floor division). The
/// leftover from rounding down (always `>= 0`) is assigned entirely to
/// `remainder_recipient` so the sum of payouts always equals `pool` exactly.
pub fn compute_payouts(
    env: &Env,
    shares_bps: &Map<Address, u32>,
    pool: i128,
    remainder_recipient: &Address,
) -> Map<Address, i128> {
    let mut payouts: Map<Address, i128> = Map::new(env);
    let mut distributed: i128 = 0;

    for (member, bps) in shares_bps.iter() {
        let amount = pool * (bps as i128) / (TOTAL_BPS as i128);
        distributed += amount;
        payouts.set(member, amount);
    }

    let remainder = pool - distributed;
    if remainder != 0 {
        let current = payouts.get(remainder_recipient.clone()).unwrap_or(0);
        payouts.set(remainder_recipient.clone(), current + remainder);
    }

    payouts
}

/// Set the per-member split for a group. Creator-only; group must be closed.
///
/// `shares_bps` is a map from member address to basis points (1 bps = 0.01%).
/// The values must sum to exactly `TOTAL_BPS` (10 000) and every key must
/// already be a member of the group — extra keys are rejected with
/// `Error::InvalidShares`.
///
/// Errors:
/// - `NotFound`      — `group_id` does not exist.
/// - `Unauthorized`  — caller is not the group creator.
/// - `GroupClosed`   — the group is still open; close it first.
/// - `InvalidShares` — bps sum ≠ 10 000, or a key is not a member.
pub fn set_shares(
    env: &Env,
    creator: Address,
    group_id: u64,
    shares_bps: Map<Address, u32>,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    creator.require_auth();

    let key = DataKey::Group(group_id);
    let mut group: Group = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    if group.creator != creator {
        return Err(Error::Unauthorized);
    }
    // The group must have been closed before shares can be configured.
    if group.open {
        return Err(Error::GroupClosed);
    }

    // Validate: every key must be a group member, and the bps must sum to
    // exactly TOTAL_BPS. We reject early on overflow (checked_add) so
    // pathological inputs can't wrap around and produce a false-positive
    // sum check.
    let mut total: u32 = 0;
    for (member, bps) in shares_bps.iter() {
        if !group.members.iter().any(|m| m == member) {
            return Err(Error::InvalidShares);
        }
        total = total.checked_add(bps).ok_or(Error::InvalidShares)?;
    }
    if total != TOTAL_BPS {
        return Err(Error::InvalidShares);
    }

    group.shares_bps = shares_bps;
    env.storage().persistent().set(&key, &group);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_GROUP_SHARES_SET, creator.clone(), group_id),
        (group_id, creator, group.shares_bps.clone(), env.ledger().timestamp()),
    );

    Ok(())
}

/// Settle the pool: pay each member `pool_balance * bps / 10_000`.
///
/// Settlement is permissionless once shares have been configured — any
/// signed `caller` may trigger it; funds always go to the recorded members,
/// never to the caller.
///
/// ## Weighted distribution
///
/// For each member `m` with `bps` basis points, their payout is:
///
/// ```text
/// share_m = pool_balance * bps_m / 10_000   (floor division)
/// ```
///
/// Because floor division discards the fractional stroops, the sum of all
/// floor shares may be `1..n` stroops less than `pool_balance`. The entire
/// remainder is added to the first member's share (the group creator, who
/// occupies `members[0]` by construction in `group::create`). This
/// deterministically assigns the rounding dust and guarantees the pool is
/// fully drained — leaving `group.balance == 0` — on every call.
///
/// ## Errors
///
/// - `NotFound`       — `group_id` does not exist.
/// - `GroupClosed`    — the group is still open (must be closed before settle).
/// - `InvalidShares`  — `group_set_shares` was never called.
/// - `NotInitialized` — the vault token is not configured.
/// - `Overflow`       — arithmetic overflow on a per-member computation.
/// - `Paused`         — the vault is admin-paused.
pub fn settle(env: &Env, caller: Address, group_id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    caller.require_auth();

    let key = DataKey::Group(group_id);
    let mut group: Group = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    // Shares can only be set on a closed group, so we check `open` first.
    if group.open {
        return Err(Error::GroupClosed);
    }
    // Shares must have been configured via `group_set_shares` before settling.
    if group.shares_bps.is_empty() {
        return Err(Error::InvalidShares);
    }

    let pool = group.balance;
    let now = env.ledger().timestamp();

    // --- First pass: compute each member's floor share ---------------------
    //
    // We iterate `group.members` (ordered Vec) rather than `shares_bps`
    // (Map, unordered) so the remainder always lands on index 0 regardless
    // of map iteration order — making the assignment deterministic.
    let mut floor_shares: Vec<i128> = Vec::new(env);
    let mut distributed: i128 = 0;

    for member in group.members.iter() {
        let bps = group.shares_bps.get(member.clone()).unwrap_or(0);
        // Use checked arithmetic so an excessively large pool can't silently
        // produce wrong results — Overflow is a cleaner failure mode.
        let raw = pool.checked_mul(bps as i128).ok_or(Error::Overflow)?;
        let share = raw.checked_div(TOTAL_BPS as i128).ok_or(Error::Overflow)?;
        distributed = distributed.checked_add(share).ok_or(Error::Overflow)?;
        floor_shares.push_back(share);
    }

    // The remainder is always in [0, n_members) stroops.
    let remainder = pool.checked_sub(distributed).ok_or(Error::Overflow)?;

    // --- Second pass: transfer and emit ------------------------------------
    for (index, member) in group.members.iter().enumerate() {
        let mut share = floor_shares.get(index as u32).unwrap();

        // Assign the entire rounding remainder to the first member (creator).
        if index == 0 {
            share = share.checked_add(remainder).ok_or(Error::Overflow)?;
        }

        // Skip members with a zero-bps share (no transfer, no event).
        if share == 0 {
            continue;
        }

        storage::transfer_out(env, &member, share)?;

        // One event per paying member.
        // Topics: (symbol, member_address, group_id)  — filterable by the indexer.
        // Data:   (group_id, member_address, amount, ledger_timestamp)
        env.events().publish(
            (TOPIC_GROUP_SPLIT_SETTLED, member.clone(), group_id),
            (group_id, member, share, now),
        );
    }

    // Zero the pool and persist — a second call to `settle` will transfer
    // nothing (all shares would be 0).
    group.balance = 0;
    env.storage().persistent().set(&key, &group);
    storage::extend_persistent_ttl(env, &key);

    Ok(())
}
