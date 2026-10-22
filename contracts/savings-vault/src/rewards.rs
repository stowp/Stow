//! Savings boost rewards — loyalty multipliers, streak bonuses, reward pool.
//!
//! ## Architecture
//!
//! Rewards are attached to [`InterestAccount`] holders. A user must have an
//! interest account (created via `interest_deposit`) to accrue rewards.
//!
//! ### Accrual model (lazy)
//!
//! Rewards are **never** written automatically on every ledger. Instead they
//! are derived on demand and folded into `pending` when either:
//! - the user calls [`accrue`] explicitly, or
//! - the user calls [`claim`].
//!
//! Per accrual period:
//! ```text
//! base      = principal × base_rate_bps / 10_000
//! loyalty   = loyalty_multiplier_bps(hold_age) / 10_000   (≥ 1.0×, capped)
//! streak_b  = min(streak × streak_bonus_bps_per_period, streak_bonus_cap_bps)
//! reward    = floor(base × loyalty) + floor(principal × streak_b / 10_000)
//! ```
//! All arithmetic uses checked operations and rounds **down** so the pool can
//! never be over-drawn by rounding.
//!
//! ### Pool safety
//!
//! The reward pool balance (`DataKey::RewardPoolBalance`) is decremented on
//! every [`claim`]. If the pool holds less than `pending`, the contract pays
//! out whatever is available and zeroes the pool, leaving the unpaid remainder
//! in `pending`. The pool **never** goes negative.
//!
//! ### Streak
//!
//! A streak period starts from `streak_period_start`. The current period is
//! "kept" by calling [`ping`] (or implicitly by `interest_deposit` /
//! `interest_withdraw` via [`note_touch`]). A period is "missed" when
//! [`accrue`] or [`claim`] observes that now ≥ streak_period_start +
//! streak_period_seconds without the period having been kept. Missing any
//! period resets the streak to 0.
//!
//! ### Admin config
//!
//! [`set_config`] validates and stores a [`RewardsConfig`]. [`fund_pool`]
//! transfers tokens from the admin into the pool.

use soroban_sdk::{Address, Env, Vec};

use crate::admin::require_not_paused;
use crate::error::Error;
use crate::events::{
    TOPIC_REWARD_ACCRUED, TOPIC_REWARD_CLAIMED, TOPIC_REWARD_CONFIG_SET, TOPIC_REWARD_FUNDED,
    TOPIC_STREAK_UPDATED,
};
use crate::storage::{self, extend_instance_ttl, extend_persistent_ttl};
use crate::types::{DataKey, InterestAccount, LoyaltyTier, RewardState, RewardsConfig};

// ---------------------------------------------------------------------------
// Constants — default config (used when no config has been set)
// ---------------------------------------------------------------------------

/// Default annual base reward rate: 5% per year.
pub const DEFAULT_BASE_RATE_BPS: u32 = 500;
/// Default accrual period: 1 week.
pub const DEFAULT_ACCRUAL_PERIOD_SECONDS: u64 = 604_800;
/// Default streak period: 1 week.
pub const DEFAULT_STREAK_PERIOD_SECONDS: u64 = 604_800;
/// Default bonus per streak period: 100 bps (1% of principal).
pub const DEFAULT_STREAK_BONUS_BPS_PER_PERIOD: u32 = 100;
/// Default max streak bonus: 500 bps (5%, i.e. 5 consecutive periods max).
pub const DEFAULT_STREAK_BONUS_CAP_BPS: u32 = 500;
/// Default loyalty cap: 20_000 bps (2.0×).
pub const DEFAULT_LOYALTY_CAP_BPS: u32 = 20_000;

/// 1.0× in basis points.
const ONE_X_BPS: u32 = 10_000;

// ---------------------------------------------------------------------------
// Default loyalty tiers (30 / 90 / 180 days)
// ---------------------------------------------------------------------------

