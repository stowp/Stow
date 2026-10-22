//! Time-locked admin actions (issue #438).
//!
//! Sensitive admin operations cannot execute immediately. Instead, the admin
//! _queues_ an action — storing a payload and an ETA (current ledger timestamp
//! + configured delay) — and may only _execute_ it after the ETA passes.
//! Actions also have a grace period after which they expire and can no longer
//! be executed.
//!
//! ## Flow
//!
//! ```text
//! admin calls queue_action(action)
//!   → stores QueuedAction { id, action, eta, expires_at, status: Pending }
//!   → emits timelock_queued
//!
//! time passes (at least `delay` seconds)
//!
//! admin calls execute_action(id)
//!   → validates ETA reached, not expired, not already executed/cancelled
//!   → applies the underlying admin mutation
//!   → marks status = Executed
//!   → emits timelock_executed
//!
//! OR admin calls cancel_action(id)
//!   → marks status = Cancelled
//!   → emits timelock_cancelled
//! ```
//!
//! ## Which actions are timelocked?
//!
//! All sensitive admin mutations are timelocked. `set_paused` is intentionally
//! **exempt**: an emergency pause must be instantaneous — imposing a delay
//! would defeat the circuit-breaker purpose entirely. See [`TimelockAction`]
//! for the full list.
//!
//! ## Auth
//!
//! - `queue_action`  — admin only (`admin.require_auth()`).
//! - `cancel_action` — admin only (`admin.require_auth()`).
//! - `execute_action` — admin only (`admin.require_auth()`).
//!   Rationale: restricting execute to the admin prevents griefing (a third
//!   party racing the admin's own timing preferences) while still allowing
//!   the admin to execute at any time after the ETA. A multi-sig or DAO
//!   controller that holds the admin key can simply sign the `execute_action`
//!   call like any other admin call.

use soroban_sdk::{Address, Env};

use crate::error::Error;
use crate::events::{TOPIC_TIMELOCK_CANCELLED, TOPIC_TIMELOCK_EXECUTED, TOPIC_TIMELOCK_QUEUED};
use crate::interest;
use crate::storage::{self, extend_instance_ttl, extend_persistent_ttl};
use crate::types::{ActionStatus, DataKey, QueuedAction, TimelockAction};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum allowed timelock delay: 1 hour (3 600 seconds).
pub const MIN_TIMELOCK_DELAY: u64 = 3_600;

/// Maximum allowed timelock delay: 30 days (2 592 000 seconds).
pub const MAX_TIMELOCK_DELAY: u64 = 2_592_000;

/// Default delay used until the admin explicitly sets a different value via
/// `queue_action(TimelockAction::SetTimelockDelay(...))` + `execute_action`.
/// Set to 24 hours — a sensible starting point for a new vault.
pub const DEFAULT_TIMELOCK_DELAY: u64 = 86_400;

/// Grace period after the ETA during which the action is still executable.
/// After `eta + TIMELOCK_GRACE_PERIOD` the action expires irrevocably.
/// Set to 14 days, giving the admin ample time to execute once the delay
/// has elapsed without leaving actions open indefinitely.
pub const TIMELOCK_GRACE_PERIOD: u64 = 14 * 24 * 3_600; // 14 days

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Return the currently configured timelock delay, in seconds.
///
/// Falls back to [`DEFAULT_TIMELOCK_DELAY`] if the admin has never changed it.
pub fn get_delay(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::TimelockDelay)
        .unwrap_or(DEFAULT_TIMELOCK_DELAY)
}

/// Queue a critical admin action.
///
/// - Requires `admin.require_auth()`.
/// - Allocates a unique id and stores a [`QueuedAction`] in persistent storage.
/// - Returns the allocated id.
/// - Emits `timelock_queued`.
pub fn queue_action(env: &Env, action: TimelockAction) -> Result<u64, Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    let now = env.ledger().timestamp();
    let delay = get_delay(env);
    let eta = now.checked_add(delay).ok_or(Error::Overflow)?;
    let expires_at = eta
        .checked_add(TIMELOCK_GRACE_PERIOD)
        .ok_or(Error::Overflow)?;

    let id = storage::next_id(env, DataKey::NextTimelockId);

    let entry = QueuedAction {
        id,
        action,
        eta,
        expires_at,
        status: ActionStatus::Pending,
        queued_at: now,
    };

    let key = DataKey::QueuedAction(id);
    env.storage().persistent().set(&key, &entry);
    extend_persistent_ttl(env, &key);

    env.events()
        .publish((TOPIC_TIMELOCK_QUEUED,), (id, eta, expires_at, now));

    Ok(id)
}

