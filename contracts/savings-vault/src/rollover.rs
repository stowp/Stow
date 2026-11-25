//! Locked savings auto-rollover (#638).
//!
//! An owner opts a locked plan into auto-rollover with
//! [`enable_auto_rollover`]. Once the plan matures (`now >= unlock_at`),
//! anyone — typically an off-chain keeper — may call [`execute_rollover`],
//! which:
//!
//! 1. computes the interest accrued over the plan's term,
//! 2. creates a brand-new locked plan holding `balance + interest`, locked
//!    for the configured period (or the original term when `lock_period == 0`),
//! 3. closes the original plan by zeroing its balance, and
//! 4. emits a `VaultRolledOver` event carrying the new plan id.
//!
//! The rollover setting carries forward to the new plan, so savings keep
//! rolling term after term until the owner opts out with
//! [`disable_auto_rollover`] (only allowed before maturity).
//!
//! ## Interest
//!
//! Locked plans do not compound on their own. At rollover the plan earns
//! simple interest at the admin's annual rate ([`crate::interest::rate_bps`])
//! pro-rated over the plan's term:
//!
//! `interest = balance * rate_bps * term_seconds / (10_000 * 31_536_000)`
//!
//! Interest is funded from the admin-funded reward pool and is capped at the
//! pool's balance, so a rollover never credits tokens the vault does not hold.
//! No token transfer happens: funds stay in the vault and only the internal
//! accounting moves.

use soroban_sdk::{Address, Env};

use crate::admin;
use crate::error::Error;
use crate::events::{TOPIC_ROLLOVER_DISABLED, TOPIC_ROLLOVER_ENABLED, TOPIC_VAULT_ROLLED_OVER};
use crate::interest;
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, LockedPlan, RolloverConfig};

/// Seconds in a (365-day) year, used to pro-rate the annual interest rate.
const SECONDS_PER_YEAR: i128 = 31_536_000;
/// 100% in basis points.
const TOTAL_BPS: i128 = 10_000;

fn load_plan(env: &Env, plan_id: u64) -> Result<LockedPlan, Error> {
    let key = DataKey::Locked(plan_id);
    let plan: LockedPlan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(plan)
}

/// Opt a locked plan into auto-rollover, or update its rollover terms.
///
/// - `owner.require_auth()`; `owner` must own `plan_id`.
/// - `lock_period` is the new plan's lock length in seconds; `0` keeps the
///   original term.
/// - Errors `OperationExpired` once the plan has matured (rollover must be
///   configured before maturity), `InsufficientBalance` for an empty plan.
pub fn enable_auto_rollover(
    env: &Env,
    owner: Address,
    plan_id: u64,
    lock_period: u64,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    let plan = load_plan(env, plan_id)?;
    if plan.owner != owner {
        return Err(Error::Unauthorized);
    }
    if plan.balance <= 0 {
        return Err(Error::InsufficientBalance);
    }

    let now = env.ledger().timestamp();
    if now >= plan.unlock_at {
        return Err(Error::OperationExpired);
    }

    let config = RolloverConfig {
        plan_id,
        owner: owner.clone(),
        lock_period,
        enabled_at: now,
    };
    let key = DataKey::Rollover(plan_id);
    env.storage().persistent().set(&key, &config);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_ROLLOVER_ENABLED, owner.clone(), plan_id),
        (plan_id, owner, lock_period, now),
    );

    Ok(())
}

/// Opt a plan out of auto-rollover. Only allowed before maturity — once the
/// plan has matured the rollover may already be executing.
///
/// Errors: `Unauthorized` if `owner` does not own the plan, `NotFound` if
/// rollover is not enabled, `OperationExpired` at or after `unlock_at`.
pub fn disable_auto_rollover(env: &Env, owner: Address, plan_id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    let plan = load_plan(env, plan_id)?;
    if plan.owner != owner {
        return Err(Error::Unauthorized);
    }

    let key = DataKey::Rollover(plan_id);
    if !env.storage().persistent().has(&key) {
        return Err(Error::NotFound);
    }

    let now = env.ledger().timestamp();
    if now >= plan.unlock_at {
        return Err(Error::OperationExpired);
    }

    env.storage().persistent().remove(&key);

    env.events().publish(
        (TOPIC_ROLLOVER_DISABLED, owner.clone(), plan_id),
        (plan_id, owner, now),
    );

    Ok(())
}

