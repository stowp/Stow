//! Automatic savings round-ups (issue #622).
//!
//! An owner opts in with [`enable`] and picks a [`RoundupLevel`]. Each
//! external transaction reported through [`record_transaction`] is rounded up
//! to the next multiple of the level's step. The difference is deposited into
//! the owner's flexible savings and a `RoundupDeposit` event is emitted.
//!
//! Round-ups can be turned off with [`disable`] and back on with [`enable`];
//! the running totals survive both. While disabled, reported transactions are
//! ignored.
//!
//! If the owner's token balance cannot cover a difference, the transaction is
//! still tracked but nothing is deposited: the difference is added to
//! `skipped_total`, a `RoundupSkipped` event is emitted and `0` is returned.
//! The call does not fail, so a short balance never blocks reporting.
//!
//! The owner authorizes each call, so the difference is taken from the
//! owner's own token balance, the same as a manual deposit.

use soroban_sdk::{token, Address, Env};

use crate::error::Error;
use crate::events::{
    TOPIC_ROUNDUP_DEPOSIT, TOPIC_ROUNDUP_DISABLED, TOPIC_ROUNDUP_ENABLED, TOPIC_ROUNDUP_SKIPPED,
};
use crate::storage::{extend_instance_ttl, extend_persistent_ttl, get_token};
use crate::types::{DataKey, RoundupConfig, RoundupLevel};

pub(crate) fn step(level: RoundupLevel) -> i128 {
    match level {
        RoundupLevel::Nearest1 => 1,
        RoundupLevel::Nearest5 => 5,
        RoundupLevel::Nearest10 => 10,
    }
}

/// Amount needed to round `amount` up to the next multiple of the level's step.
///
/// Returns `0` when `amount` is already a multiple of the step.
pub fn roundup_difference(amount: i128, level: RoundupLevel) -> Result<i128, Error> {
    let step = step(level);
    let remainder = amount.checked_rem(step).ok_or(Error::DivisionByZero)?;
    Ok(if remainder == 0 { 0 } else { step - remainder })
}

fn load(env: &Env, owner: &Address) -> Option<RoundupConfig> {
    let key = DataKey::Roundup(owner.clone());
    let config = env.storage().persistent().get(&key);
    if config.is_some() {
        extend_persistent_ttl(env, &key);
    }
    config
}

fn store(env: &Env, config: &RoundupConfig) {
    let key = DataKey::Roundup(config.owner.clone());
    env.storage().persistent().set(&key, config);
    extend_persistent_ttl(env, &key);
}

/// Turn on round-ups for `owner` at `level`. Re-enabling changes the level
/// and keeps the running totals.
pub fn enable(env: &Env, owner: Address, level: RoundupLevel) -> Result<(), Error> {
    extend_instance_ttl(env);
    crate::admin::require_not_paused(env)?;
    owner.require_auth();

    let config = match load(env, &owner) {
        Some(mut existing) => {
            existing.level = level;
            existing.enabled = true;
            existing
        }
        None => RoundupConfig {
            owner: owner.clone(),
            level,
            enabled: true,
            tracked_total: 0,
            deposited_total: 0,
            skipped_total: 0,
        },
    };
    store(env, &config);
    env.events()
        .publish((TOPIC_ROUNDUP_ENABLED, owner), step(level));
    Ok(())
}

/// Turn off round-ups for `owner`. The configuration and totals are kept so
/// [`enable`] can turn them back on.
///
/// # Errors
/// - [`Error::NotFound`] if the owner never enabled round-ups.
pub fn disable(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    let mut config = load(env, &owner).ok_or(Error::NotFound)?;
    if config.enabled {
        config.enabled = false;
        store(env, &config);
        env.events().publish((TOPIC_ROUNDUP_DISABLED, owner), ());
    }
    Ok(())
}

/// Read `owner`'s round-up configuration and totals.
///
/// # Errors
/// - [`Error::NotFound`] if the owner never enabled round-ups.
pub fn get_config(env: &Env, owner: Address) -> Result<RoundupConfig, Error> {
    load(env, &owner).ok_or(Error::NotFound)
}

/// Record an external transaction of `amount` for `owner`, and deposit its
/// round-up difference into the owner's flexible savings.
///
/// Returns the amount deposited. That is zero when `amount` is already a
/// multiple of the owner's step, when round-ups are disabled (the
/// transaction is then not tracked), or when the owner's token balance
/// cannot cover the difference (tracked, and counted in `skipped_total`).
///
/// # Errors
/// - [`Error::InvalidAmount`]  if `amount` is not positive.
/// - [`Error::NotFound`]       if the owner never enabled round-ups.
/// - [`Error::NotInitialized`] if the vault token is not configured.
/// - Any error from the flexible deposit (pause, emergency, deposit limits).
pub fn record_transaction(env: &Env, owner: Address, amount: i128) -> Result<i128, Error> {
    extend_instance_ttl(env);
    crate::admin::require_not_paused(env)?;

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let mut config = load(env, &owner).ok_or(Error::NotFound)?;
    if !config.enabled {
        owner.require_auth();
        return Ok(0);
    }
    let difference = roundup_difference(amount, config.level)?;

    config.tracked_total = config
        .tracked_total
        .checked_add(amount)
        .ok_or(Error::Overflow)?;

    if difference == 0 {
        owner.require_auth();
        store(env, &config);
        return Ok(0);
    }

    let token_address = get_token(env).ok_or(Error::NotInitialized)?;
    let available = token::Client::new(env, &token_address).balance(&owner);
    if available < difference {
        owner.require_auth();
        config.skipped_total = config
            .skipped_total
            .checked_add(difference)
            .ok_or(Error::Overflow)?;
        store(env, &config);
        env.events().publish(
            (TOPIC_ROUNDUP_SKIPPED, owner),
            (amount, difference, available),
        );
        return Ok(0);
    }

    // The flexible deposit requires the owner's auth. Calling `require_auth`
    // here as well would fail: Soroban rejects a second authorization of the
    // same address within one invocation.
    crate::flexible::deposit(env, owner.clone(), difference)?;
    config.deposited_total = config
        .deposited_total
        .checked_add(difference)
        .ok_or(Error::Overflow)?;
    store(env, &config);

    let rounded_amount = amount.checked_add(difference).ok_or(Error::Overflow)?;
    env.events().publish(
        (TOPIC_ROUNDUP_DEPOSIT, owner),
        (
            amount,
            rounded_amount,
            difference,
            step(config.level),
            config.deposited_total,
        ),
    );
    Ok(difference)
}
