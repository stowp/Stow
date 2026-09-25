//! Withdrawals — queued behind a cooldown so the adapter has time to unwind
//! funds from an illiquid strategy before paying out.

use soroban_sdk::{Address, Env};

use crate::accounting;
use crate::admin;
use crate::error::Error;
use crate::events;
use crate::storage::{self, extend_instance_ttl};
use crate::strategy;
use crate::types::{DataKey, Position, WithdrawRequest};

fn save_request(env: &Env, request: &WithdrawRequest) {
    let key = DataKey::WithdrawRequest(request.id);
    env.storage().persistent().set(&key, request);
    storage::extend_persistent_ttl(env, &key);
}

/// Load a pending request on behalf of `owner` — shared by `claim_withdraw`
/// and `cancel_withdraw`. Errors `NotFound`, then `Unauthorized` if `owner`
/// doesn't own it, then `WithdrawAlreadyResolved` if it was already claimed
/// or cancelled.
fn load_pending_request(
    env: &Env,
    owner: &Address,
    request_id: u64,
) -> Result<WithdrawRequest, Error> {
    let request = get_withdraw_request(env, request_id)?;
    if request.owner != *owner {
        return Err(Error::Unauthorized);
    }
    if request.claimed_at.is_some() || request.cancelled_at.is_some() {
        return Err(Error::WithdrawAlreadyResolved);
    }
    Ok(request)
}

/// Remove a resolved request's assets from the `ReservedWithdrawAssets`
/// running total.
fn release_reserved(env: &Env, assets: i128) -> Result<(), Error> {
    let reserved = accounting::reserved_withdraw_assets(env)
        .checked_sub(assets)
        .ok_or(Error::Overflow)?;
    accounting::set_reserved_withdraw_assets(env, reserved);
    Ok(())
}

/// Burn `shares` from `owner`'s position and queue a withdrawal, claimable
/// after `admin::withdraw_cooldown()` seconds.
///
/// - `owner.require_auth()`.
/// - Errors `Error::Paused` while paused.
/// - Errors `Error::InvalidAmount` if `shares <= 0`.
/// - Errors `Error::InsufficientBalance` if `shares > owner`'s position.
/// - Shares are burned immediately (so they stop earning/losing with the
///   exchange rate); the underlying asset amount is fixed at request time
///   using `accounting::convert_to_assets(shares)` and stored on the
///   `WithdrawRequest` — a later `harvest` does not change what this
///   request pays out.
/// - Errors `Error::NotFound` if `owner` has no position at all.
/// - Errors `Error::InvalidAmount` if `shares` would convert to `0` assets
///   (burning them would pay out nothing).
/// - The fixed asset amount is added to `DataKey::ReservedWithdrawAssets`
///   so it stops counting toward `total_assets()` for remaining holders.
/// - Emits a `withdraw_requested` event.
///
/// Returns the new request id.
pub fn request_withdraw(env: &Env, owner: Address, shares: i128) -> Result<u64, Error> {
    extend_instance_ttl(env);
    owner.require_auth();
    admin::require_not_paused(env)?;

    if shares <= 0 {
        return Err(Error::InvalidAmount);
    }

    let position_key = DataKey::Position(owner.clone());
    let mut position: Position = env
        .storage()
        .persistent()
        .get(&position_key)
        .ok_or(Error::NotFound)?;
    if shares > position.shares {
        return Err(Error::InsufficientBalance);
    }

    // Fix the payout before burning, at the current rate.
    let assets = accounting::convert_to_assets(env, shares)?;
    if assets == 0 {
        return Err(Error::InvalidAmount);
    }

    let now = env.ledger().timestamp();
    let claimable_at = now
        .checked_add(admin::withdraw_cooldown(env))
        .ok_or(Error::Overflow)?;
    let new_position_shares = position.shares.checked_sub(shares).ok_or(Error::Overflow)?;
    let new_total_shares = accounting::total_shares(env)
        .checked_sub(shares)
        .ok_or(Error::Overflow)?;
    let new_reserved = accounting::reserved_withdraw_assets(env)
        .checked_add(assets)
        .ok_or(Error::Overflow)?;

    let id = storage::next_id(env, DataKey::NextWithdrawId)?;

    position.shares = new_position_shares;
    position.updated_at = now;
    env.storage().persistent().set(&position_key, &position);
    storage::extend_persistent_ttl(env, &position_key);
    accounting::set_total_shares(env, new_total_shares);
    accounting::set_reserved_withdraw_assets(env, new_reserved);

    save_request(
        env,
        &WithdrawRequest {
            id,
            owner: owner.clone(),
            shares,
            assets,
            claimable_at,
            requested_at: now,
            claimed_at: None,
            cancelled_at: None,
        },
    );

    events::publish_withdraw_requested(env, id, &owner, shares, assets, claimable_at);

    Ok(id)
}

