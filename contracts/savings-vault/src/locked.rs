//! Locked savings — deterministic, on-chain time locks.

use soroban_sdk::{Address, Env};

use crate::admin;
use crate::error::Error;
use crate::events::{
    TOPIC_EMERGENCY_WITHDRAW, TOPIC_LOCKED_CREATED, TOPIC_LOCKED_EARLY_WITHDRAW,
    TOPIC_LOCKED_TOP_UP, TOPIC_LOCKED_WITHDRAW, TOPIC_PARTIAL_LIQUIDATION,
};
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, LockedPlan};

/// Create a locked plan that unlocks at `unlock_at` (ledger timestamp) and
/// fund it with an initial `amount`.
///
/// - `owner.require_auth()`, token transfer_in.
/// - Errors `InvalidUnlockTime` if `unlock_at <= now`.
/// - Returns the new plan id.
pub fn create(env: &Env, owner: Address, amount: i128, unlock_at: u64) -> Result<u64, Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if unlock_at <= env.ledger().timestamp() {
        return Err(Error::InvalidUnlockTime);
    }

    storage::transfer_in(env, &owner, amount)?;

    let id = storage::next_id(env, DataKey::NextLockedId);
    let now = env.ledger().timestamp();
    let plan = LockedPlan {
        id,
        owner: owner.clone(),
        balance: amount,
        unlock_at,
        created_at: now,
    };
    let key = DataKey::Locked(id);
    env.storage().persistent().set(&key, &plan);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_LOCKED_CREATED, owner.clone(), id),
        (id, owner, amount, unlock_at, now),
    );

    Ok(id)
}

/// Add more funds to an existing locked plan (does not change unlock time).
///
/// - `owner.require_auth()`.
/// - Errors `Unauthorized` if `owner` does not own `plan_id`.
pub fn top_up(env: &Env, owner: Address, plan_id: u64, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let key = DataKey::Locked(plan_id);
    let mut plan: LockedPlan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    if plan.owner != owner {
        return Err(Error::Unauthorized);
    }

    storage::transfer_in(env, &owner, amount)?;

    let new_balance = plan.balance.checked_add(amount).ok_or(Error::Overflow)?;
    plan.balance = new_balance;
    env.storage().persistent().set(&key, &plan);
    storage::extend_persistent_ttl(env, &key);

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_LOCKED_TOP_UP, owner.clone(), plan_id),
        (plan_id, owner, amount, new_balance, now),
    );

    Ok(())
}

/// Withdraw from a locked plan. Only permitted once `now >= unlock_at`.
///
/// Errors: `Unauthorized` if `owner` does not own `plan_id`,
/// `InsufficientBalance` if over-withdrawing (checked before the time
/// guard so callers get the most actionable error), `StillLocked` before
/// unlock.
///
/// ## Payout destination
///
/// As with `flexible::withdraw`, there is no separate "recipient"
/// parameter: `owner` must both authenticate (`require_auth`) and match the
/// plan's stored owner, and `token_client.transfer` always pays that same
/// address. Funds cannot be redirected to a third-party address — the API
/// gives the caller no way to name one. No exception to this exists for
/// locked (solo) plans.
pub fn withdraw(env: &Env, owner: Address, plan_id: u64, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let key = DataKey::Locked(plan_id);
    let mut plan: LockedPlan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    if plan.owner != owner {
        return Err(Error::Unauthorized);
    }

    if amount > plan.balance {
        return Err(Error::InsufficientBalance);
    }

    if env.ledger().timestamp() < plan.unlock_at {
        return Err(Error::StillLocked);
    }

    let new_balance = plan.balance.checked_sub(amount).ok_or(Error::Overflow)?;

    // Collateral lock: even an unlocked plan backing a loan cannot be
    // withdrawn below the minimum locked balance for outstanding debt.
    crate::collateral::check_withdrawal(env, &owner, new_balance)?;

    storage::transfer_out(env, &owner, amount)?;

    plan.balance = new_balance;
    env.storage().persistent().set(&key, &plan);
    storage::extend_persistent_ttl(env, &key);

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_LOCKED_WITHDRAW, owner.clone(), plan_id),
        (plan_id, owner, amount, new_balance, now),
    );

    Ok(())
}

pub fn get_plan(env: &Env, plan_id: u64) -> Result<LockedPlan, Error> {
    let key = DataKey::Locked(plan_id);
    let plan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(plan)
}

