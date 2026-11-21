//! Tiered interest rates for the savings vault (#619).
//!
//! Interest rates vary along two independent axes:
//!
//! 1. **Balance tier** — the account's current principal determines a base
//!    rate:
//!    - 0 .. 1 000 (exclusive): [`TIER_LOW_RATE_BPS`]
//!    - 1 000 .. 10 000 (exclusive): [`TIER_MID_RATE_BPS`]
//!    - 10 000 and above: [`TIER_HIGH_RATE_BPS`]
//!
//!    Tier thresholds are intentionally small so they work with any token
//!    denomination — callers that work in stroops will want 7 extra decimal
//!    places.
//!
//! 2. **Lock-period bonus** — an additional basis-point bonus layered on top
//!    of the balance tier rate, based on how far into the future the owner's
//!    locked plan matures:
//!    - < 3 months: no bonus
//!    - 3–6 months: [`LOCK_3MO_BONUS_BPS`]
//!    - 6–12 months: [`LOCK_6MO_BONUS_BPS`]
//!    - 12 months or more: [`LOCK_12MO_BONUS_BPS`]
//!
//! The combined (balance tier + lock bonus) rate is what the interest module
//! should apply to an account.  It is exposed through [`effective_rate_bps`],
//! and the admin can query it at any time with [`query_rate`].
//!
//! ## Storage
//!
//! The tiered config is stored as a single [`TieredRateConfig`] in instance
//! storage under [`DataKey::TieredRateConfig`].  It is absent until the admin
//! calls [`set_tiered_rate_config`]; the defaults from this module are used in
//! the meantime.
//!
//! ## Event
//!
//! [`set_tiered_rate_config`] and every update triggered by a balance or
//! lock-period change emits an [`TOPIC_INTEREST_RATE_CHANGED`] event so
//! off-chain indexers can track the effective rate over time.

use soroban_sdk::{Address, Env};

use crate::admin::require_not_paused;
use crate::error::Error;
use crate::events::TOPIC_INTEREST_RATE_CHANGED;
use crate::storage::extend_instance_ttl;
use crate::types::{DataKey, TieredRateConfig};

// ---------------------------------------------------------------------------
// Tier boundary constants
// ---------------------------------------------------------------------------

/// Balance below this threshold → low tier (in token units; callers using
/// stroops with 7 decimal places should scale accordingly).
pub const BALANCE_TIER_LOW_THRESHOLD: i128 = 1_000;
/// Balance at or above this threshold → high tier.
pub const BALANCE_TIER_HIGH_THRESHOLD: i128 = 10_000;

// ---------------------------------------------------------------------------
// Default rates (in basis points; 10 000 bps = 100 %)
// ---------------------------------------------------------------------------

/// Default annual rate for balances below [`BALANCE_TIER_LOW_THRESHOLD`].
pub const DEFAULT_TIER_LOW_RATE_BPS: u32 = 300; // 3 %
/// Default annual rate for balances in the mid tier.
pub const DEFAULT_TIER_MID_RATE_BPS: u32 = 500; // 5 %
/// Default annual rate for balances at or above [`BALANCE_TIER_HIGH_THRESHOLD`].
pub const DEFAULT_TIER_HIGH_RATE_BPS: u32 = 800; // 8 %

// ---------------------------------------------------------------------------
// Default lock-period bonuses (in basis points added on top of balance tier)
// ---------------------------------------------------------------------------

/// No bonus for lock periods shorter than 3 months.
pub const DEFAULT_LOCK_3MO_BONUS_BPS: u32 = 0;
/// Bonus for a 3-month (but less than 6-month) lock period.
pub const DEFAULT_LOCK_3MO_MIN_BONUS_BPS: u32 = 100; // +1 %
/// Bonus for a 6-month (but less than 12-month) lock period.
pub const DEFAULT_LOCK_6MO_BONUS_BPS: u32 = 200; // +2 %
/// Bonus for a lock period of 12 months or more.
pub const DEFAULT_LOCK_12MO_BONUS_BPS: u32 = 400; // +4 %

// ---------------------------------------------------------------------------
// Lock-period thresholds (seconds)
// ---------------------------------------------------------------------------

/// 3 months in seconds (90 × 86 400).
pub const LOCK_3_MONTHS_SECS: u64 = 7_776_000;
/// 6 months in seconds (180 × 86 400).
pub const LOCK_6_MONTHS_SECS: u64 = 15_552_000;
/// 12 months in seconds (365 × 86 400).
pub const LOCK_12_MONTHS_SECS: u64 = 31_536_000;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/// Load the tiered-rate config from instance storage, falling back to defaults
/// if none has been set.
pub fn load_config(env: &Env) -> TieredRateConfig {
    env.storage()
        .instance()
        .get(&DataKey::TieredRateConfig)
        .unwrap_or_else(|| TieredRateConfig {
            tier_low_rate_bps: DEFAULT_TIER_LOW_RATE_BPS,
            tier_mid_rate_bps: DEFAULT_TIER_MID_RATE_BPS,
            tier_high_rate_bps: DEFAULT_TIER_HIGH_RATE_BPS,
            lock_3mo_bonus_bps: DEFAULT_LOCK_3MO_MIN_BONUS_BPS,
            lock_6mo_bonus_bps: DEFAULT_LOCK_6MO_BONUS_BPS,
            lock_12mo_bonus_bps: DEFAULT_LOCK_12MO_BONUS_BPS,
        })
}