pub const TIER_1_SECONDS: u64 = 30 * 86_400; // 30 days
pub const TIER_2_SECONDS: u64 = 90 * 86_400; // 90 days
pub const TIER_3_SECONDS: u64 = 180 * 86_400; // 180 days
pub const TIER_1_MULTIPLIER_BPS: u32 = 11_000; // 1.1×
pub const TIER_2_MULTIPLIER_BPS: u32 = 12_500; // 1.25×
pub const TIER_3_MULTIPLIER_BPS: u32 = 15_000; // 1.5×

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/// Return the current rewards config, or a sensible default if never set.
pub fn get_config(env: &Env) -> RewardsConfig {
    env.storage()
        .instance()
        .get(&DataKey::RewardsConfig)
        .unwrap_or_else(|| default_config(env))
}

fn default_config(env: &Env) -> RewardsConfig {
    let mut tiers: Vec<LoyaltyTier> = Vec::new(env);
    tiers.push_back(LoyaltyTier {
        min_seconds: TIER_1_SECONDS,
        multiplier_bps: TIER_1_MULTIPLIER_BPS,
    });
    tiers.push_back(LoyaltyTier {
        min_seconds: TIER_2_SECONDS,
        multiplier_bps: TIER_2_MULTIPLIER_BPS,
    });
    tiers.push_back(LoyaltyTier {
        min_seconds: TIER_3_SECONDS,
        multiplier_bps: TIER_3_MULTIPLIER_BPS,
    });
    RewardsConfig {
        base_rate_bps: DEFAULT_BASE_RATE_BPS,
        accrual_period_seconds: DEFAULT_ACCRUAL_PERIOD_SECONDS,
        loyalty_tiers: tiers,
        loyalty_cap_bps: DEFAULT_LOYALTY_CAP_BPS,
        streak_bonus_bps_per_period: DEFAULT_STREAK_BONUS_BPS_PER_PERIOD,
        streak_bonus_cap_bps: DEFAULT_STREAK_BONUS_CAP_BPS,
        streak_period_seconds: DEFAULT_STREAK_PERIOD_SECONDS,
    }
}

/// Admin-only: set rewards configuration. Validates all fields.
///
/// Validation rules:
/// - `base_rate_bps ≤ 10_000` (≤ 100% annual)
/// - `accrual_period_seconds > 0`
/// - `streak_period_seconds > 0`
/// - `loyalty_cap_bps ≥ 10_000` (cap ≥ 1.0×)
/// - loyalty tiers sorted ascending by `min_seconds`, each `multiplier_bps ≤ loyalty_cap_bps`
/// - at most 4 loyalty tiers
///
/// Errors: `NotInitialized`, `Unauthorized`, `InvalidRewardConfig`.
pub fn set_config(env: &Env, caller: Address, config: RewardsConfig) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != admin {
        return Err(Error::Unauthorized);
    }

    validate_config(env, &config)?;

    env.storage()
        .instance()
        .set(&DataKey::RewardsConfig, &config);

    env.events().publish(
        (TOPIC_REWARD_CONFIG_SET,),
        (caller, env.ledger().timestamp()),
    );

    Ok(())
}

fn validate_config(env: &Env, config: &RewardsConfig) -> Result<(), Error> {
    if config.base_rate_bps > 10_000 {
        return Err(Error::InvalidRewardConfig);
    }
    if config.accrual_period_seconds == 0 {
        return Err(Error::InvalidRewardConfig);
    }
    if config.streak_period_seconds == 0 {
        return Err(Error::InvalidRewardConfig);
    }
    if config.loyalty_cap_bps < ONE_X_BPS {
        return Err(Error::InvalidRewardConfig);
    }
    if config.loyalty_tiers.len() > 4 {
        return Err(Error::InvalidRewardConfig);
    }
    // Tiers must be sorted ascending by min_seconds; each multiplier ≤ cap.
    let mut prev_seconds: u64 = 0;
    for i in 0..config.loyalty_tiers.len() {
        let tier = config.loyalty_tiers.get(i).unwrap();
        if tier.min_seconds <= prev_seconds {
            return Err(Error::InvalidRewardConfig);
        }
        if tier.multiplier_bps > config.loyalty_cap_bps {
            return Err(Error::InvalidRewardConfig);
        }
        prev_seconds = tier.min_seconds;
    }
    let _ = env; // env used for Vec ops above; suppress unused warning
    Ok(())
}

