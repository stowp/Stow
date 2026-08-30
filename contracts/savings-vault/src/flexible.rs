//! Flexible savings — deposit and withdraw any time.

use soroban_sdk::{Address, Env};

use crate::admin;
use crate::error::Error;
use crate::events::{TOPIC_DEPOSIT, TOPIC_WITHDRAW};
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, FlexibleAccount};

/// Deposit `amount` of the vault token into the caller's flexible account.
///
/// - `from.require_auth()`. The account is keyed by `from`, so only the
///   real owner of that address can ever reach their own account — no
///   separate ownership comparison is needed or possible.
/// - Transfers tokens from `from` into the contract.
/// - Creates the account on first deposit; increments balance otherwise.
/// - Rejects the deposit with `DepositCapExceeded` if an admin-configured
///   per-account cap is set (non-zero) and the resulting balance would
///   exceed it.
/// - Rejects the deposit with `DepositBelowMinimum` if an admin-configured
///   minimum deposit is set (non-zero) and `amount` is below it — guards
///   against dust deposits that waste storage.
/// - Emits a `deposit` event.
///
/// Errors: `InvalidAmount` if `amount <= 0`, `NotInitialized` if the vault
/// has not been initialized, `DepositBelowMinimum`, `DepositCapExceeded`,
/// `Overflow` if the resulting balance would not fit in `i128`.
pub fn deposit(env: &Env, from: Address, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);
    from.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let min = admin::min_deposit(env);
    if min > 0 && amount < min {
        return Err(Error::DepositBelowMinimum);
    }

    let now = env.ledger().timestamp();
    let key = DataKey::Flexible(from.clone());
    let existing: Option<FlexibleAccount> = env.storage().persistent().get(&key);
    if existing.is_some() {
        storage::extend_persistent_ttl(env, &key);
    }
    let mut account = existing.unwrap_or(FlexibleAccount {
        owner: from.clone(),
        balance: 0,
        created_at: now,
        updated_at: now,
    });

    let new_balance = account.balance.checked_add(amount).ok_or(Error::Overflow)?;

    let cap = admin::deposit_cap(env);
    if cap > 0 && new_balance > cap {
        return Err(Error::DepositCapExceeded);
    }

    storage::transfer_in(env, &from, amount)?;

    account.balance = new_balance;
    account.updated_at = now;
    env.storage().persistent().set(&key, &account);
    storage::extend_persistent_ttl(env, &key);

    env.events()
        .publish((TOPIC_DEPOSIT, from.clone()), (from, amount, new_balance, now));

    Ok(())
}

/// Withdraw `amount` from the caller's flexible account back to their wallet.
///
/// - `owner.require_auth()`.
/// - Errors `InsufficientBalance` if `amount > balance`.
/// - Transfers tokens out and decrements balance.
/// - Emits a `withdraw` event.
///
/// ## Payout destination
///
/// There is no separate "recipient" parameter: `owner` is simultaneously
/// the address that must authenticate (`require_auth`) and the only address
/// `token_client.transfer` ever pays. A caller cannot redirect funds to a
/// third-party address because the API gives them no way to name one — the
/// only account this call can ever credit is the one it authenticates as.
/// No exception to this exists for flexible (solo) accounts.
pub fn withdraw(env: &Env, owner: Address, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let key = DataKey::Flexible(owner.clone());
    let mut account: FlexibleAccount =
        env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);

    if amount > account.balance {
        return Err(Error::InsufficientBalance);
    }

    let new_balance = account.balance.checked_sub(amount).ok_or(Error::Overflow)?;

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

/// Read the caller's flexible account (or `NotFound`).
pub fn get_account(env: &Env, owner: Address) -> Result<FlexibleAccount, Error> {
    let key = DataKey::Flexible(owner);
    let account = env.storage().persistent().get(&key).ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(account)
}