/// Withdraw part of a locked plan's balance *before* `unlock_at`, paying an
/// admin-configured penalty on the withdrawn amount.
///
/// This is the partial-withdrawal path for funds that are still locked: the
/// owner can take some (or all) of the balance early, but a penalty is
/// skimmed off the top and sent to the configured penalty recipient. The
/// plan itself stays open with the reduced balance; a later
/// [`withdraw`] (or another early withdrawal) can take the rest.
///
/// ## Minimum lock period
///
/// Early withdrawal is only available once the plan has been locked for at
/// least `min_lock_period` seconds
/// ([`crate::admin::min_lock_period`]), so the valid window is
/// `[created_at + min_lock_period, unlock_at)`. Attempts before the window
/// opens fail with `TimeWindowNotOpen`; attempts once `unlock_at` has passed
/// fail with `OperationExpired` — at that point the penalty-free
/// [`withdraw`] applies instead.
///
/// ## Penalty
///
/// `penalty = amount * early_withdraw_penalty_bps / 10_000`, floored. The
/// owner receives `amount - penalty`; the penalty goes to
/// [`crate::admin::penalty_recipient`] (the admin by default). A zero
/// penalty (rate unset) skips the recipient transfer entirely.
///
/// Errors: `Unauthorized` if `owner` does not own `plan_id`,
/// `InsufficientBalance` if over-withdrawing, `TimeWindowNotOpen`,
/// `OperationExpired`.
pub fn early_withdraw(env: &Env, owner: Address, plan_id: u64, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let key = DataKey::Locked(plan_id);
    let mut plan: LockedPlan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    if plan.owner != owner {
        return Err(Error::Unauthorized);
    }

    if amount > plan.balance {
        return Err(Error::InsufficientBalance);
    }

    let now = env.ledger().timestamp();

    // Already unlocked: the penalized path no longer applies.
    if now >= plan.unlock_at {
        return Err(Error::OperationExpired);
    }

    // Window not yet open: still inside the minimum lock period.
    let window_opens = plan
        .created_at
        .checked_add(admin::min_lock_period(env))
        .ok_or(Error::Overflow)?;
    if now < window_opens {
        return Err(Error::TimeWindowNotOpen);
    }

    let bps = admin::early_withdraw_penalty_bps(env);
    let penalty = amount.checked_mul(bps as i128).ok_or(Error::Overflow)? / 10_000;
    let net = amount.checked_sub(penalty).ok_or(Error::Overflow)?;

    // Collateral lock: the *gross* amount leaves the plan, so the new plan
    // balance is what the collateral check must see.
    let new_plan_balance = plan.balance.checked_sub(amount).ok_or(Error::Overflow)?;
    crate::collateral::check_withdrawal(env, &owner, new_plan_balance)?;

    if net > 0 {
        storage::transfer_out(env, &owner, net)?;
    }
    if penalty > 0 {
        storage::transfer_out(env, &admin::penalty_recipient(env)?, penalty)?;
    }

    let new_balance = plan.balance.checked_sub(amount).ok_or(Error::Overflow)?;
    plan.balance = new_balance;
    env.storage().persistent().set(&key, &plan);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_LOCKED_EARLY_WITHDRAW, owner.clone(), plan_id),
        (plan_id, owner, amount, penalty, new_balance, now),
    );

    Ok(())
}

/// Liquidate a percentage of a locked plan's current balance before
/// `unlock_at`. `liquidation_bps` is in basis points of the balance
/// (`5_000` = 50%).
///
/// The liquidated amount is `balance * liquidation_bps / 10_000`, floored.
/// It is paid out through [`early_withdraw`], so the same time window and
/// penalty rules apply, and the penalty is charged on the liquidated portion
/// only. The remaining balance stays in the plan, so repeated calls can
/// liquidate further slices.
///
/// Returns the amount liquidated (before penalty).
///
/// Errors: `InvalidParameters` if `liquidation_bps` is `0` or above `10_000`,
/// `Unauthorized` if `owner` does not own `plan_id`, `InvalidAmount` if the
/// computed slice is zero, plus any error from [`early_withdraw`].
pub fn partial_liquidate(
    env: &Env,
    owner: Address,
    plan_id: u64,
    liquidation_bps: u32,
) -> Result<i128, Error> {
    if liquidation_bps == 0 || liquidation_bps > 10_000 {
        return Err(Error::InvalidParameters);
    }

    let plan: LockedPlan = env
        .storage()
        .persistent()
        .get(&DataKey::Locked(plan_id))
        .ok_or(Error::NotFound)?;
    if plan.owner != owner {
        return Err(Error::Unauthorized);
    }

    let amount = plan
        .balance
        .checked_mul(liquidation_bps as i128)
        .ok_or(Error::Overflow)?
        / 10_000;
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    early_withdraw(env, owner.clone(), plan_id, amount)?;

    let bps = admin::early_withdraw_penalty_bps(env);
    let penalty = amount.checked_mul(bps as i128).ok_or(Error::Overflow)? / 10_000;
    let remaining = plan.balance.checked_sub(amount).ok_or(Error::Overflow)?;
    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_PARTIAL_LIQUIDATION, owner.clone(), plan_id),
        (plan_id, owner, amount, penalty, remaining, now),
    );

    Ok(amount)
}

/// Emergency withdrawal from a locked plan. Only available when the contract
/// is in emergency mode. Bypasses the timelock and incurs no penalty, and is
/// deliberately not guarded by `require_not_paused` so funds remain
/// reachable even while the vault is paused.
pub fn emergency_withdraw(env: &Env, owner: Address, plan_id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    if !admin::is_emergency_mode(env) {
        return Err(Error::NotPaused);
    }

    let key = DataKey::Locked(plan_id);
    let mut plan: LockedPlan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    if plan.owner != owner {
        return Err(Error::Unauthorized);
    }

    if plan.balance <= 0 {
        return Err(Error::InsufficientBalance);
    }

    let amount = plan.balance;

    // Collateral lock applies even in emergency mode: a vault backing a loan
    // must not be drained below the minimum locked balance. If the owner needs
    // the funds, the position must be liquidated or the debt repaid first.
    crate::collateral::check_withdrawal(env, &owner, 0)?;

    storage::transfer_out(env, &owner, amount)?;

    plan.balance = 0;
    env.storage().persistent().set(&key, &plan);
    storage::extend_persistent_ttl(env, &key);

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_EMERGENCY_WITHDRAW, owner.clone(), plan_id),
        (plan_id, owner, amount, now),
    );

    Ok(())
}
