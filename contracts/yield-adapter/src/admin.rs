//! Initialization and admin configuration.

use soroban_sdk::{Address, BytesN, Env};

use crate::error::Error;
use crate::events;
use crate::storage::{self, extend_instance_ttl};
use crate::types::DataKey;

/// Initialize the adapter.
///
/// - Stores `admin`, `treasury`, and the `token` (SEP-41, e.g. USDC) address
///   — `token` must match the upstream `savings-vault`'s token.
/// - Seeds id counters, `TotalShares`, and `FeesAccrued` at `0`.
/// - Must be callable exactly once; subsequent calls -> `Error::AlreadyInitialized`.
/// - Emits an `init` event carrying [`crate::events::EVENT_SCHEMA_VERSION`].
///
/// Acceptance: after init, `admin()`, `treasury()`, and `token()` return the
/// given values; `total_assets()` and `total_shares()` both return `0`.
///
/// Like `savings-vault::admin::initialize`, this is not auth-gated: whoever
/// calls it first becomes the configured admin. Deploy and initialize in the
/// same transaction (or via a constructor-style deploy script) so there is no
/// window for a third party to front-run it.
pub fn initialize(
    env: &Env,
    admin: Address,
    treasury: Address,
    token: Address,
) -> Result<(), Error> {
    if env.storage().instance().has(&DataKey::Admin) {
        return Err(Error::AlreadyInitialized);
    }

    extend_instance_ttl(env);

    let instance = env.storage().instance();
    instance.set(&DataKey::Admin, &admin);
    instance.set(&DataKey::Treasury, &treasury);
    storage::set_token(env, &token);

    instance.set(&DataKey::Paused, &false);
    instance.set(&DataKey::NextStrategyId, &0u64);
    instance.set(&DataKey::NextWithdrawId, &0u64);
    storage::set_i128(env, &DataKey::TotalShares, 0);
    storage::set_i128(env, &DataKey::FeesAccrued, 0);
    storage::set_i128(env, &DataKey::ReservedWithdrawAssets, 0);

    events::publish_init(env, &admin, &treasury, &token);

    Ok(())
}

/// Return the configured admin address, or `Error::NotInitialized`.
pub fn admin(env: &Env) -> Result<Address, Error> {
    storage::get_admin(env).ok_or(Error::NotInitialized)
}

/// Return the configured treasury address, or `Error::NotInitialized`.
pub fn treasury(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Treasury)
        .ok_or(Error::NotInitialized)
}

/// Return the configured vault token, or `Error::NotInitialized`.
pub fn token(env: &Env) -> Result<Address, Error> {
    storage::get_token(env).ok_or(Error::NotInitialized)
}

/// Shared admin guard for every admin-only entrypoint that takes an explicit
/// `caller`: `caller.require_auth()`, then `Error::Unauthorized` unless
/// `caller` is the configured admin. Errors `Error::NotInitialized` before
/// `initialize`.
pub fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
    let current_admin = admin(env)?;
    caller.require_auth();
    if *caller != current_admin {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

/// Rotate the admin. Requires `require_auth` from the current admin.
///
/// Mirrors `savings-vault::admin::set_admin`. Emits `admin_set` with the
/// previous and new admin.
pub fn set_admin(env: &Env, new_admin: Address) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_admin = admin(env)?;
    current_admin.require_auth();

    env.storage().instance().set(&DataKey::Admin, &new_admin);

    events::publish_admin_set(env, &current_admin, &new_admin);

    Ok(())
}

/// Change the treasury address that receives collected performance fees.
/// Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Does **not** sweep already-accrued fees to the new treasury — call
///   `withdraw_fees` beforehand if that matters for the transition.
///
/// TODO(issue): implement.
pub fn set_treasury(_env: &Env, _caller: Address, _new_treasury: Address) -> Result<(), Error> {
    unimplemented!("admin: set_treasury")
}

/// The performance fee, in basis points (0-10_000), charged only on positive
/// yield at `harvest` time. Defaults to `0` before ever set.
pub fn performance_fee_bps(_env: &Env) -> u32 {
    unimplemented!("admin: performance_fee_bps")
}

/// Set the performance fee. Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Errors `Error::FeeTooHigh` if `bps > 3_000` (30%) — see
///   `fees` module doc for why this cap exists.
/// - Takes effect on the *next* `harvest` call; does not retroactively
///   apply to yield already reported.
///
/// TODO(issue): implement.
pub fn set_performance_fee_bps(_env: &Env, _caller: Address, _bps: u32) -> Result<(), Error> {
    unimplemented!("admin: set_performance_fee_bps")
}

/// Set the emergency-pause flag. Admin-only.
///
/// While paused, `deposit`, `request_withdraw`, `harvest`, and strategy
/// mutations reject with `Error::Paused`; `claim_withdraw` and reads remain
/// available so users already mid-withdrawal are never trapped by a pause.
///
/// Mirrors `savings-vault::admin::set_paused`, but with the narrower
/// blocklist above (deliberately different from `savings-vault`, which
/// pauses all mutations). The blocklist is enforced by each blocked
/// entrypoint calling [`require_not_paused`]; entrypoints that must stay
/// available simply don't call it. `cancel_withdraw` and
/// `circuit_breaker::emergency_withdraw_all` are also left available — the
/// former only re-mints a user's own shares, the latter is exactly the tool
/// an admin reaches for during the incident that prompted the pause.
///
/// - Requires `require_auth` from `caller`; errors `Error::Unauthorized`
///   unless `caller` is the admin.
/// - Emits `paused_changed` on every successful call (including a call that
///   re-sets the current value), so the indexer sees every admin action.
pub fn set_paused(env: &Env, caller: Address, paused: bool) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_admin(env, &caller)?;

    env.storage().instance().set(&DataKey::Paused, &paused);

    events::publish_paused_changed(env, &caller, paused);

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

/// Cooldown, in seconds, `request_withdraw` must wait before
/// `claim_withdraw` is permitted. Defaults to `0` (no cooldown) if unset.
pub fn withdraw_cooldown(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::WithdrawCooldown)
        .unwrap_or(0)
}

/// Set the withdrawal cooldown. Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Only affects requests created *after* the change; in-flight
///   `WithdrawRequest`s keep the `claimable_at` computed at request time.
///
/// TODO(issue): implement.
pub fn set_withdraw_cooldown(_env: &Env, _caller: Address, _seconds: u64) -> Result<(), Error> {
    unimplemented!("admin: set_withdraw_cooldown")
}

/// Upgrade the contract's Wasm executable to `new_wasm_hash`. Admin-only.
///
/// Same trust trade-off as `savings-vault::admin::upgrade` (see that
/// function's doc comment): the admin key can replace contract logic
/// outright, including custody rules. Storage is not migrated automatically.
///
/// Must emit `upgraded` via [`events::publish_upgraded`] (payload documented
/// in `README.md`'s "Event schema") after the Wasm swap succeeds.
///
/// TODO(issue): implement.
pub fn upgrade(_env: &Env, _caller: Address, _new_wasm_hash: BytesN<32>) -> Result<(), Error> {
    unimplemented!("admin: upgrade")
}