/// Execute a previously queued action.
///
/// - Requires `admin.require_auth()`.
/// - Fails with `TimelockNotReady` if the ETA has not been reached.
/// - Fails with `TimelockExpired` if the grace period has passed.
/// - Fails with `TimelockAlreadyExecuted` / `TimelockCancelled` for
///   non-Pending actions.
/// - On success, applies the underlying admin mutation, marks the entry
///   `Executed`, and emits `timelock_executed`.
pub fn execute_action(env: &Env, id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    let key = DataKey::QueuedAction(id);
    let mut entry: QueuedAction = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    let now = env.ledger().timestamp();

    match entry.status {
        ActionStatus::Executed => return Err(Error::TimelockAlreadyExecuted),
        ActionStatus::Cancelled => return Err(Error::TimelockCancelled),
        ActionStatus::Pending => {}
    }

    if now < entry.eta {
        return Err(Error::TimelockNotReady);
    }
    if now >= entry.expires_at {
        return Err(Error::TimelockExpired);
    }

    // Apply the underlying admin mutation.
    apply_action(env, &entry.action)?;

    entry.status = ActionStatus::Executed;
    env.storage().persistent().set(&key, &entry);
    extend_persistent_ttl(env, &key);

    env.events()
        .publish((TOPIC_TIMELOCK_EXECUTED,), (id, now));

    Ok(())
}

/// Cancel a queued action.
///
/// - Requires `admin.require_auth()`.
/// - Cancelled actions can never be executed.
/// - Fails if the action does not exist, has already been executed, or is
///   already cancelled.
/// - Emits `timelock_cancelled`.
pub fn cancel_action(env: &Env, id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    let key = DataKey::QueuedAction(id);
    let mut entry: QueuedAction = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    match entry.status {
        ActionStatus::Executed => return Err(Error::TimelockAlreadyExecuted),
        ActionStatus::Cancelled => return Err(Error::TimelockCancelled),
        ActionStatus::Pending => {}
    }

    entry.status = ActionStatus::Cancelled;
    env.storage().persistent().set(&key, &entry);
    extend_persistent_ttl(env, &key);

    let now = env.ledger().timestamp();
    env.events()
        .publish((TOPIC_TIMELOCK_CANCELLED,), (id, now));

    Ok(())
}

/// Read a queued action by id without mutating state.
///
/// Returns `Error::NotFound` if no action with the given id exists.
pub fn get_queued_action(env: &Env, id: u64) -> Result<QueuedAction, Error> {
    let key = DataKey::QueuedAction(id);
    let entry: QueuedAction = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &key);
    Ok(entry)
}

// ---------------------------------------------------------------------------
// Internal: apply the payload
// ---------------------------------------------------------------------------

/// Apply the action payload directly to the underlying admin state.
///
/// This function is intentionally `pub(crate)` — it bypasses the timelock
/// completely. It must only be called from `execute_action` after all
/// validity checks have passed.
fn apply_action(env: &Env, action: &TimelockAction) -> Result<(), Error> {
    match action {
        TimelockAction::SetAdmin(new_admin) => {
            apply_set_admin(env, new_admin.clone())
        }
        TimelockAction::Upgrade(new_wasm_hash) => {
            apply_upgrade(env, new_wasm_hash.clone())
        }
        TimelockAction::SetDepositCap(cap) => {
            apply_set_deposit_cap(env, *cap)
        }
        TimelockAction::SetMinDeposit(min) => {
            apply_set_min_deposit(env, *min)
        }
        TimelockAction::SetEarlyWithdrawPenaltyBps(bps) => {
            apply_set_early_withdraw_penalty_bps(env, *bps)
        }
        TimelockAction::SetPenaltyRecipient(recipient) => {
            apply_set_penalty_recipient(env, recipient.clone())
        }
        TimelockAction::SetMinLockPeriod(seconds) => {
            apply_set_min_lock_period(env, *seconds)
        }
        TimelockAction::SetInterestRate(rate_bps) => {
            apply_set_interest_rate(env, *rate_bps)
        }
        TimelockAction::SetInterestFrequency(frequency) => {
            apply_set_interest_frequency(env, *frequency)
        }
        TimelockAction::SetTimelockDelay(delay) => {
            apply_set_timelock_delay(env, *delay)
        }
    }
}

