//! Storage helpers and TTL management.
//!
//! Centralize all `env.storage()` access here so the persistence strategy
//! (instance vs. persistent, TTL bumping) lives in one place. Mirrors the
//! `savings-vault` crate's storage module — see that crate's `storage.rs`
//! doc comment for the full rationale behind the instance/persistent split.
//!
//! # Storage model
//!
//! - **Instance storage** for small, hot, singleton values read on nearly
//!   every call: `Admin`, `Treasury`, `Token`, `Paused`,
//!   `PerformanceFeeBps`, `HarvestInterval`, `LastHarvestAt`,
//!   `WithdrawCooldown`, `ActiveStrategy`, `TotalShares`, `FeesAccrued`, and
//!   the `Next*Id` counters. TTL bumped as a single unit by
//!   [`extend_instance_ttl`], called at the top of every state-changing
//!   entrypoint.
//! - **Persistent storage** for unbounded, per-key records: `Strategy(u64)`,
//!   `Position(Address)`, `WithdrawRequest(u64)`. TTL refreshed per-entry via
//!   [`extend_persistent_ttl`] on every read and write.
//!
//! TODO(issue): tune [`INSTANCE_BUMP_AMOUNT`] / [`PERSISTENT_BUMP_AMOUNT`]
//! against expected call cadence once this adapter has real testnet usage
//! data; the values below are copied from `savings-vault` as a starting
//! point, not derived for this contract's access pattern.

use soroban_sdk::{token, Address, Env};

use crate::error::Error;
use crate::types::DataKey;

// --- TTL constants (ledgers) ------------------------------------------------
// Roughly: 1 ledger ~= 5s on mainnet cadence.
pub const DAY_IN_LEDGERS: u32 = 17_280;

pub const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

pub const PERSISTENT_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = PERSISTENT_BUMP_AMOUNT - DAY_IN_LEDGERS;

/// Bump the instance TTL. Call at the top of every state-changing entrypoint.
pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Bump a persistent entry's TTL. Call after every read and write of a
/// `Strategy`, `Position`, or `WithdrawRequest` record.
///
/// TODO(issue): implement — mirrors
/// `savings-vault::storage::extend_persistent_ttl`.
pub fn extend_persistent_ttl(_env: &Env, _key: &DataKey) {
    unimplemented!("storage: extend_persistent_ttl")
}

/// The vault token (e.g. USDC) this adapter routes, or `None` before
/// `initialize`.
///
/// TODO(issue): implement.
pub fn get_token(_env: &Env) -> Option<Address> {
    unimplemented!("storage: get_token")
}

/// Persist `DataKey::Token`.
///
/// TODO(issue): implement.
pub fn set_token(_env: &Env, _token: &Address) {
    unimplemented!("storage: set_token")
}

/// The contract admin, or `None` before `initialize`.
pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

/// Allocate and persist the next id for the given counter key
/// (`NextStrategyId` or `NextWithdrawId`).
///
/// Ids start at `1` (the counter reads `0` when absent, so the first
/// allocation returns `1`). Mirrors `savings-vault::storage::next_id`.
///
/// TODO(issue): implement.
pub fn next_id(_env: &Env, _key: DataKey) -> u64 {
    unimplemented!("storage: next_id")
}

// --- SEP-41 token movement ---------------------------------------------------
//
// Every module moves funds through these two helpers rather than building a
// `token::Client` and calling `transfer` directly, so amount validation and
// transfer direction live in exactly one place. Mirrors
// `savings-vault::storage::transfer_in` / `transfer_out`.

/// Move `amount` of the vault token from `from` into this contract.
///
/// Errors `Error::InvalidAmount` if `amount <= 0`, `Error::NotInitialized`
/// if the token has not been configured.
///
/// TODO(issue): implement.
pub fn transfer_in(_env: &Env, _from: &Address, _amount: i128) -> Result<(), Error> {
    unimplemented!("storage: transfer_in")
}

/// Move `amount` of the vault token from this contract out to `to`.
///
/// Errors `Error::InvalidAmount` if `amount <= 0`, `Error::NotInitialized`
/// if the token has not been configured.
///
/// TODO(issue): implement.
pub fn transfer_out(_env: &Env, _to: &Address, _amount: i128) -> Result<(), Error> {
    unimplemented!("storage: transfer_out")
}

// Re-exported for modules that need a raw token client (e.g. `strategy`,
// which forwards funds to/from an external strategy contract using the same
// token).
pub fn token_client<'a>(env: &'a Env, token_address: &Address) -> token::Client<'a> {
    token::Client::new(env, token_address)
}
