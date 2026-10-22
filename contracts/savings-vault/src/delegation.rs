//! Savings delegation — authorize a delegate to manage savings on the
//! owner's behalf.
//!
//! An owner grants a [`Delegation`] to a delegate address with a
//! [`PermissionLevel`] (`ViewOnly`, `Deposit`, or `Full`) and an optional
//! expiry.  The delegate can then perform savings actions on the owner's
//! account within their permission level until the delegation is revoked or
//! expires.
//!
//! ## Lifecycle
//!
//! 1. [`delegate_savings`] — owner creates a new delegation (grant).
//! 2. [`update_delegation`] — owner changes the level or expiry of an
//!    existing delegation.
//! 3. [`revoke_delegation`] — owner removes a delegation; the delegate
//!    immediately loses access.
//! 4. [`delegated_deposit`] / [`delegated_withdraw`] — the delegate acts on
//!    the owner's flexible savings account, within their permission level.
//!
//! ## Permission model
//!
//! `PermissionLevel` is ordered `ViewOnly < Deposit < Full`:
//!
//! - **ViewOnly** — can read the owner's account via `get_account`; cannot
//!   deposit or withdraw.
//! - **Deposit** — can deposit into the owner's flexible account (funds come
//!   from the delegate's wallet); cannot withdraw.
//! - **Full** — can deposit and withdraw.  Withdrawals are always sent to
//!   the **owner's** wallet, never the delegate's.
//!
//! ## Guardrails
//!
//! - Self-delegation is blocked (`Error::SelfDelegation`).
//! - Duplicate delegations for the same `(owner, delegate)` pair are blocked
//!   (`Error::DelegationAlreadyExists`); use [`update_delegation`] to change
//!   an existing delegation.
//! - Expired delegations are treated as invalid on every delegated action
//!   (`Error::DelegationExpired`).
//! - Delegated withdrawals require `Full` permission and always transfer
//!   funds to the owner's address, never the delegate's.

use soroban_sdk::{Address, Env};

use crate::admin;
use crate::admin::require_not_paused;
use crate::error::Error;
use crate::events::{
    TOPIC_DELEGATION_GRANTED, TOPIC_DELEGATION_REVOKED, TOPIC_DELEGATION_UPDATED, TOPIC_DEPOSIT,
    TOPIC_WITHDRAW,
};
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, Delegation, FlexibleAccount, PermissionLevel};

// --- delegation management ------------------------------------------------

/// Grant a new delegation: authorize `delegate` to manage `owner`'s savings
/// at `level`, optionally expiring at `expires_at` (a ledger timestamp).
///
/// Owner-only (`owner.require_auth()`).  Blocks self-delegation and
/// duplicate delegations.  Emits a `delegation_granted` event.
///
/// Errors:
/// - `InvalidAddress` — self-delegation attempted (`owner == delegate`)
/// - `ConflictingState` — a delegation for this `(owner, delegate)` pair
///   already exists; use [`update_delegation`] instead
/// - `InvalidTimestamp` — `expires_at` is set but not strictly in the future
/// - `NotInitialized`, `Paused`
pub fn delegate_savings(
    env: &Env,
    owner: Address,
    delegate: Address,
    level: PermissionLevel,
    expires_at: Option<u64>,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    owner.require_auth();

    if owner == delegate {
        return Err(Error::InvalidAddress); // self-delegation not permitted
    }
    validate_expiry(env, expires_at)?;

    let key = DataKey::Delegation(owner.clone(), delegate.clone());
    if env.storage().persistent().has(&key) {
        return Err(Error::ConflictingState); // delegation already exists for this pair
    }

    let now = env.ledger().timestamp();
    let delegation = Delegation {
        owner: owner.clone(),
        delegate: delegate.clone(),
        level,
        expires_at,
        created_at: now,
        updated_at: now,
    };

    env.storage().persistent().set(&key, &delegation);
    storage::extend_persistent_ttl(env, &key);

    let exp_val = expires_at.unwrap_or(0);
    env.events().publish(
        (TOPIC_DELEGATION_GRANTED, owner.clone(), delegate.clone()),
        (owner, delegate, level, exp_val, now),
    );

    Ok(())
}

