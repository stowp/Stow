//! Deposits — convert vault-token in for shares of the adapter.

use soroban_sdk::{Address, Env};

use crate::accounting;
use crate::admin;
use crate::error::Error;
use crate::events::TOPIC_DEPOSITED;
use crate::storage::{self, extend_instance_ttl};
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
/// - Emits a `deposited` event.
///
/// Implements the no-active-strategy path only: shares are minted (1:1 on
/// the first deposit, proportionally to the current exchange rate
/// thereafter, via `accounting::convert_to_shares`) and funds are
/// transferred in and left idle (the contract's own custody), exactly the
/// documented fallback behavior above for "with no active strategy". Does
/// **not** implement forwarding to an active strategy or the
/// `StrategyCapExceeded` check — both depend on the unimplemented strategy
/// interface — see PR description.
pub fn deposit(env: &Env, from: Address, amount: i128) -> Result<i128, Error> {
    extend_instance_ttl(env);
    from.require_auth();

    admin::require_not_paused(env)?;

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let shares_minted = accounting::convert_to_shares(env, amount)?;

    storage::transfer_in(env, &from, amount)?;

    let now = env.ledger().timestamp();
    let key = DataKey::Position(from.clone());
    let existing: Option<Position> = env.storage().persistent().get(&key);
    let mut position = existing.unwrap_or(Position {
        owner: from.clone(),
        shares: 0,
        created_at: now,
        updated_at: now,
    });

    position.shares = position
        .shares
        .checked_add(shares_minted)
        .ok_or(Error::Overflow)?;
    position.updated_at = now;
    env.storage().persistent().set(&key, &position);
    storage::extend_persistent_ttl(env, &key);

    let new_total_shares = accounting::total_shares(env)
        .checked_add(shares_minted)
        .ok_or(Error::Overflow)?;
    env.storage()
        .instance()
        .set(&DataKey::TotalShares, &new_total_shares);

    env.events().publish(
        (TOPIC_DEPOSITED, from),
        (amount, shares_minted, position.shares, now),
    );

    Ok(shares_minted)
}

/// Read `owner`'s position, or `Error::NotFound`.
pub fn get_position(env: &Env, owner: Address) -> Result<Position, Error> {
    let key = DataKey::Position(owner);
    env.storage().persistent().get(&key).ok_or(Error::NotFound)
}