// ---------------------------------------------------------------------------
// Pool funding
// ---------------------------------------------------------------------------

/// Admin-only: deposit `amount` tokens into the reward pool.
///
/// The caller must be the admin. Tokens are transferred from `caller` into
/// the contract. The pool balance is incremented.
///
/// Errors: `NotInitialized`, `Unauthorized`, `InvalidAmount`.
pub fn fund_pool(env: &Env, caller: Address, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != admin {
        return Err(Error::Unauthorized);
    }

    storage::transfer_in(env, &caller, amount)?; // validates amount > 0

    let current: i128 = env
        .storage()
        .instance()
        .get(&DataKey::RewardPoolBalance)
        .unwrap_or(0);
    let new_balance = current.checked_add(amount).ok_or(Error::Overflow)?;
    env.storage()
        .instance()
        .set(&DataKey::RewardPoolBalance, &new_balance);

    env.events().publish(
        (TOPIC_REWARD_FUNDED,),
        (caller, amount, new_balance, env.ledger().timestamp()),
    );

    Ok(())
}

/// Current reward pool balance (read-only, no auth required).
pub fn pool_balance(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::RewardPoolBalance)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Streak helpers
// ---------------------------------------------------------------------------

/// Called from `interest_deposit`, `interest_withdraw`, and `reward_ping` to
/// record that the user is active in the current streak period.
///
/// Does nothing if the user has no `RewardState` yet (first touch before any
/// accrual). In that case, the state is created lazily on first `accrue`.
pub fn note_touch(env: &Env, owner: &Address) {
    let key = DataKey::RewardState(owner.clone());
    let mut state: RewardState = match env.storage().persistent().get(&key) {
        Some(s) => s,
        None => return, // not yet initialized — accrue will create it
    };

    // Only call extend_persistent_ttl when the key actually exists.
    let now = env.ledger().timestamp();
    let config = get_config(env);

    // If we are within the current streak period (inclusive end), mark it kept.
    let period_end = state
        .streak_period_start
        .saturating_add(config.streak_period_seconds);
    if now <= period_end {
        state.streak_period_kept = true;
        env.storage().persistent().set(&key, &state);
        extend_persistent_ttl(env, &key);
    }
    // If the period has already elapsed, we don't advance here — accrue does
    // the authoritative streak update.
}

/// Explicit user ping: records activity in the current streak period without
/// accruing rewards. Requires the user's auth.
///
/// Errors: `NotInitialized`, `NotFound` if the user has no interest account.
pub fn ping(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    owner.require_auth();

    // Must have an interest account to be eligible.
    let ia_key = DataKey::InterestAccount(owner.clone());
    let account: InterestAccount = env
        .storage()
        .persistent()
        .get(&ia_key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &ia_key);

    let now = env.ledger().timestamp();
    let config = get_config(env);

    let key = DataKey::RewardState(owner.clone());
    let mut state: RewardState = env.storage().persistent().get(&key).unwrap_or(RewardState {
        owner: owner.clone(),
        pending: 0,
        last_accrued_at: account.created_at,
        streak: 0,
        streak_period_start: account.created_at,
        streak_period_kept: false,
    });
    // Don't extend TTL before writing; we set it below after the write.

    // Mark current period kept if we're still inside it (inclusive end).
    let period_end = state
        .streak_period_start
        .saturating_add(config.streak_period_seconds);
    if now <= period_end {
        state.streak_period_kept = true;
    }

    env.storage().persistent().set(&key, &state);
    extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_STREAK_UPDATED, owner.clone()),
        (owner, state.streak, state.streak_period_kept, now),
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Loyalty multiplier
// ---------------------------------------------------------------------------

