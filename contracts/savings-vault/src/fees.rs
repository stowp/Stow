//! Flexible fee structure — issue #430.
//!
//! Provides configurable fee percentages, fee recipient management, and
//! optimized fee calculation for all vault operations.
//!
//! # Fee model
//!
//! The admin configures a fee in basis points (1/100 of a percent) and a
//! fee recipient address. When a user deposits or withdraws, the fee is
//! calculated as `amount * fee_bps / 10_000` using checked arithmetic and
//! transferred to the recipient. The net amount goes to/from the user.
//!
//! Fees are applied at the `storage::transfer_in` and `storage::transfer_out`
//! layer so every module (flexible, locked, goal, group, challenge) gets
//! consistent fee treatment without each one re-implementing the logic.

use soroban_sdk::{Address, Env};

use crate::admin;
use crate::error::Error;
use crate::storage::{self, extend_instance_ttl};
use crate::types::DataKey;

// ── Fee configuration ──────────────────────────────────────────────────────

/// The protocol fee charged on deposits and withdrawals, in basis points
/// (1/100 of a percent). Defaults to `0` (no fee) before `set_fee_bps` has
/// been called.
pub fn fee_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::FeeBps)
        .unwrap_or(0)
}

/// Set the protocol fee. Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Errors `InvalidParameters` if `bps > 1_000` (10% — a sanity ceiling).
/// - Takes effect immediately: the very next deposit or withdrawal is charged
///   the new rate.
pub fn set_fee_bps(env: &Env, bps: u32) -> Result<(), Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    if bps > 1_000 {
        return Err(Error::InvalidParameters);
    }

    env.storage().instance().set(&DataKey::FeeBps, &bps);

    Ok(())
}

/// The address that receives protocol fees. Defaults to the admin when
/// unset. Errors `NotInitialized` if neither is set.
pub fn fee_recipient(env: &Env) -> Result<Address, Error> {
    if let Some(recipient) = env.storage().instance().get(&DataKey::FeeRecipient) {
        return Ok(recipient);
    }
    storage::get_admin(env).ok_or(Error::NotInitialized)
}

/// Set the fee recipient. Admin-only.
pub fn set_fee_recipient(env: &Env, recipient: Address) -> Result<(), Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    env.storage().instance().set(&DataKey::FeeRecipient, &recipient);

    Ok(())
}

// ── Fee calculation ────────────────────────────────────────────────────────

/// Calculate the fee for a given `amount` using the current fee rate.
///
/// Uses checked arithmetic: `amount * fee_bps / 10_000`, floored.
/// Returns `(fee, net)` where `net = amount - fee`.
///
/// When `fee_bps == 0` the function returns `(0, amount)` without touching
/// the arithmetic path.
pub fn calculate_fee(env: &Env, amount: i128) -> Result<(i128, i128), Error> {
    let bps = fee_bps(env);
    if bps == 0 {
        return Ok((0, amount));
    }

    let fee = amount
        .checked_mul(bps as i128)
        .ok_or(Error::Overflow)?
        .checked_div(10_000)
        .ok_or(Error::DivisionByZero)?;

    let net = amount.checked_sub(fee).ok_or(Error::Overflow)?;
    Ok((fee, net))
}

/// Charge a fee on an inbound transfer and send it to the fee recipient.
///
/// Transfers `amount` from `from` into the contract, then immediately sends
/// the fee portion to [`fee_recipient`]. Returns `net` (the amount credited
/// to the user's balance).
///
/// When `fee_bps == 0` this is equivalent to a plain `transfer_in` with no
/// extra token movement.
pub fn transfer_in_with_fee(
    env: &Env,
    from: &Address,
    amount: i128,
) -> Result<i128, Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let (fee, net) = calculate_fee(env, amount)?;

    // Transfer the full amount into the contract first.
    storage::transfer_in(env, from, amount)?;

    // Then send the fee portion to the recipient.
    if fee > 0 {
        storage::transfer_out(env, &fee_recipient(env)?, fee)?;
    }

    Ok(net)
}

/// Charge a fee on an outbound transfer.
///
/// Transfers `net` from the contract to `to`, and sends the fee portion to
/// [`fee_recipient`]. `amount` is the gross amount being withdrawn; the user
/// receives `net = amount - fee`.
///
/// When `fee_bps == 0` this is equivalent to a plain `transfer_out` with no
/// extra token movement.
pub fn transfer_out_with_fee(
    env: &Env,
    to: &Address,
    amount: i128,
) -> Result<i128, Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let (fee, net) = calculate_fee(env, amount)?;

    // Send the net amount to the user.
    if net > 0 {
        storage::transfer_out(env, to, net)?;
    }

    // Send the fee to the recipient.
    if fee > 0 {
        storage::transfer_out(env, &fee_recipient(env)?, fee)?;
    }

    Ok(net)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup_env() -> Env {
        let env = Env::default();
        env.mock_all_auths();
        env
    }

    #[test]
    fn fee_bps_defaults_to_zero() {
        let env = setup_env();
        assert_eq!(fee_bps(&env), 0);
    }

    #[test]
    fn set_fee_bps_stores_value() {
        let env = setup_env();
        let admin = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenTransferActive, &false);

        set_fee_bps(&env, 50).unwrap(); // 0.5%
        assert_eq!(fee_bps(&env), 50);
    }

    #[test]
    fn set_fee_bps_rejects_above_1000() {
        let env = setup_env();
        let admin = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenTransferActive, &false);

        assert_eq!(
            set_fee_bps(&env, 1_001),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn fee_recipient_defaults_to_admin() {
        let env = setup_env();
        let admin = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenTransferActive, &false);

        assert_eq!(fee_recipient(&env).unwrap(), admin);
    }

    #[test]
    fn set_fee_recipient_stores_value() {
        let env = setup_env();
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenTransferActive, &false);

        set_fee_recipient(&env, recipient.clone()).unwrap();
        assert_eq!(fee_recipient(&env).unwrap(), recipient);
    }

    #[test]
    fn calculate_fee_zero_bps_returns_full_amount() {
        let env = setup_env();
        let (fee, net) = calculate_fee(&env, 1_000_000).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(net, 1_000_000);
    }

    #[test]
    fn calculate_fee_50_bps_on_1m() {
        let env = setup_env();
        let admin = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenTransferActive, &false);
        set_fee_bps(&env, 50).unwrap();

        // 1_000_000 * 50 / 10_000 = 5_000
        let (fee, net) = calculate_fee(&env, 1_000_000).unwrap();
        assert_eq!(fee, 5_000);
        assert_eq!(net, 995_000);
    }

    #[test]
    fn calculate_fee_100_bps_on_1m() {
        let env = setup_env();
        let admin = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenTransferActive, &false);
        set_fee_bps(&env, 100).unwrap(); // 1%

        let (fee, net) = calculate_fee(&env, 1_000_000).unwrap();
        assert_eq!(fee, 10_000);
        assert_eq!(net, 990_000);
    }

    #[test]
    fn calculate_fee_floors_on_small_amounts() {
        let env = setup_env();
        let admin = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenTransferActive, &false);
        set_fee_bps(&env, 50).unwrap();

        // 100 * 50 / 10_000 = 0 (floored)
        let (fee, net) = calculate_fee(&env, 100).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(net, 100);
    }
}
