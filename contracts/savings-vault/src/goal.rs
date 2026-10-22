//! Goal-based savings — save toward a target with automated milestones.

use soroban_sdk::{Address, Env, Map, String};

use crate::error::Error;
use crate::events::{
    TOPIC_GOAL_AUTO_RENEW_SET, TOPIC_GOAL_CLAIMED, TOPIC_GOAL_CONTRIBUTION, TOPIC_GOAL_CREATED,
    TOPIC_GOAL_REACHED, TOPIC_GOAL_RENEWED, TOPIC_GOAL_SPLIT_PAID,
};
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, Goal};

/// Split a goal's balance in proportion to each contributor's total funding.
/// Rounding dust is assigned to the goal owner.
pub fn compute_payouts(
    env: &Env,
    contributions: &Map<Address, i128>,
    pool: i128,
    owner: &Address,
) -> Result<Map<Address, i128>, Error> {
    let total = contributions
        .iter()
        .try_fold(0i128, |sum, (_, amount)| sum.checked_add(amount))
        .ok_or(Error::Overflow)?;
    if total <= 0 {
        let mut payouts = Map::new(env);
        payouts.set(owner.clone(), pool);
        return Ok(payouts);
    }

    let mut payouts = Map::new(env);
    let mut distributed = 0i128;
    for (contributor, amount) in contributions.iter() {
        let payout = pool
            .checked_mul(amount)
            .ok_or(Error::Overflow)?
            .checked_div(total)
            .ok_or(Error::Overflow)?;
        distributed = distributed.checked_add(payout).ok_or(Error::Overflow)?;
        payouts.set(contributor, payout);
    }

    let remainder = pool.checked_sub(distributed).ok_or(Error::Overflow)?;
    let owner_payout = payouts.get(owner.clone()).unwrap_or(0);
    payouts.set(
        owner.clone(),
        owner_payout.checked_add(remainder).ok_or(Error::Overflow)?,
    );
    Ok(payouts)
}

/// Create a savings goal with a `target_amount`.
///
/// - `owner.require_auth()`.
/// - Errors `InvalidAmount` if `target_amount <= 0`.
/// - Returns the new goal id.
pub fn create(env: &Env, owner: Address, name: String, target_amount: i128) -> Result<u64, Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    if target_amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let id = storage::next_id(env, DataKey::NextGoalId);
    let now = env.ledger().timestamp();
    let goal = Goal {
        id,
        owner: owner.clone(),
        name: name.clone(),
        target_amount,
        saved_amount: 0,
        created_at: now,
        reached_at: None,
        auto_renew: false,
    };
    let key = DataKey::Goal(id);
    env.storage().persistent().set(&key, &goal);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_GOAL_CREATED, owner.clone(), id),
        (id, owner, name, target_amount, now),
    );

    Ok(id)
}

/// Contribute `amount` toward a goal. When cumulative `saved_amount` first
/// reaches `target_amount`, set `reached_at` and emit a `goal_reached` event.
pub fn contribute(env: &Env, from: Address, goal_id: u64, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);
    from.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let key = DataKey::Goal(goal_id);
    let mut goal: Goal = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    storage::transfer_in(env, &from, amount)?;

    let contributions_key = DataKey::GoalContributions(goal_id);
    let mut contributions: Map<Address, i128> = env
        .storage()
        .persistent()
        .get(&contributions_key)
        .unwrap_or(Map::new(env));
    let contributed = contributions
        .get(from.clone())
        .unwrap_or(0)
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    contributions.set(from.clone(), contributed);
    env.storage()
        .persistent()
        .set(&contributions_key, &contributions);
    storage::extend_persistent_ttl(env, &contributions_key);
    let contribution_ledger_key = DataKey::GoalLastContributionLedger(goal_id);
    env.storage()
        .persistent()
        .set(&contribution_ledger_key, &env.ledger().sequence());
    storage::extend_persistent_ttl(env, &contribution_ledger_key);

    let was_reached = goal.reached_at.is_some();
    let new_saved = goal
        .saved_amount
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    goal.saved_amount = new_saved;

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_GOAL_CONTRIBUTION, from.clone(), goal_id),
        (goal_id, from, amount, new_saved, now),
    );

    if !was_reached && new_saved >= goal.target_amount {
        goal.reached_at = Some(now);
        env.events().publish(
            (TOPIC_GOAL_REACHED, goal.owner.clone(), goal_id),
            (
                goal_id,
                goal.owner.clone(),
                new_saved,
                goal.target_amount,
                now,
            ),
        );
    }

    env.storage().persistent().set(&key, &goal);
    storage::extend_persistent_ttl(env, &key);

    Ok(())
}