/// Compute the loyalty multiplier in basis points for a given hold age
/// (in seconds). Returns a value in `[10_000, loyalty_cap_bps]`.
pub fn loyalty_multiplier_bps(hold_seconds: u64, config: &RewardsConfig) -> u32 {
    let mut best: u32 = ONE_X_BPS;
    for i in 0..config.loyalty_tiers.len() {
        let tier = config.loyalty_tiers.get(i).unwrap();
        if hold_seconds >= tier.min_seconds {
            best = tier.multiplier_bps;
        } else {
            break; // tiers are sorted; no point scanning further
        }
    }
    best.min(config.loyalty_cap_bps)
}

// ---------------------------------------------------------------------------
// Streak bonus
// ---------------------------------------------------------------------------

/// Compute the streak bonus in basis points for the given streak count.
/// Returns a value in `[0, streak_bonus_cap_bps]`.
pub fn streak_bonus_bps(streak: u32, config: &RewardsConfig) -> u32 {
    let raw = (streak as u64).saturating_mul(config.streak_bonus_bps_per_period as u64);
    // cap to u32 range then to config cap
    let raw_u32: u32 = raw.min(u32::MAX as u64) as u32;
    raw_u32.min(config.streak_bonus_cap_bps)
}

// ---------------------------------------------------------------------------
// Reward computation (pure, no storage writes)
// ---------------------------------------------------------------------------

/// Compute the reward for a single accrual period, given the user's principal.
///
/// ```text
/// base     = floor(principal × base_rate_bps / 10_000)
/// reward   = floor(base × loyalty_bps / 10_000)
///          + floor(principal × streak_b_bps / 10_000)
/// ```
///
/// Errors: `Overflow` if any intermediate product does not fit in `i128`.
fn compute_period_reward(
    env: &Env,
    principal: i128,
    loyalty_bps: u32,
    streak_b_bps: u32,
    config: &RewardsConfig,
) -> Result<i128, Error> {
    if principal <= 0 {
        return Ok(0);
    }
    // base = principal × base_rate_bps / 10_000  (floor)
    let base = mul_div_floor(
        env,
        principal,
        config.base_rate_bps as i128,
        ONE_X_BPS as i128,
    )?;
    // loyalty component = floor(base × loyalty_bps / 10_000)
    let loyalty_part = mul_div_floor(env, base, loyalty_bps as i128, ONE_X_BPS as i128)?;
    // streak component = floor(principal × streak_b_bps / 10_000)
    let streak_part = mul_div_floor(env, principal, streak_b_bps as i128, ONE_X_BPS as i128)?;
    loyalty_part.checked_add(streak_part).ok_or(Error::Overflow)
}

// ---------------------------------------------------------------------------
// Accrue
// ---------------------------------------------------------------------------