// --- per-action apply helpers ------------------------------------------
// These write directly to instance storage (mirroring the original admin
// helpers) without requiring a fresh admin.require_auth() — auth was
// already demanded by execute_action().

fn apply_set_admin(env: &Env, new_admin: Address) -> Result<(), Error> {
    use crate::events::TOPIC_ADMIN_SET;
    let current_admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    env.storage().instance().set(&DataKey::Admin, &new_admin);
    env.events().publish(
        (TOPIC_ADMIN_SET,),
        (current_admin, new_admin, env.ledger().timestamp()),
    );
    Ok(())
}

fn apply_upgrade(env: &Env, new_wasm_hash: soroban_sdk::BytesN<32>) -> Result<(), Error> {
    use crate::events::TOPIC_UPGRADED;
    let current_admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    env.deployer()
        .update_current_contract_wasm(new_wasm_hash.clone());
    env.events().publish(
        (TOPIC_UPGRADED,),
        (current_admin, new_wasm_hash, env.ledger().timestamp()),
    );
    Ok(())
}

fn apply_set_deposit_cap(env: &Env, cap: i128) -> Result<(), Error> {
    if cap < 0 {
        return Err(Error::InvalidAmount);
    }
    env.storage().instance().set(&DataKey::DepositCap, &cap);
    Ok(())
}

fn apply_set_min_deposit(env: &Env, min: i128) -> Result<(), Error> {
    if min < 0 {
        return Err(Error::InvalidAmount);
    }
    env.storage().instance().set(&DataKey::MinDeposit, &min);
    Ok(())
}

fn apply_set_early_withdraw_penalty_bps(env: &Env, bps: u32) -> Result<(), Error> {
    if bps > 10_000 {
        return Err(Error::InvalidParameters);
    }
    env.storage()
        .instance()
        .set(&DataKey::EarlyWithdrawPenaltyBps, &bps);
    Ok(())
}

fn apply_set_penalty_recipient(env: &Env, recipient: Address) -> Result<(), Error> {
    env.storage()
        .instance()
        .set(&DataKey::PenaltyRecipient, &recipient);
    Ok(())
}

fn apply_set_min_lock_period(env: &Env, seconds: u64) -> Result<(), Error> {
    env.storage()
        .instance()
        .set(&DataKey::MinLockPeriod, &seconds);
    Ok(())
}

fn apply_set_interest_rate(env: &Env, rate_bps: u32) -> Result<(), Error> {
    // Reuse the interest module's writer so the event is emitted consistently.
    // We pass the current admin address as the nominal caller; auth was
    // already demanded by execute_action.
    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    interest::set_rate_internal(env, admin, rate_bps)
}

fn apply_set_interest_frequency(
    env: &Env,
    frequency: crate::types::CompoundFrequency,
) -> Result<(), Error> {
    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    interest::set_frequency_internal(env, admin, frequency)
}

fn apply_set_timelock_delay(env: &Env, delay: u64) -> Result<(), Error> {
    if delay < MIN_TIMELOCK_DELAY {
        return Err(Error::TimelockDelayTooShort);
    }
    if delay > MAX_TIMELOCK_DELAY {
        return Err(Error::TimelockDelayTooLong);
    }
    env.storage()
        .instance()
        .set(&DataKey::TimelockDelay, &delay);
    Ok(())
}