/// Roll a matured plan into a new locked plan. Permissionless so a keeper can
/// automate it; funds never leave the vault and the new plan belongs to the
/// original owner.
///
/// Returns the new plan id.
///
/// Errors: `NotFound` if the plan does not exist or rollover is not enabled,
/// `StillLocked` before `unlock_at`, `InsufficientBalance` if the plan has
/// already been emptied (e.g. withdrawn after maturity).
pub fn execute_rollover(env: &Env, plan_id: u64) -> Result<u64, Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;

    let mut plan = load_plan(env, plan_id)?;
    let config_key = DataKey::Rollover(plan_id);
    let config: RolloverConfig = env
        .storage()
        .persistent()
        .get(&config_key)
        .ok_or(Error::NotFound)?;

    let now = env.ledger().timestamp();
    if now < plan.unlock_at {
        return Err(Error::StillLocked);
    }
    if plan.balance <= 0 {
        return Err(Error::InsufficientBalance);
    }

    let term = plan.unlock_at.saturating_sub(plan.created_at);
    let interest = accrued_interest(env, plan.balance, term)?;
    if interest > 0 {
        let pool = crate::rewards::pool_balance(env);
        let remaining = pool.checked_sub(interest).ok_or(Error::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::RewardPoolBalance, &remaining);
    }

    let principal = plan.balance;
    let new_balance = principal.checked_add(interest).ok_or(Error::Overflow)?;
    let lock_period = if config.lock_period == 0 {
        term
    } else {
        config.lock_period
    };
    // A zero-length term would create a plan that is already unlocked.
    let lock_period = lock_period.max(1);
    let new_unlock_at = now.checked_add(lock_period).ok_or(Error::Overflow)?;

    let new_id = storage::next_id(env, DataKey::NextLockedId);
    let new_plan = LockedPlan {
        id: new_id,
        owner: plan.owner.clone(),
        balance: new_balance,
        unlock_at: new_unlock_at,
        created_at: now,
    };
    let new_key = DataKey::Locked(new_id);
    env.storage().persistent().set(&new_key, &new_plan);
    storage::extend_persistent_ttl(env, &new_key);

    // Close the original plan.
    plan.balance = 0;
    let old_key = DataKey::Locked(plan_id);
    env.storage().persistent().set(&old_key, &plan);
    storage::extend_persistent_ttl(env, &old_key);

    // Carry the rollover setting forward to the new plan.
    env.storage().persistent().remove(&config_key);
    let new_config = RolloverConfig {
        plan_id: new_id,
        owner: plan.owner.clone(),
        lock_period: config.lock_period,
        enabled_at: now,
    };
    let new_config_key = DataKey::Rollover(new_id);
    env.storage().persistent().set(&new_config_key, &new_config);
    storage::extend_persistent_ttl(env, &new_config_key);

    env.events().publish(
        (TOPIC_VAULT_ROLLED_OVER, plan.owner.clone(), plan_id),
        (
            plan_id,
            new_id,
            principal,
            interest,
            new_balance,
            new_unlock_at,
            now,
        ),
    );

    Ok(new_id)
}

/// Read a plan's rollover settings, if auto-rollover is enabled.
pub fn get_config(env: &Env, plan_id: u64) -> Option<RolloverConfig> {
    let key = DataKey::Rollover(plan_id);
    let config: Option<RolloverConfig> = env.storage().persistent().get(&key);
    if config.is_some() {
        storage::extend_persistent_ttl(env, &key);
    }
    config
}

/// Simple interest on `balance` over `term_seconds` at the admin's annual
/// rate, floored and capped at the reward pool balance.
fn accrued_interest(env: &Env, balance: i128, term_seconds: u64) -> Result<i128, Error> {
    let rate = interest::rate_bps(env) as i128;
    if rate == 0 || term_seconds == 0 || balance <= 0 {
        return Ok(0);
    }
    let numerator = balance
        .checked_mul(rate)
        .and_then(|v| v.checked_mul(term_seconds as i128))
        .ok_or(Error::Overflow)?;
    let raw = numerator / (TOTAL_BPS * SECONDS_PER_YEAR);
    let pool = crate::rewards::pool_balance(env);
    Ok(raw.min(pool.max(0)))
}