/// Settle all elapsed accrual periods into `pending` for `owner`.
///
/// This is idempotent between periods: a second call before the next period
/// elapses adds nothing. Streak is updated: each elapsed accrual period that
/// was "kept" increments the streak; a missed period resets it to 0.
///
/// The user must have an interest account. If no `RewardState` exists yet,
/// one is created initialised at the current time.
///
/// `owner.require_auth()` is not required here — anyone can trigger accrual
/// on behalf of a user (it only adds to their pending balance, never removes).
///
/// Errors: `NotFound` if no interest account, `Overflow`.
pub fn accrue(env: &Env, owner: Address) -> Result<i128, Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;

    // Require an interest account to exist; if not, earn nothing (no error).
    let ia_key = DataKey::InterestAccount(owner.clone());
    let account: InterestAccount = match env.storage().persistent().get(&ia_key) {
        Some(a) => {
            extend_persistent_ttl(env, &ia_key);
            a
        }
        None => return Ok(0),
    };

    let now = env.ledger().timestamp();
    let config = get_config(env);

    // Load or create RewardState.
    let key = DataKey::RewardState(owner.clone());
    let state_existed = env.storage().persistent().has(&key);
    let mut state: RewardState = env.storage().persistent().get(&key).unwrap_or(RewardState {
        owner: owner.clone(),
        pending: 0,
        // Anchor accrual to when the interest account was opened, so the
        // first accrue call correctly counts periods since deposit.
        last_accrued_at: account.created_at,
        streak: 0,
        streak_period_start: account.created_at,
        streak_period_kept: false,
    });
    if state_existed {
        extend_persistent_ttl(env, &key);
    }

    // How many whole accrual periods have elapsed?
    let elapsed = now.saturating_sub(state.last_accrued_at);
    let periods = elapsed / config.accrual_period_seconds;
    if periods == 0 {
        // Nothing to accrue — persist to record any streak update from note_touch.
        env.storage().persistent().set(&key, &state);
        extend_persistent_ttl(env, &key);
        return Ok(0);
    }

    // Hold age = seconds since the interest account was created.
    let hold_age = now.saturating_sub(account.created_at);
    let loyalty_bps = loyalty_multiplier_bps(hold_age, &config);

    // Accrue period by period, updating streak each time.
    let mut total_accrued: i128 = 0;

    for p in 0..periods {
        let period_start = state
            .last_accrued_at
            .saturating_add(p.saturating_mul(config.accrual_period_seconds));
        let period_end = period_start.saturating_add(config.accrual_period_seconds);

        // Does the current streak window cover this accrual period?
        let streak_window_end = state
            .streak_period_start
            .saturating_add(config.streak_period_seconds);

        // If the streak window has expired before this period ended, roll it
        // forward and treat the rolled-over window as unkept.
        if period_end > streak_window_end {
            let streak_elapsed = period_end.saturating_sub(state.streak_period_start);
            let windows_elapsed = streak_elapsed / config.streak_period_seconds;
            // The previous window ended without being kept → reset.
            state.streak = 0;
            state.streak_period_start = state
                .streak_period_start
                .saturating_add(windows_elapsed.saturating_mul(config.streak_period_seconds));
            state.streak_period_kept = false;
        } else {
            // Period falls within the current streak window.
            if state.streak_period_kept {
                state.streak = state.streak.saturating_add(1);
                // Advance to the next streak window for subsequent periods.
                state.streak_period_start = state
                    .streak_period_start
                    .saturating_add(config.streak_period_seconds);
                state.streak_period_kept = false;
            } else {
                state.streak = 0;
            }
        }

        let s_bps = streak_bonus_bps(state.streak, &config);
        let period_reward =
            compute_period_reward(env, account.principal, loyalty_bps, s_bps, &config)?;
        total_accrued = total_accrued
            .checked_add(period_reward)
            .ok_or(Error::Overflow)?;
    }

    // Advance last_accrued_at by exactly the number of whole periods.
    state.last_accrued_at = state
        .last_accrued_at
        .saturating_add(periods.saturating_mul(config.accrual_period_seconds));
    state.pending = state
        .pending
        .checked_add(total_accrued)
        .ok_or(Error::Overflow)?;

    env.storage().persistent().set(&key, &state);
    extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_REWARD_ACCRUED, owner.clone()),
        (owner, total_accrued, state.pending, now),
    );

    Ok(total_accrued)
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/// Claim pending rewards. Settles any un-accrued periods first, then pays
/// out `min(pending, pool_balance)` to `owner`. If the pool is short, pays
/// whatever is available and leaves the remainder in `pending`.
///
/// Returns the amount actually paid out.
///
/// `owner.require_auth()` — only the account owner may trigger a payout.
///
/// Errors: `NotFound` if no interest account, `Overflow`.
pub fn claim(env: &Env, owner: Address) -> Result<i128, Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    owner.require_auth();

    // Settle first.
    accrue(env, owner.clone())?;

    let key = DataKey::RewardState(owner.clone());
    let mut state: RewardState = env.storage().persistent().get(&key).unwrap_or(RewardState {
        owner: owner.clone(),
        pending: 0,
        last_accrued_at: env.ledger().timestamp(),
        streak: 0,
        streak_period_start: env.ledger().timestamp(),
        streak_period_kept: false,
    });
    if env.storage().persistent().has(&key) {
        extend_persistent_ttl(env, &key);
    }

    let pending = state.pending;
    if pending <= 0 {
        // Nothing pending — persist the state only if it already exists
        // (i.e., accrue created it). Don't create a zero-pending entry.
        if env.storage().persistent().has(&key) {
            env.storage().persistent().set(&key, &state);
            extend_persistent_ttl(env, &key);
        }
        return Ok(0);
    }

    // How much can we pay from the pool?
    let pool: i128 = env
        .storage()
        .instance()
        .get(&DataKey::RewardPoolBalance)
        .unwrap_or(0);
    let payout = pending.min(pool);

    if payout <= 0 {
        // Pool is empty — nothing to pay, but don't error.
        return Ok(0);
    }

    // Debit pool, credit user.
    let new_pool = pool.checked_sub(payout).ok_or(Error::Overflow)?;
    env.storage()
        .instance()
        .set(&DataKey::RewardPoolBalance, &new_pool);

    storage::transfer_out(env, &owner, payout)?;

    let now = env.ledger().timestamp();
    state.pending = state.pending.checked_sub(payout).ok_or(Error::Overflow)?;
    env.storage().persistent().set(&key, &state);
    extend_persistent_ttl(env, &key);
    env.events().publish(
        (TOPIC_REWARD_CLAIMED, owner.clone()),
        (owner, payout, state.pending, new_pool, now),
    );

    Ok(payout)
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