/// Update an existing delegation's permission level and/or expiry.
///
/// Owner-only (`owner.require_auth()`).  The delegation must already exist.
/// Emits a `delegation_updated` event.
///
/// Errors:
/// - `NotFound` — no delegation exists for this `(owner, delegate)` pair
/// - `InvalidTimestamp` — `expires_at` is set but not strictly in the future
/// - `NotInitialized`, `Paused`
pub fn update_delegation(
    env: &Env,
    owner: Address,
    delegate: Address,
    level: PermissionLevel,
    expires_at: Option<u64>,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    owner.require_auth();

    validate_expiry(env, expires_at)?;

    let key = DataKey::Delegation(owner.clone(), delegate.clone());
    let mut delegation: Delegation = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?; // no delegation exists for this pair
    storage::extend_persistent_ttl(env, &key);

    let now = env.ledger().timestamp();
    delegation.level = level;
    delegation.expires_at = expires_at;
    delegation.updated_at = now;

    env.storage().persistent().set(&key, &delegation);
    storage::extend_persistent_ttl(env, &key);

    let exp_val = expires_at.unwrap_or(0);
    env.events().publish(
        (TOPIC_DELEGATION_UPDATED, owner.clone(), delegate.clone()),
        (owner, delegate, level, exp_val, now),
    );

    Ok(())
}

/// Revoke a delegation.  Owner-only (`owner.require_auth()`).  The delegate
/// immediately loses access.  Emits a `delegation_revoked` event.
///
/// Errors:
/// - `NotFound` — no delegation exists for this `(owner, delegate)` pair
/// - `NotInitialized`, `Paused`
pub fn revoke_delegation(env: &Env, owner: Address, delegate: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    owner.require_auth();

    let key = DataKey::Delegation(owner.clone(), delegate.clone());
    if !env.storage().persistent().has(&key) {
        return Err(Error::NotFound); // no delegation exists to revoke
    }

    env.storage().persistent().remove(&key);

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_DELEGATION_REVOKED, owner.clone(), delegate.clone()),
        (owner, delegate, now),
    );

    Ok(())
}

/// Read a delegation by `(owner, delegate)` pair.
///
/// Errors: `NotFound` — no delegation exists for this pair.
pub fn get_delegation(env: &Env, owner: Address, delegate: Address) -> Result<Delegation, Error> {
    let key = DataKey::Delegation(owner, delegate);
    let delegation: Delegation = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(delegation)
}

// --- internal helpers -----------------------------------------------------

/// Validate that an optional expiry timestamp is strictly in the future.
fn validate_expiry(env: &Env, expires_at: Option<u64>) -> Result<(), Error> {
    if let Some(exp) = expires_at {
        if exp <= env.ledger().timestamp() {
            return Err(Error::InvalidTimestamp);
        }
    }
    Ok(())
}

/// Verify that `delegate` has at least `required` permission for `owner`'s
/// savings, and that the delegation has not expired.  Returns the live
/// [`Delegation`] on success.
///
/// Error mapping (using existing variants to stay within the 60-variant
/// `#[contracterror]` limit):
/// - `NotFound` — no delegation for this `(owner, delegate)` pair
/// - `OperationExpired` — delegation exists but has passed its `expires_at`
/// - `Unauthorized` — delegation level is below `required`
pub fn check_delegation(
    env: &Env,
    owner: &Address,
    delegate: &Address,
    required: PermissionLevel,
) -> Result<Delegation, Error> {
    let key = DataKey::Delegation(owner.clone(), delegate.clone());
    let delegation: Delegation = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?; // no delegation for this pair
    storage::extend_persistent_ttl(env, &key);

    if let Some(expires_at) = delegation.expires_at {
        if env.ledger().timestamp() >= expires_at {
            return Err(Error::OperationExpired); // delegation has expired
        }
    }

    if delegation.level < required {
        return Err(Error::Unauthorized); // level below required permission
    }

    Ok(delegation)
}

