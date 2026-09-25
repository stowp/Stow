//! Share/asset accounting.
//!
//! Positions are denominated in shares, not raw asset amounts, so that
//! `harvest` can grow (or, on a strategy loss, shrink) every depositor's
//! value proportionally by moving a single exchange rate instead of
//! rewriting every `Position` record.
//!
//! ## Rounding direction
//!
//! Rounding must always favor the adapter over the depositor, or repeated
//! deposit/withdraw cycles at the rounding boundary let a depositor extract
//! more value than they put in:
//!
//! - `convert_to_shares` (used by `deposit`): round **down**. A depositor
//!   who deposits an amount that doesn't divide evenly gets slightly fewer
//!   shares, never more.
//! - `convert_to_assets` (used by `request_withdraw`, `claim_withdraw`,
//!   `cancel_withdraw`'s re-mint): round **down**. A withdrawal that doesn't
//!   divide evenly pays out slightly less, never more.
//!
//! ## Overflow safety
//!
//! No arithmetic path here can panic on overflow (issue #249). Additions
//! and subtractions use `checked_*` and map `None` to `Error::Overflow` —
//! the same pattern as `savings-vault`'s `checked_add(..).ok_or(..)`.
//!
//! Share/asset conversion multiplies before dividing (`assets *
//! total_shares / total_assets`) to keep precision, so the intermediate
//! product is the overflow-prone step. Rather than `checked_mul` (which
//! would reject any position above ~1.3e19 stroops, since the product of
//! two such values exceeds `i128::MAX` even when the quotient is small),
//! [`mul_div_floor`] computes the product in the host's 256-bit `I256`,
//! where the product of any two `i128`s always fits, and only returns
//! `Error::Overflow` if the final quotient does not fit back into `i128`.
//! Every multiply-then-divide in this crate (including `fees`) goes through
//! that one helper.
//!
//! [`total_assets`] and [`exchange_rate`] are exposed as infallible
//! entrypoints (`-> i128`), so on overflow they abort the invocation with a
//! typed `Error::Overflow` via `panic_with_error!` — callers still receive
//! the contract error code, never an untyped host panic. Internal callers
//! use the fallible [`try_total_assets`] instead.
//!
//! TODO(issue): add the property test in `test.rs` that asserts no sequence
//! of deposit/withdraw calls can increase total assets extracted beyond what
//! was deposited plus harvested yield.

use soroban_sdk::{panic_with_error, Env, I256};

use crate::error::Error;
use crate::fees;
use crate::storage;
use crate::strategy;
use crate::types::DataKey;

/// `a * b / denominator`, rounded down, computed with a 256-bit
/// intermediate so the product itself can never overflow.
///
/// Callers pass non-negative `a`/`b` and a positive `denominator` (all share
/// and asset quantities in this crate are non-negative), so truncating
/// integer division is exactly floor division — the rounding direction the
/// module doc requires.
///
/// Errors `Error::Overflow` if the quotient does not fit in `i128`, or if
/// `denominator == 0` (division by zero is treated as an arithmetic
/// failure and returned as a typed error, never a host panic).
pub fn mul_div_floor(env: &Env, a: i128, b: i128, denominator: i128) -> Result<i128, Error> {
    if denominator == 0 {
        return Err(Error::Overflow);
    }
    let product = I256::from_i128(env, a).mul(&I256::from_i128(env, b));
    product
        .div(&I256::from_i128(env, denominator))
        .to_i128()
        .ok_or(Error::Overflow)
}

/// Fallible form of [`total_assets`]: idle balance plus the active
/// strategy's reported balance, minus liabilities that are not depositor
/// value (accrued-but-unswept fees, and assets already owed to pending
/// withdraw requests whose shares were burned).
///
/// Clamped at `0`: if a strategy loss leaves the adapter unable to cover its
/// liabilities, depositors' shares are worth nothing, not a negative amount.
///
/// Errors `Error::Overflow` if any intermediate sum does not fit in `i128`.
pub fn try_total_assets(env: &Env) -> Result<i128, Error> {
    let idle = storage::idle_balance(env);
    let deployed = strategy::active_strategy_balance(env);
    let gross = idle.checked_add(deployed).ok_or(Error::Overflow)?;

    let fees = fees::fees_accrued(env);
    let reserved = reserved_withdraw_assets(env);
    let liabilities = fees.checked_add(reserved).ok_or(Error::Overflow)?;

    let net = gross.checked_sub(liabilities).ok_or(Error::Overflow)?;
    Ok(net.max(0))
}

