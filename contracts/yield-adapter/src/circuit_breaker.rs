//! Emergency circuit breaker — pull all funds out of the active strategy
//! back into the adapter's own idle balance, independent of the normal
//! `migrate_strategy` flow. Exists for the case where the active strategy
//! itself is misbehaving or believed compromised and admin wants funds out
//! *now*, without registering or trusting a replacement strategy first.

use soroban_sdk::{Address, Env};

use crate::admin;
use crate::error::Error;
use crate::events;
use crate::storage::extend_instance_ttl;
use crate::strategy;

/// Withdraw the adapter's entire deployed balance from the active strategy
/// back into the adapter's own custody, and clear `ActiveStrategy`. Does
/// **not** deregister the strategy (an admin can still inspect/re-activate
/// it after investigating). Admin-only.
///
/// - Requires `require_auth` from the current admin; errors
///   `Error::Unauthorized` if `caller` is not the admin.
/// - Errors `Error::StrategyNotFound` if no strategy is currently active
///   (there is nothing to pull from).
/// - Safe to call even if the strategy is unresponsive to normal calls,
///   *if* the strategy interface's withdraw entrypoint still functions —
///   this is a graceful pull, not a bypass of the strategy contract. A
///   fully unresponsive/malicious strategy that refuses to return funds is
///   out of scope for this contract to solve unilaterally; see
///   `README.md`'s "Strategy interface" trust notes.
/// - **Not** blocked by `set_paused`: pausing is typically the first step
///   of the same incident this entrypoint exists for, so it must keep
///   working while paused.
/// - After this call, `deposit` continues to accept funds (held idle,
///   earning no yield) until an admin sets a new active strategy.
/// - Emits a `strategy_changed` event with `to: None` and `assets_moved`
///   equal to the returned amount.
///
/// Returns the amount that actually arrived back in the adapter, measured
/// from the adapter's own token balance rather than trusted from the
/// strategy. `0` if the strategy reported no balance (the active strategy is
/// still cleared in that case).
pub fn emergency_withdraw_all(env: &Env, caller: Address) -> Result<i128, Error> {
    extend_instance_ttl(env);
    admin::require_admin(env, &caller)?;

    let strategy_id = strategy::active_strategy_id(env).ok_or(Error::StrategyNotFound)?;
    let info = strategy::get_strategy(env, strategy_id)?;

    let deployed = strategy::strategy_balance(env, &info.address);
    let recovered = if deployed > 0 {
        strategy::withdraw_from_strategy(env, &info.address, deployed)?
    } else {
        0
    };

    strategy::clear_active_strategy(env);

    events::publish_strategy_changed(env, Some(strategy_id), None, recovered);

    Ok(recovered)
}
