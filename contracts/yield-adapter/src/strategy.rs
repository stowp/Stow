//! Strategy registry.
//!
//! A "strategy" is an external contract this adapter can route idle vault
//! funds into (e.g. a lending-market wrapper). Exactly one registered
//! strategy is ever "active" at a time — the one `deposit` and `harvest`
//! interact with. Others may stay registered (e.g. mid-migration) but never
//! receive funds. See `README.md`'s "Strategy interface" section for the
//! entrypoints a strategy contract must expose to be usable here.

use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::{vec, Address, Env, IntoVal, String, Symbol, Val, Vec};

use crate::admin;
use crate::error::Error;
use crate::events;
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, StrategyInfo};

// --- strategy interface calls ------------------------------------------------
//
// The only three places this crate reaches into an external strategy
// contract. Entrypoint names/argument order are the "Strategy interface"
// documented in `README.md`.

const STRATEGY_FN_DEPOSIT: &str = "deposit";
const STRATEGY_FN_WITHDRAW: &str = "withdraw";
const STRATEGY_FN_BALANCE: &str = "balance";

/// The adapter's claim on `strategy`, as reported by `strategy.balance(adapter)`.
///
/// A negative report is nonsensical (the adapter can't owe a strategy
/// anything) and is clamped to `0` rather than trusted.
pub fn strategy_balance(env: &Env, strategy: &Address) -> i128 {
    let args: Vec<Val> = vec![env, env.current_contract_address().into_val(env)];
    let reported: i128 =
        env.invoke_contract(strategy, &Symbol::new(env, STRATEGY_FN_BALANCE), args);
    reported.max(0)
}

/// Move `amount` of the vault token from the adapter into `strategy` by
/// calling `strategy.deposit(adapter, amount)`.
///
/// The strategy pulls the funds itself (`token.transfer(adapter, strategy,
/// amount)` from inside its `deposit`). That transfer is a *nested* call
/// the adapter doesn't make directly, so the adapter pre-authorizes exactly
/// that one transfer via `authorize_as_current_contract` — the strategy
/// cannot use it to move any other amount or to any other recipient.
pub fn deploy_to_strategy(env: &Env, strategy: &Address, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let token = storage::get_token(env).ok_or(Error::NotInitialized)?;
    let adapter = env.current_contract_address();

    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token,
                fn_name: Symbol::new(env, "transfer"),
                args: (adapter.clone(), strategy.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);

    let args: Vec<Val> = vec![env, adapter.into_val(env), amount.into_val(env)];
    env.invoke_contract::<()>(strategy, &Symbol::new(env, STRATEGY_FN_DEPOSIT), args);
    Ok(())
}

/// Ask `strategy` to return `amount` of the vault token to the adapter via
/// `strategy.withdraw(adapter, amount)`, and return how much actually
/// arrived (measured from the adapter's own token balance, not trusted from
/// the strategy).
pub fn withdraw_from_strategy(env: &Env, strategy: &Address, amount: i128) -> Result<i128, Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let adapter = env.current_contract_address();
    let before = storage::idle_balance(env);

    let args: Vec<Val> = vec![env, adapter.into_val(env), amount.into_val(env)];
    env.invoke_contract::<()>(strategy, &Symbol::new(env, STRATEGY_FN_WITHDRAW), args);

    let after = storage::idle_balance(env);
    after.checked_sub(before).ok_or(Error::Overflow)
}

// --- active strategy -----------------------------------------------------------

/// The active strategy id, or `None` when funds are held idle.
pub fn active_strategy_id(env: &Env) -> Option<u64> {
    env.storage().instance().get(&DataKey::ActiveStrategy)
}

/// The active strategy's record, or `None` when funds are held idle.
pub fn active_strategy(env: &Env) -> Option<StrategyInfo> {
    active_strategy_id(env).and_then(|id| get_strategy(env, id).ok())
}

/// The adapter's claim on the active strategy (`0` with no active strategy).
pub fn active_strategy_balance(env: &Env) -> i128 {
    match active_strategy(env) {
        Some(info) => strategy_balance(env, &info.address),
        None => 0,
    }
}

/// Clear `DataKey::ActiveStrategy` (the strategy stays registered).
pub fn clear_active_strategy(env: &Env) {
    env.storage().instance().remove(&DataKey::ActiveStrategy);
}

fn save_strategy(env: &Env, info: &StrategyInfo) {
    let key = DataKey::Strategy(info.id);
    env.storage().persistent().set(&key, info);
    storage::extend_persistent_ttl(env, &key);
}