/// Total vault-token value the adapter is responsible for to depositors: its
/// own idle balance plus whatever is currently deployed in the active
/// strategy (queried via the strategy's own balance-reporting entrypoint —
/// see `README.md`'s "Strategy interface"), minus accrued fees and assets
/// reserved for pending withdraw requests. See [`try_total_assets`].
///
/// Aborts with `Error::Overflow` if the sum does not fit in `i128`.
pub fn total_assets(env: &Env) -> i128 {
    try_total_assets(env).unwrap_or_else(|e| panic_with_error!(env, e))
}

/// Total shares outstanding across all positions. Backed by the
/// `DataKey::TotalShares` running total, not a scan over `Position` entries.
pub fn total_shares(env: &Env) -> i128 {
    storage::get_i128(env, &DataKey::TotalShares)
}

/// Persist the `DataKey::TotalShares` running total.
pub fn set_total_shares(env: &Env, shares: i128) {
    storage::set_i128(env, &DataKey::TotalShares, shares);
}

/// Sum of assets owed to pending withdraw requests. Backed by
/// `DataKey::ReservedWithdrawAssets`.
pub fn reserved_withdraw_assets(env: &Env) -> i128 {
    storage::get_i128(env, &DataKey::ReservedWithdrawAssets)
}

/// Persist the `DataKey::ReservedWithdrawAssets` running total.
pub fn set_reserved_withdraw_assets(env: &Env, assets: i128) {
    storage::set_i128(env, &DataKey::ReservedWithdrawAssets, assets);
}

/// Convert an asset amount to shares at the current exchange rate, rounding
/// down. On the very first deposit (when `total_shares() == 0`), shares are
/// minted 1:1 with assets.
///
/// - Errors `Error::InvalidAmount` if `assets < 0`.
/// - Errors `Error::Overflow` if the resulting share count does not fit in
///   `i128` (e.g. after a near-total strategy loss), or if shares are outstanding but `total_assets() == 0` (a total
///   strategy loss): minting against a zero-value pool is undefined, and a
///   new deposit must not be silently absorbed by worthless existing shares.
pub fn convert_to_shares(env: &Env, assets: i128) -> Result<i128, Error> {
    if assets < 0 {
        return Err(Error::InvalidAmount);
    }
    let supply = total_shares(env);
    if supply == 0 {
        return Ok(assets);
    }
    let pool = try_total_assets(env)?;
    mul_div_floor(env, assets, supply, pool)
}

/// Convert a share amount to assets at the current exchange rate, rounding
/// down. With no shares outstanding the rate is defined as 1:1.
///
/// - Errors `Error::InvalidAmount` if `shares < 0`.
/// - Errors `Error::Overflow` if the resulting asset amount does not fit in
///   `i128`.
pub fn convert_to_assets(env: &Env, shares: i128) -> Result<i128, Error> {
    if shares < 0 {
        return Err(Error::InvalidAmount);
    }
    let supply = total_shares(env);
    if supply == 0 {
        return Ok(shares);
    }
    let pool = try_total_assets(env)?;
    mul_div_floor(env, shares, pool, supply)
}

/// The current exchange rate, expressed as `(total_assets, total_shares)` so
/// callers can compute a ratio at whatever precision they need without this
/// crate picking a fixed-point scale for them.
///
/// Aborts with `Error::Overflow` under the same conditions as
/// [`total_assets`].
pub fn exchange_rate(env: &Env) -> (i128, i128) {
    (total_assets(env), total_shares(env))
}