/// Persist a new tiered-rate config. Does **not** emit an event or check auth;
/// callers must do both. Use [`set_tiered_rate_config`] for the public
/// entrypoint.
fn save_config(env: &Env, config: &TieredRateConfig) {
    env.storage()
        .instance()
        .set(&DataKey::TieredRateConfig, config);
}

// ---------------------------------------------------------------------------
// Rate calculation
// ---------------------------------------------------------------------------

/// Return the base annual rate (bps) for `balance`, using the balance tiers
/// from `config`.
pub fn balance_tier_rate(config: &TieredRateConfig, balance: i128) -> u32 {
    if balance >= BALANCE_TIER_HIGH_THRESHOLD {
        config.tier_high_rate_bps
    } else if balance >= BALANCE_TIER_LOW_THRESHOLD {
        config.tier_mid_rate_bps
    } else {
        config.tier_low_rate_bps
    }
}

/// Return the lock-period bonus (bps) for a remaining lock duration of
/// `lock_secs` seconds.
pub fn lock_period_bonus(config: &TieredRateConfig, lock_secs: u64) -> u32 {
    if lock_secs >= LOCK_12_MONTHS_SECS {
        config.lock_12mo_bonus_bps
    } else if lock_secs >= LOCK_6_MONTHS_SECS {
        config.lock_6mo_bonus_bps
    } else if lock_secs >= LOCK_3_MONTHS_SECS {
        config.lock_3mo_bonus_bps
    } else {
        0
    }
}

/// Compute and return the effective annual interest rate (bps) that should be
/// applied to an account with principal `balance` and a remaining lock
/// duration of `lock_secs` seconds (pass `0` when there is no active lock).
///
/// The result is the balance-tier base rate plus the lock-period bonus,
/// capped at 10 000 bps (100 %) to prevent arithmetic surprises downstream.
pub fn effective_rate_bps(env: &Env, balance: i128, lock_secs: u64) -> u32 {
    let config = load_config(env);
    let base = balance_tier_rate(&config, balance);
    let bonus = lock_period_bonus(&config, lock_secs);
    base.saturating_add(bonus).min(10_000)
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

/// Set the tiered-rate configuration. Admin-only.
///
/// Validates that rates are non-decreasing across tiers and that no rate
/// exceeds 10 000 bps (100 %). Emits [`TOPIC_INTEREST_RATE_CHANGED`].
///
/// Errors: `NotInitialized`, `Unauthorized`, `InvalidParameters`.
pub fn set_tiered_rate_config(
    env: &Env,
    caller: Address,
    config: TieredRateConfig,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;

    let admin = crate::storage::get_admin(env).ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != admin {
        return Err(Error::Unauthorized);
    }

    // Validate: rates must be non-decreasing across balance tiers.
    if config.tier_low_rate_bps > config.tier_mid_rate_bps
        || config.tier_mid_rate_bps > config.tier_high_rate_bps
    {
        return Err(Error::InvalidParameters);
    }
    // Validate: no individual component exceeds 100 %.
    if config.tier_high_rate_bps > 10_000
        || config.lock_12mo_bonus_bps > 10_000
        || config.lock_6mo_bonus_bps > 10_000
        || config.lock_3mo_bonus_bps > 10_000
    {
        return Err(Error::InvalidParameters);
    }

    save_config(env, &config);

    env.events().publish(
        (TOPIC_INTEREST_RATE_CHANGED,),
        (caller, config, env.ledger().timestamp()),
    );

    Ok(())
}

/// View function: return the effective annual rate (bps) for an account with
/// principal `balance` and remaining lock duration `lock_secs`.
///
/// Pass `lock_secs = 0` for accounts with no active lock.
/// This is a read-only query; it does not mutate state or emit events.
pub fn query_rate(env: &Env, balance: i128, lock_secs: u64) -> u32 {
    effective_rate_bps(env, balance, lock_secs)
}

/// Emit an `InterestRateChanged` event for `owner` whose effective rate has
/// changed, e.g. after a deposit pushes them into a new balance tier.
///
/// Called by the interest module after updating an account.
pub fn emit_rate_changed(
    env: &Env,
    owner: &Address,
    old_rate_bps: u32,
    new_rate_bps: u32,
    balance: i128,
    lock_secs: u64,
) {
    env.events().publish(
        (TOPIC_INTEREST_RATE_CHANGED, owner.clone()),
        (
            owner.clone(),
            old_rate_bps,
            new_rate_bps,
            balance,
            lock_secs,
            env.ledger().timestamp(),
        ),
    );
}