/// Register a new strategy. Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Errors `Error::StrategyAlreadyRegistered` if `address` is already
///   registered under a different id.
/// - Does **not** make the strategy active — call `set_active_strategy`
///   separately. This split lets an admin register and sanity-check a
///   strategy before routing real funds to it.
/// - Emits a `strategy_registered` event.
/// - Errors `Error::Paused` while paused (strategy mutations are on the
///   pause blocklist — see `admin::set_paused`).
///
/// The duplicate check only considers *live* registrations: an address
/// whose previous registration was deregistered may be registered again
/// under a fresh id (the old id itself stays permanently deregistered).
pub fn register_strategy(
    env: &Env,
    caller: Address,
    address: Address,
    name: String,
) -> Result<u64, Error> {
    extend_instance_ttl(env);
    admin::require_admin(env, &caller)?;
    admin::require_not_paused(env)?;

    let duplicate = list_strategies(env)
        .iter()
        .any(|s| s.address == address && s.deregistered_at.is_none());
    if duplicate {
        return Err(Error::StrategyAlreadyRegistered);
    }

    let id = storage::next_id(env, DataKey::NextStrategyId)?;
    let info = StrategyInfo {
        id,
        address: address.clone(),
        name: name.clone(),
        deposit_cap: 0,
        registered_at: env.ledger().timestamp(),
        deregistered_at: None,
    };
    save_strategy(env, &info);

    events::publish_strategy_registered(env, id, &address, &name);

    Ok(id)
}

/// Deregister a strategy. Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Errors `Error::StrategyActive` if `strategy_id` is the currently active
///   strategy — migrate away from it first via `migrate_strategy`.
/// - A deregistered strategy's id can never be re-registered or reactivated;
///   `deregistered_at` is permanent.
/// - Emits a `strategy_deregistered` event.
///
/// TODO(issue): implement.
pub fn deregister_strategy(_env: &Env, _caller: Address, _strategy_id: u64) -> Result<(), Error> {
    unimplemented!("strategy: deregister_strategy")
}

/// Set the active strategy when there is currently none (first activation
/// only — funds are not moved because there is nothing to move from).
/// Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Errors `Error::StrategyAlreadyActive` if a strategy is already active
///   — use `migrate_strategy` to switch between two active strategies so
///   funds are moved atomically rather than stranded.
/// - Emits a `strategy_changed` event with `from: None`.
/// - Errors `Error::Paused` while paused.
/// - Errors `Error::StrategyNotFound` if `strategy_id` is unknown or has
///   been deregistered (a deregistered strategy can never become active).
///
/// Funds already sitting idle in the adapter (e.g. deposited while no
/// strategy was active, or pulled back by `emergency_withdraw_all`) stay
/// idle; only deposits made after activation are forwarded.
pub fn set_active_strategy(env: &Env, caller: Address, strategy_id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_admin(env, &caller)?;
    admin::require_not_paused(env)?;

    if active_strategy_id(env).is_some() {
        return Err(Error::StrategyAlreadyActive);
    }

    let info = get_strategy(env, strategy_id)?;
    if info.deregistered_at.is_some() {
        return Err(Error::StrategyNotFound);
    }

    env.storage()
        .instance()
        .set(&DataKey::ActiveStrategy, &strategy_id);

    events::publish_strategy_changed(env, None, Some(strategy_id), 0);

    Ok(())
}

/// Move all deployed funds from the current active strategy to
/// `new_strategy_id` and make it active. Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Withdraws the adapter's full balance from the old strategy, deposits it
///   into the new one.
/// - Must preserve `total_assets()` (module the old strategy's own
///   withdrawal fees/slippage, if any — see the "Strategy interface" doc for
///   how those are surfaced and accounted for).
/// - Emits a `strategy_changed` event with both `from` and `to` ids.
///
/// TODO(issue): implement.
pub fn migrate_strategy(_env: &Env, _caller: Address, _new_strategy_id: u64) -> Result<(), Error> {
    unimplemented!("strategy: migrate_strategy")
}

/// Set a per-strategy deposit cap, in vault-token stroops. `0` means
/// unlimited. Admin-only.
///
/// - Requires `require_auth` from the current admin.
/// - Enforced in `deposit` against the *active* strategy's cap only; a
///   non-active strategy's cap has no live effect.
///
/// TODO(issue): implement.
pub fn set_strategy_deposit_cap(
    _env: &Env,
    _caller: Address,
    _strategy_id: u64,
    _cap: i128,
) -> Result<(), Error> {
    unimplemented!("strategy: set_strategy_deposit_cap")
}

/// Read a strategy by id, or `Error::StrategyNotFound`.
pub fn get_strategy(env: &Env, strategy_id: u64) -> Result<StrategyInfo, Error> {
    let key = DataKey::Strategy(strategy_id);
    let info: StrategyInfo = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::StrategyNotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(info)
}

/// List all registered strategies (including deregistered ones — check
/// `deregistered_at` to filter).
///
/// Note: iterates `1..=NextStrategyId`; fine at expected strategy counts
/// (low single digits) but do not reuse this pattern for anything with
/// unbounded cardinality (e.g. positions).
pub fn list_strategies(env: &Env) -> Vec<StrategyInfo> {
    let last: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextStrategyId)
        .unwrap_or(0);
    let mut out = Vec::new(env);
    for id in 1..=last {
        if let Ok(info) = get_strategy(env, id) {
            out.push_back(info);
        }
    }
    out
}
