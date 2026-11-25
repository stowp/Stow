//! Profit sharing — split an interest account's earnings among stakeholders.
//!
//! An interest-account owner calls [`configure`] with a list of stakeholder
//! addresses, a parallel list of shares in basis points (summing to exactly
//! 10 000, i.e. 100%), and a [`DistributionFrequency`].
//!
//! ## Accounting
//!
//! Every time interest is credited to the owner's [`InterestAccount`]
//! (on deposit, withdraw, claim, or a distribution), [`record_earned`] adds
//! the credited amount to the config's `undistributed` bucket. Interest that
//! accrued *before* profit sharing was configured is settled to the owner at
//! configuration time and is never shared.
//!
//! ## Distribution
//!
//! [`distribute`] is permissionless — anyone (a keeper, a stakeholder, the
//! owner) may trigger it once the current period has elapsed, so payouts
//! happen automatically on schedule without the owner's signature. It:
//!
//! 1. settles interest accrued up to now,
//! 2. splits `undistributed` by `shares_bps`, rounding each share **down**;
//!    the rounding dust is carried forward to the next period, so nothing is
//!    lost and the contract never over-pays,
//! 3. debits the paid total from the owner's interest principal and
//!    transfers each share to its stakeholder,
//! 4. adds each payout to the stakeholder's lifetime `distributed` total,
//! 5. advances `last_distributed_at` by whole periods (partial-period time
//!    carries forward), and
//! 6. emits `ProfitDistributed`.
//!
//! ## Updates
//!
//! Re-calling [`configure`] on an existing config does **not** change the
//! period in progress: the new shares/frequency are stored as `pending` and
//! take effect immediately after the next distribution. Interest earned in
//! the current period is therefore always split under the shares that were
//! in force when that period began.
//!
//! [`InterestAccount`]: crate::types::InterestAccount

use soroban_sdk::{Address, Env, Map, Vec};

use crate::admin::require_not_paused;
use crate::error::Error;
use crate::events::{TOPIC_PROFIT_DISTRIBUTED, TOPIC_PROFIT_SHARE_CONFIGURED};
use crate::interest;
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, DistributionFrequency, PendingProfitShare, ProfitShareConfig};

/// 100% expressed in basis points. Shares must sum to exactly this.
pub const TOTAL_SHARE_BPS: u32 = 10_000;

/// Upper bound on stakeholders per config, keeping distribution gas bounded.
pub const MAX_STAKEHOLDERS: u32 = 20;

/// Configure (or update) profit sharing for `owner`'s interest account.
///
/// On first configuration the config is active immediately and the first
/// distribution period starts now. On an existing config the update is
/// queued as `pending` and applies from the next period (see module docs).
///
/// Errors: `NotFound` if `owner` has no interest account,
/// `InvalidProfitShares` if the shares are malformed (see [`validate`]).
pub fn configure(
    env: &Env,
    owner: Address,
    stakeholders: Vec<Address>,
    shares_bps: Vec<u32>,
    frequency: DistributionFrequency,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    owner.require_auth();

    validate(&stakeholders, &shares_bps)?;

    let key = DataKey::ProfitShare(owner.clone());
    let existing: Option<ProfitShareConfig> = env.storage().persistent().get(&key);
    let now = env.ledger().timestamp();

    // Settle first: on a new config this pays pre-config interest to the
    // owner (record_earned is a no-op while unconfigured); on an update it
    // earmarks interest accrued so far under the shares currently in force.
    interest::settle_account(env, &owner)?;

    let is_update = existing.is_some();
    let config = match existing {
        Some(_) => {
            // Reload: settle_account may have updated `undistributed`.
            let mut config: ProfitShareConfig =
                env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
            config.pending = Some(PendingProfitShare {
                stakeholders: stakeholders.clone(),
                shares_bps: shares_bps.clone(),
                frequency,
            });
            config.updated_at = now;
            config
        }
        None => ProfitShareConfig {
            owner: owner.clone(),
            stakeholders: stakeholders.clone(),
            shares_bps: shares_bps.clone(),
            frequency,
            last_distributed_at: now,
            undistributed: 0,
            distributed: Map::new(env),
            distribution_count: 0,
            pending: None,
            created_at: now,
            updated_at: now,
        },
    };

    env.storage().persistent().set(&key, &config);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_PROFIT_SHARE_CONFIGURED, owner.clone()),
        (owner, stakeholders, shares_bps, frequency, is_update, now),
    );

    Ok(())
}

/// Check a stakeholder/share list: non-empty, at most [`MAX_STAKEHOLDERS`],
/// parallel lengths, no zero share, no duplicate address, and a sum of
/// exactly [`TOTAL_SHARE_BPS`].
pub fn validate(stakeholders: &Vec<Address>, shares_bps: &Vec<u32>) -> Result<(), Error> {
    let len = stakeholders.len();
    if len == 0 || len > MAX_STAKEHOLDERS || len != shares_bps.len() {
        return Err(Error::InvalidProfitShares);
    }

    let mut total: u32 = 0;
    for i in 0..len {
        let share = shares_bps.get_unchecked(i);
        if share == 0 {
            return Err(Error::InvalidProfitShares);
        }
        total = total
            .checked_add(share)
            .ok_or(Error::InvalidProfitShares)?;

        let addr = stakeholders.get_unchecked(i);
        for j in (i + 1)..len {
            if stakeholders.get_unchecked(j) == addr {
                return Err(Error::InvalidProfitShares);
            }
        }
    }

    if total != TOTAL_SHARE_BPS {
        return Err(Error::InvalidProfitShares);
    }
    Ok(())
}