/// Pay out a previously-requested withdrawal.
///
/// - `owner.require_auth()`; errors `Error::Unauthorized` if `owner` is not
///   the request's owner.
/// - Errors `Error::CooldownNotElapsed` if `env.ledger().timestamp() <
///   claimable_at`.
/// - Errors `Error::WithdrawAlreadyResolved` if already claimed or
///   cancelled.
/// - Available even while paused (see `admin::set_paused` doc) — a pause
///   must never trap funds already committed to a withdrawal.
/// - Pulls funds from the active strategy if the adapter's idle balance is
///   insufficient, then transfers out.
/// - Errors `Error::NotFound` if `request_id` does not exist.
/// - Errors `Error::InsufficientBalance` if the idle balance plus what the
///   active strategy returns still cannot cover the payout.
/// - Emits a `withdraw_claimed` event.
///
/// The request is marked claimed and its reservation released *before* any
/// external call (strategy withdraw, token transfer), so a hostile token or
/// strategy can never observe it as still claimable.
///
/// Returns the asset amount paid out.
pub fn claim_withdraw(env: &Env, owner: Address, request_id: u64) -> Result<i128, Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    let mut request = load_pending_request(env, &owner, request_id)?;
    let now = env.ledger().timestamp();
    if now < request.claimable_at {
        return Err(Error::CooldownNotElapsed);
    }

    request.claimed_at = Some(now);
    save_request(env, &request);
    release_reserved(env, request.assets)?;

    let idle = storage::idle_balance(env);
    if idle < request.assets {
        let shortfall = request.assets.checked_sub(idle).ok_or(Error::Overflow)?;
        let info = strategy::active_strategy(env).ok_or(Error::InsufficientBalance)?;
        let recovered = strategy::withdraw_from_strategy(env, &info.address, shortfall)?;
        if recovered < shortfall {
            return Err(Error::InsufficientBalance);
        }
    }

    storage::transfer_out(env, &owner, request.assets)?;

    events::publish_withdraw_claimed(env, request_id, &owner, request.assets);

    Ok(request.assets)
}

/// Cancel a pending withdrawal request and re-mint the shares back to
/// `owner` at the **current** exchange rate (not the rate at request time —
/// the shares were already burned, so re-minting uses `convert_to_shares`
/// on the request's fixed asset amount).
///
/// - `owner.require_auth()`; errors `Error::Unauthorized` if `owner` is not
///   the request's owner.
/// - Errors `Error::WithdrawAlreadyResolved` if already claimed or
///   cancelled.
/// - Errors `Error::NotFound` if `request_id` does not exist.
/// - Errors `Error::InvalidAmount` if the request's assets would re-mint `0`
///   shares at the current rate (the request is left pending, so the owner
///   can still claim it instead of silently losing the assets).
/// - Available while paused, like `claim_withdraw`: it only restores the
///   owner's own shares and moves no funds.
/// - Emits a `withdraw_cancelled` event.
pub fn cancel_withdraw(env: &Env, owner: Address, request_id: u64) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    let mut request = load_pending_request(env, &owner, request_id)?;

    // Price the re-mint while the request's assets are still reserved (i.e.
    // excluded from total_assets), exactly as a fresh deposit of those
    // assets would be priced.
    let shares = accounting::convert_to_shares(env, request.assets)?;
    if shares == 0 {
        return Err(Error::InvalidAmount);
    }

    let now = env.ledger().timestamp();
    let position_key = DataKey::Position(owner.clone());
    let mut position: Position =
        env.storage()
            .persistent()
            .get(&position_key)
            .unwrap_or(Position {
                owner: owner.clone(),
                shares: 0,
                created_at: now,
                updated_at: now,
            });
    let new_position_shares = position.shares.checked_add(shares).ok_or(Error::Overflow)?;
    let new_total_shares = accounting::total_shares(env)
        .checked_add(shares)
        .ok_or(Error::Overflow)?;

    release_reserved(env, request.assets)?;
    accounting::set_total_shares(env, new_total_shares);
    position.shares = new_position_shares;
    position.updated_at = now;
    env.storage().persistent().set(&position_key, &position);
    storage::extend_persistent_ttl(env, &position_key);

    request.cancelled_at = Some(now);
    save_request(env, &request);

    events::publish_withdraw_cancelled(env, request_id, &owner, request.assets, shares);

    Ok(())
}

/// Read a withdrawal request by id, or `Error::NotFound`.
pub fn get_withdraw_request(env: &Env, request_id: u64) -> Result<WithdrawRequest, Error> {
    let key = DataKey::WithdrawRequest(request_id);
    let request = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(request)
}