// --- delegated flexible savings ------------------------------------------

/// Deposit `amount` into `owner`'s flexible account on the delegate's
/// behalf.  The delegate authenticates; funds come from the **delegate's**
/// wallet.
///
/// Requires at least `Deposit` permission.  Applies the same deposit-cap and
/// minimum-deposit guards as a regular `deposit`.  Emits a `deposit` event
/// keyed by the owner.
///
/// Errors: `NotFound` (no delegation), `OperationExpired` (delegation
/// expired), `Unauthorized` (level below `Deposit`), `InvalidAmount`,
/// `DepositBelowMinimum`, `DepositCapExceeded`, `Overflow`,
/// `NotInitialized`, `Paused`.
pub fn delegated_deposit(
    env: &Env,
    delegate: Address,
    owner: Address,
    amount: i128,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    delegate.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    check_delegation(env, &owner, &delegate, PermissionLevel::Deposit)?;

    let min = admin::min_deposit(env);
    if min > 0 && amount < min {
        return Err(Error::DepositBelowMinimum);
    }

    let now = env.ledger().timestamp();
    let key = DataKey::Flexible(owner.clone());
    let existing: Option<FlexibleAccount> = env.storage().persistent().get(&key);
    if existing.is_some() {
        storage::extend_persistent_ttl(env, &key);
    }
    let mut account = existing.unwrap_or(FlexibleAccount {
        owner: owner.clone(),
        balance: 0,
        created_at: now,
        updated_at: now,
    });

    let new_balance = account.balance.checked_add(amount).ok_or(Error::Overflow)?;

    let cap = admin::deposit_cap(env);
    if cap > 0 && new_balance > cap {
        return Err(Error::DepositCapExceeded);
    }

    // Funds come from the delegate's wallet, not the owner's.
    storage::transfer_in(env, &delegate, amount)?;

    account.balance = new_balance;
    account.updated_at = now;
    env.storage().persistent().set(&key, &account);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_DEPOSIT, owner.clone()),
        (owner, amount, new_balance, now),
    );

    Ok(())
}

/// Withdraw `amount` from `owner`'s flexible account.  The delegate
/// authenticates, but funds are always transferred to the **owner's**
/// wallet, never the delegate's.
///
/// Requires `Full` permission (delegates with `Deposit` or `ViewOnly` cannot
/// withdraw).  Emits a `withdraw` event keyed by the owner.
///
/// Errors: `NotFound` (no delegation or no flexible account),
/// `OperationExpired` (delegation expired), `Unauthorized` (level below
/// `Full`), `InvalidAmount`, `InsufficientBalance`, `Overflow`,
/// `NotInitialized`, `Paused`.
pub fn delegated_withdraw(
    env: &Env,
    delegate: Address,
    owner: Address,
    amount: i128,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    delegate.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    check_delegation(env, &owner, &delegate, PermissionLevel::Full)?;

    let key = DataKey::Flexible(owner.clone());
    let mut account: FlexibleAccount = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    if amount > account.balance {
        return Err(Error::InsufficientBalance);
    }

    let new_balance = account.balance.checked_sub(amount).ok_or(Error::Overflow)?;

    // Funds always go to the owner's wallet, never the delegate's.
    storage::transfer_out(env, &owner, amount)?;

    let now = env.ledger().timestamp();
    account.balance = new_balance;
    account.updated_at = now;
    env.storage().persistent().set(&key, &account);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_WITHDRAW, owner.clone()),
        (owner, amount, new_balance, now),
    );

    Ok(())
}
