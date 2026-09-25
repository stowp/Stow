//! Deposits — convert vault-token in for shares of the adapter.

use soroban_sdk::{Address, Env};

use crate::accounting;
use crate::admin;
use crate::error::Error;
use crate::events;
use crate::storage::{self, extend_instance_ttl};
use crate::strategy;
use crate::types::{DataKey, Position};

/// Deposit `amount` of the vault token, minting shares to `from` at the
/// current exchange rate.
///
/// - `from.require_auth()`.
/// - Errors `Error::Paused` while paused (see `admin::set_paused`).
/// - Errors `Error::InvalidAmount` if `amount <= 0`.
/// - Errors `Error::StrategyCapExceeded` if the active strategy has a
///   nonzero deposit cap and the resulting total deployed balance would
///   exceed it.
/// - Shares minted = `accounting::convert_to_shares(amount)`, computed
///   **before** `amount` is transferred in (so the deposit itself does not
///   move the exchange rate against the depositor).
/// - Transfers `amount` in, then forwards it to the active strategy (if
///   any); with no active strategy, funds sit idle in the adapter and
///   accrue no yield until one is set.
/// - Creates the position on first deposit; increments `shares` otherwise.
/// - Errors `Error::InvalidAmount` if `amount` is so small relative to the
///   exchange rate that it would mint `0` shares (the deposit would be a
///   pure donation to existing shareholders).
/// - Errors `Error::Overflow` if any share/asset computation overflows
///   `i128` (see `accounting`'s "Overflow safety").
/// - Emits a `deposited` event.
///
/// Returns the number of shares minted.
pub fn deposit(env: &Env, from: Address, amount: i128) -> Result<i128, Error> {
    extend_instance_ttl(env);
    from.require_auth();
    admin::require_not_paused(env)?;

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    // Price the deposit before any funds move, so the deposit itself does
    // not shift the exchange rate against the depositor.
    let shares = accounting::convert_to_shares(env, amount)?;
    if shares == 0 {
        return Err(Error::InvalidAmount);
    }

    let active = strategy::active_strategy(env);
    if let Some(info) = &active {
        if info.deposit_cap > 0 {
            let deployed_after = strategy::strategy_balance(env, &info.address)
                .checked_add(amount)
                .ok_or(Error::Overflow)?;
            if deployed_after > info.deposit_cap {
                return Err(Error::StrategyCapExceeded);
            }
        }
    }

    let new_total_shares = accounting::total_shares(env)
        .checked_add(shares)
        .ok_or(Error::Overflow)?;

    let now = env.ledger().timestamp();
    let key = DataKey::Position(from.clone());
    let mut position: Position = env.storage().persistent().get(&key).unwrap_or(Position {
        owner: from.clone(),
        shares: 0,
        created_at: now,
        updated_at: now,
    });
    let new_position_shares = position.shares.checked_add(shares).ok_or(Error::Overflow)?;

    storage::transfer_in(env, &from, amount)?;
    if let Some(info) = &active {
        strategy::deploy_to_strategy(env, &info.address, amount)?;
    }

    position.shares = new_position_shares;
    position.updated_at = now;
    env.storage().persistent().set(&key, &position);
    storage::extend_persistent_ttl(env, &key);
    accounting::set_total_shares(env, new_total_shares);

    events::publish_deposited(env, &from, amount, shares, new_position_shares);

    Ok(shares)
}

/// Read `owner`'s position, or `Error::NotFound`.
pub fn get_position(env: &Env, owner: Address) -> Result<Position, Error> {
    let key = DataKey::Position(owner);
    let position = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(position)
}