/// Earmark `credited` interest for `owner`'s stakeholders. Called by the
/// interest module whenever it folds interest into an account's principal.
/// A no-op when `owner` has no profit-share config or `credited <= 0`.
pub(crate) fn record_earned(env: &Env, owner: &Address, credited: i128) -> Result<(), Error> {
    if credited <= 0 {
        return Ok(());
    }
    let key = DataKey::ProfitShare(owner.clone());
    let Some(mut config) = env
        .storage()
        .persistent()
        .get::<_, ProfitShareConfig>(&key)
    else {
        return Ok(());
    };
    config.undistributed = config
        .undistributed
        .checked_add(credited)
        .ok_or(Error::Overflow)?;
    env.storage().persistent().set(&key, &config);
    storage::extend_persistent_ttl(env, &key);
    Ok(())
}

/// Split `owner`'s accumulated interest among the configured stakeholders.
///
/// Permissionless; succeeds only once the current period has elapsed.
/// Returns the total amount paid out (possibly `0` if no interest was
/// earned). See the module docs for the full sequence.
///
/// Errors: `NotFound` if no config or interest account exists,
/// `DistributionNotDue` if the period has not elapsed, `Overflow`,
/// `InsufficientBalance`, plus collateral and transfer errors.
pub fn distribute(env: &Env, owner: Address) -> Result<i128, Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;

    let key = DataKey::ProfitShare(owner.clone());
    if !env.storage().persistent().has(&key) {
        return Err(Error::NotFound);
    }

    let now = env.ledger().timestamp();
    {
        let config: ProfitShareConfig =
            env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
        let period = config.frequency.period_seconds();
        if now.saturating_sub(config.last_distributed_at) < period {
            return Err(Error::DistributionNotDue);
        }
    }

    // Fold interest accrued up to now into `undistributed`.
    interest::settle_account(env, &owner)?;

    let mut config: ProfitShareConfig =
        env.storage().persistent().get(&key).ok_or(Error::NotFound)?;

    let total = config.undistributed;
    let mut amounts: Vec<i128> = Vec::new(env);
    let mut paid: i128 = 0;
    for i in 0..config.stakeholders.len() {
        let share = config.shares_bps.get_unchecked(i) as i128;
        let amount = total
            .checked_mul(share)
            .ok_or(Error::Overflow)?
            / TOTAL_SHARE_BPS as i128;
        amounts.push_back(amount);
        paid = paid.checked_add(amount).ok_or(Error::Overflow)?;
    }
    let carried_forward = total.checked_sub(paid).ok_or(Error::Overflow)?;

    if paid > 0 {
        interest::debit_for_profit_share(env, &owner, paid)?;
    }

    for i in 0..config.stakeholders.len() {
        let amount = amounts.get_unchecked(i);
        if amount == 0 {
            continue;
        }
        let stakeholder = config.stakeholders.get_unchecked(i);
        storage::transfer_out(env, &stakeholder, amount)?;
        let prior = config.distributed.get(stakeholder.clone()).unwrap_or(0);
        config.distributed.set(
            stakeholder,
            prior.checked_add(amount).ok_or(Error::Overflow)?,
        );
    }

    // Advance by whole elapsed periods of the frequency in force.
    let period = config.frequency.period_seconds();
    let periods = now.saturating_sub(config.last_distributed_at) / period;
    config.last_distributed_at = periods
        .checked_mul(period)
        .and_then(|elapsed| config.last_distributed_at.checked_add(elapsed))
        .ok_or(Error::Overflow)?;

    let stakeholders = config.stakeholders.clone();

    config.undistributed = carried_forward;
    config.distribution_count = config.distribution_count.saturating_add(1);
    config.updated_at = now;

    // A queued update takes effect from the next period onward.
    if let Some(pending) = config.pending.take() {
        config.stakeholders = pending.stakeholders;
        config.shares_bps = pending.shares_bps;
        config.frequency = pending.frequency;
        // The new period starts now so a changed frequency measures from here.
        config.last_distributed_at = now;
    }

    env.storage().persistent().set(&key, &config);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_PROFIT_DISTRIBUTED, owner.clone()),
        (
            owner,
            paid,
            stakeholders,
            amounts,
            carried_forward,
            config.distribution_count,
            now,
        ),
    );

    Ok(paid)
}

/// Read `owner`'s profit-share config, if any.
pub fn get_config(env: &Env, owner: Address) -> Option<ProfitShareConfig> {
    let key = DataKey::ProfitShare(owner);
    let config = env.storage().persistent().get(&key);
    if config.is_some() {
        storage::extend_persistent_ttl(env, &key);
    }
    config
}

/// Lifetime amount paid to `stakeholder` from `owner`'s profit sharing.
/// `0` if either is unknown.
pub fn distributed_to(env: &Env, owner: Address, stakeholder: Address) -> i128 {
    get_config(env, owner)
        .and_then(|config| config.distributed.get(stakeholder))
        .unwrap_or(0)
}