/// Pay a reached goal out to contributors in proportion to their contributions.
///
/// If the goal has `auto_renew` enabled, the payout is followed by a
/// restart: `saved_amount` resets to 0 and `reached_at` clears (the id,
/// name, and target are kept), so the same goal can be saved toward again.
/// Otherwise the goal is closed, as before.
///
/// Errors `GoalNotReached` if the target has not been met yet, or `SameLedger`
/// if a contribution was made in the current ledger.
pub fn claim(env: &Env, owner: Address, goal_id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    let key = DataKey::Goal(goal_id);
    let mut goal: Goal = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    if goal.owner != owner {
        return Err(Error::Unauthorized);
    }

    if goal.reached_at.is_none() {
        return Err(Error::GoalNotReached);
    }

    let contribution_ledger_key = DataKey::GoalLastContributionLedger(goal_id);
    let last_contribution_ledger: Option<u32> =
        env.storage().persistent().get(&contribution_ledger_key);
    if last_contribution_ledger.is_some_and(|sequence| env.ledger().sequence() <= sequence) {
        return Err(Error::SameLedger);
    }

    let contributions_key = DataKey::GoalContributions(goal_id);
    let contributions: Map<Address, i128> = env
        .storage()
        .persistent()
        .get(&contributions_key)
        .unwrap_or(Map::new(env));
    let payouts = compute_payouts(env, &contributions, goal.saved_amount, &goal.owner)?;

    for (contributor, amount) in payouts.iter() {
        if amount == 0 {
            continue;
        }
        storage::transfer_out(env, &contributor, amount)?;
        env.events().publish(
            (TOPIC_GOAL_SPLIT_PAID, contributor.clone(), goal_id),
            (goal_id, contributor, amount, env.ledger().timestamp()),
        );
    }

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_GOAL_CLAIMED, owner.clone(), goal_id),
        (goal_id, owner.clone(), goal.saved_amount, now),
    );

    if goal.auto_renew {
        // Restart in place: clear progress but keep the goal alive so the
        // owner can begin saving toward the same target again.
        goal.saved_amount = 0;
        goal.reached_at = None;
        env.storage().persistent().remove(&contributions_key);
        env.storage().persistent().remove(&contribution_ledger_key);
        env.storage().persistent().set(&key, &goal);
        storage::extend_persistent_ttl(env, &key);

        env.events().publish(
            (TOPIC_GOAL_RENEWED, owner.clone(), goal_id),
            (goal_id, owner, goal.target_amount, now),
        );
    } else {
        // Paid out in full — close the goal rather than leaving a claimable
        // zero-balance record behind.
        env.storage().persistent().remove(&key);
        env.storage().persistent().remove(&contributions_key);
        env.storage().persistent().remove(&contribution_ledger_key);
    }

    Ok(())
}

/// Enable or disable automatic renewal for a goal. Owner-only.
///
/// When enabled, [`claim`] restarts the goal (zeroed `saved_amount`, cleared
/// `reached_at`) instead of closing it.
pub fn set_auto_renew(
    env: &Env,
    owner: Address,
    goal_id: u64,
    auto_renew: bool,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    let key = DataKey::Goal(goal_id);
    let mut goal: Goal = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    if goal.owner != owner {
        return Err(Error::Unauthorized);
    }

    goal.auto_renew = auto_renew;
    env.storage().persistent().set(&key, &goal);
    storage::extend_persistent_ttl(env, &key);

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_GOAL_AUTO_RENEW_SET, owner.clone(), goal_id),
        (goal_id, owner, auto_renew, now),
    );

    Ok(())
}

pub fn get_goal(env: &Env, goal_id: u64) -> Result<Goal, Error> {
    let key = DataKey::Goal(goal_id);
    let goal = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(goal)
}

/// Return the recorded total contribution for each shared-goal participant.
pub fn get_contributions(env: &Env, goal_id: u64) -> Result<Map<Address, i128>, Error> {
    let goal_key = DataKey::Goal(goal_id);
    if !env.storage().persistent().has(&goal_key) {
        return Err(Error::NotFound);
    }
    let key = DataKey::GoalContributions(goal_id);
    let contributions = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(Map::new(env));
    storage::extend_persistent_ttl(env, &goal_key);
    if env.storage().persistent().has(&key) {
        storage::extend_persistent_ttl(env, &key);
    }
    Ok(contributions)
}

/// Helper to allocate the next goal id.
fn next_goal_id(env: &Env) -> u64 {
    let key = DataKey::NextGoalId;
    let current: u64 = env.storage().instance().get(&key).unwrap_or(0);
    let next = current + 1;
    env.storage().instance().set(&key, &next);
    next
}
