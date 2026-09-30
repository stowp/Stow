//! Initialization and admin configuration.

use soroban_sdk::{Address, BytesN, Env};

use crate::error::Error;
use crate::events;
use crate::fees;
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
/// - Requires `require_auth` from `caller`; errors `Error::Unauthorized`
///   unless `caller` is the admin, `Error::NotInitialized` before
///   `initialize`.
/// - Takes effect immediately: `treasury()` returns `new_treasury` and every
///   subsequent `withdraw_fees` pays it.
/// - Does **not** sweep already-accrued fees. `FeesAccrued` is left intact
///   and is paid to whichever treasury is configured at the time
///   `withdraw_fees` is next called — i.e. the *new* one. If the outgoing
///   treasury must receive fees accrued under its tenure, call
///   `withdraw_fees` before rotating.
pub fn set_treasury(env: &Env, caller: Address, new_treasury: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_admin(env, &caller)?;

    env.storage()
        .instance()
        .set(&DataKey::Treasury, &new_treasury);

    Ok(())
}

/// The performance fee, in basis points (0-10_000), charged only on positive
/// yield at `harvest` time. Defaults to `0` before ever set.
pub fn performance_fee_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::PerformanceFeeBps)
        .unwrap_or(0)
}

/// Set the performance fee. Admin-only.
///
/// - Requires `require_auth` from `caller`; errors `Error::Unauthorized`
///   unless `caller` is the admin.
/// - Errors `Error::FeeTooHigh` if `bps > fees::MAX_PERFORMANCE_FEE_BPS`
///   (3_000, i.e. 30%) — see `fees` module doc for why this cap exists. A
///   rejected value leaves the previously configured fee untouched.
/// - Takes effect on the *next* `harvest` call; does not retroactively
///   apply to yield already reported.
pub fn set_performance_fee_bps(env: &Env, caller: Address, bps: u32) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_admin(env, &caller)?;
    fees::validate_fee_bps(bps)?;

    env.storage()
        .instance()
        .set(&DataKey::PerformanceFeeBps, &bps);

    Ok(())
}

/// Minimum number of seconds between successful `harvest` calls. Defaults
/// to `0` (no minimum) if unset. See `harvest::check_harvest_interval`.
pub fn harvest_interval(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::HarvestInterval)
        .unwrap_or(0)
}

/// Set the minimum interval between `harvest` calls. Admin-only. Mirrors
/// `set_withdraw_cooldown`'s shape.
///
/// - Requires `require_auth` from the current admin.
/// - Takes effect on the very next `check_harvest_interval` call.
pub fn set_harvest_interval(env: &Env, caller: Address, seconds: u64) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != current_admin {
        return Err(Error::Unauthorized);
    }

    env.storage()
        .instance()
        .set(&DataKey::HarvestInterval, &seconds);

    Ok(())
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
/// outright, including custody rules — so whoever holds it can, in effect,
/// move every depositor's funds. Deployments that want stronger guarantees
/// should put the admin behind a multisig and/or timelock. Storage is not
/// migrated automatically; the new Wasm must read the existing `DataKey`
/// layout (or ship its own migration entrypoint).
///
/// - Requires `require_auth` from `caller`; errors `Error::Unauthorized`
///   unless `caller` is the admin, `Error::NotInitialized` before
///   `initialize`.
/// - `new_wasm_hash` must already be uploaded to the network (e.g. via the
///   Stellar CLI or `Deployer::upload_contract_wasm`); the host traps
///   otherwise and nothing changes.
/// - The swap takes effect once the current invocation finishes; the
///   `upgraded` event is emitted via [`events::publish_upgraded`] (payload
///   documented in `README.md`'s "Event schema") after it succeeds.
pub fn upgrade(env: &Env, caller: Address, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_admin(env, &caller)?;

    env.deployer()
        .update_current_contract_wasm(new_wasm_hash.clone());

    events::publish_upgraded(env, &caller, &new_wasm_hash);

    Ok(())
}