/// Read-only view of a user's reward state. Returns `None` if the user has
/// never interacted with the rewards system.
pub fn get_reward_state(env: &Env, owner: Address) -> Option<RewardState> {
    let key = DataKey::RewardState(owner);
    let state = env.storage().persistent().get(&key)?;
    extend_persistent_ttl(env, &key);
    Some(state)
}

/// Preview how much would be accrued right now without writing anything.
///
/// Returns `0` if the user has no interest account or no RewardState yet.
pub fn accrued_preview(env: &Env, owner: Address) -> Result<i128, Error> {
    // Require interest account.
    let ia_key = DataKey::InterestAccount(owner.clone());
    let account: InterestAccount = match env.storage().persistent().get(&ia_key) {
        Some(a) => a,
        None => return Ok(0),
    };
    extend_persistent_ttl(env, &ia_key);

    let key = DataKey::RewardState(owner.clone());
    let state: RewardState = match env.storage().persistent().get(&key) {
        Some(s) => s,
        None => return Ok(0),
    };
    extend_persistent_ttl(env, &key);

    let now = env.ledger().timestamp();
    let config = get_config(env);

    let elapsed = now.saturating_sub(state.last_accrued_at);
    let periods = elapsed / config.accrual_period_seconds;
    if periods == 0 {
        return Ok(0);
    }

    let hold_age = now.saturating_sub(account.created_at);
    let loyalty_bps = loyalty_multiplier_bps(hold_age, &config);
    let s_bps = streak_bonus_bps(state.streak, &config);

    let mut total: i128 = 0;
    for _ in 0..periods {
        let period_reward =
            compute_period_reward(env, account.principal, loyalty_bps, s_bps, &config)?;
        total = total.checked_add(period_reward).ok_or(Error::Overflow)?;
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Arithmetic helper (mirrors interest.rs — kept local to avoid coupling)
// ---------------------------------------------------------------------------

/// `a * b / denominator`, rounded down, using 256-bit intermediate.
/// Errors `Overflow` if denominator == 0 or quotient does not fit in i128.
fn mul_div_floor(env: &Env, a: i128, b: i128, denominator: i128) -> Result<i128, Error> {
    use soroban_sdk::I256;
    if denominator == 0 {
        return Err(Error::Overflow);
    }
    let product = I256::from_i128(env, a).mul(&I256::from_i128(env, b));
    product
        .div(&I256::from_i128(env, denominator))
        .to_i128()
        .ok_or(Error::Overflow)
}
