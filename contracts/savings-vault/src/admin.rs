//! Initialization and admin configuration.

use soroban_sdk::{Address, Env};

use crate::error::Error;
use crate::events::{EVENT_SCHEMA_VERSION, TOPIC_ADMIN_SET, TOPIC_INIT};
use crate::storage::{self, extend_instance_ttl};
use crate::types::DataKey;

/// Initialize the vault.
///
/// - Stores `admin` and the `token` (SEP-41, e.g. USDC) address.
/// - Seeds id counters.
/// - Must be callable exactly once; subsequent calls -> `Error::AlreadyInitialized`.
///
/// Acceptance: after init, `token()` and `admin()` return the given values.
pub fn initialize(env: &Env, admin: Address, token: Address) -> Result<(), Error> {
    if env.storage().instance().has(&DataKey::Admin) {
        return Err(Error::AlreadyInitialized);
    }

    extend_instance_ttl(env);

    env.storage().instance().set(&DataKey::Admin, &admin);
    storage::set_token(env, &token);

    env.storage().instance().set(&DataKey::NextLockedId, &0u64);
    env.storage().instance().set(&DataKey::NextGoalId, &0u64);
    env.storage().instance().set(&DataKey::NextGroupId, &0u64);
    env.storage().instance().set(&DataKey::Paused, &false);

    env.events().publish(
        (TOPIC_INIT,),
        (admin, token, EVENT_SCHEMA_VERSION, env.ledger().timestamp()),
    );

    Ok(())
}

/// Return the configured token address, or `Error::NotInitialized`.
pub fn token(env: &Env) -> Result<Address, Error> {
    storage::get_token(env).ok_or(Error::NotInitialized)
}

/// Return the configured admin address, or `Error::NotInitialized`.
pub fn admin(env: &Env) -> Result<Address, Error> {
    storage::get_admin(env).ok_or(Error::NotInitialized)
}

/// Rotate the admin. Requires `require_auth` from the current admin.
pub fn set_admin(env: &Env, new_admin: Address) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_admin = admin(env)?;
    current_admin.require_auth();

    env.storage().instance().set(&DataKey::Admin, &new_admin);

    env.events().publish(
        (TOPIC_ADMIN_SET,),
        (current_admin, new_admin, env.ledger().timestamp()),
    );

    Ok(())
}

/// Set the emergency-pause flag. Admin-only.
///
/// While paused, mutating entrypoints reject with `Error::Paused`; reads
/// remain available.
pub fn set_paused(env: &Env, caller: Address, paused: bool) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_admin = admin(env)?;
    caller.require_auth();
    if caller != current_admin {
        return Err(Error::Unauthorized);
    }

    env.storage().instance().set(&DataKey::Paused, &paused);

    Ok(())
}

/// Whether the contract is currently paused. Defaults to `false` if unset.
pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

/// Guard for mutating entrypoints: returns `Error::Paused` while paused.
pub fn require_not_paused(env: &Env) -> Result<(), Error> {
    if is_paused(env) {
        return Err(Error::Paused);
    }
    Ok(())
}

/// The per-account deposit cap, in token stroops. `0` means unlimited.
///
/// Defaults to `0` (unlimited) before `set_deposit_cap` has ever been
/// called.
pub fn deposit_cap(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::DepositCap).unwrap_or(0)
}

/// Set the per-account deposit cap. Admin-only. `0` disables the cap.
///
/// - Requires `require_auth` from the current admin.
/// - Errors `InvalidAmount` if `cap < 0`.
/// - Takes effect immediately: the very next `deposit` call is checked
///   against the new value.
pub fn set_deposit_cap(env: &Env, cap: i128) -> Result<(), Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    if cap < 0 {
        return Err(Error::InvalidAmount);
    }

    env.storage().instance().set(&DataKey::DepositCap, &cap);

    Ok(())
}
