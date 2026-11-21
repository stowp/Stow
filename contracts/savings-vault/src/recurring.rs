//! Permissionless execution of user-authorized recurring wallet deposits.

use soroban_sdk::{token, Address, Env};

use crate::admin;
use crate::error::Error;
use crate::events::TOPIC_RECURRING_DEPOSIT_EXECUTED;
use crate::flexible;
use crate::storage::{self, extend_instance_ttl, extend_recurring_ttl};
use crate::types::{DataKey, RecurringDeposit, RecurringFrequency};

/// Create or replace the owner's recurring deposit schedule.
///
/// The owner must authorize this call and separately approve the vault as a
/// SEP-41 spender for enough funds. Each execution consumes `amount` from that
/// allowance. The first execution is due one full interval after setup.
pub fn setup(
    env: &Env,
    owner: Address,
    amount: i128,
    frequency: RecurringFrequency,
) -> Result<u64, Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    admin::require_not_emergency(env)?;
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let next_execution = env
        .ledger()
        .timestamp()
        .checked_add(frequency.seconds())
        .ok_or(Error::Overflow)?;
    let key = DataKey::RecurringDeposit(owner.clone());
    let schedule = RecurringDeposit {
        owner,
        amount,
        frequency,
        next_execution,
    };
    env.storage().persistent().set(&key, &schedule);
    extend_recurring_ttl(env, &key);

    Ok(next_execution)
}

/// Execute a due recurring deposit. Anyone may call this entrypoint.
///
/// The user's wallet balance and SEP-41 allowance must both cover the amount.
/// A successful execution advances the schedule by one interval from the
/// current timestamp, avoiding immediate catch-up executions after delays.
pub fn execute(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    admin::require_not_emergency(env)?;

    let key = DataKey::RecurringDeposit(owner.clone());
    let mut schedule: RecurringDeposit = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    extend_recurring_ttl(env, &key);

    let now = env.ledger().timestamp();
    if now < schedule.next_execution {
        return Err(Error::TimeWindowNotOpen);
    }

    let token_address = storage::get_token(env).ok_or(Error::NotInitialized)?;
    if token::Client::new(env, &token_address).balance(&owner) < schedule.amount {
        return Err(Error::InsufficientBalance);
    }

    let next_execution = now
        .checked_add(schedule.frequency.seconds())
        .ok_or(Error::Overflow)?;

    flexible::deposit_from_allowance(env, owner.clone(), schedule.amount)?;
    schedule.next_execution = next_execution;
    env.storage().persistent().set(&key, &schedule);
    extend_recurring_ttl(env, &key);

    env.events().publish(
        (TOPIC_RECURRING_DEPOSIT_EXECUTED, owner.clone()),
        (
            owner,
            schedule.amount,
            schedule.frequency,
            next_execution,
            now,
        ),
    );

    Ok(())
}

/// Cancel the owner's recurring deposit schedule.
pub fn cancel(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    let key = DataKey::RecurringDeposit(owner);
    if !env.storage().persistent().has(&key) {
        return Err(Error::NotFound);
    }
    extend_recurring_ttl(env, &key);
    env.storage().persistent().remove(&key);
    Ok(())
}

/// Read an owner's recurring deposit schedule, if one is configured.
pub fn get(env: &Env, owner: Address) -> Option<RecurringDeposit> {
    let key = DataKey::RecurringDeposit(owner);
    let schedule = env.storage().persistent().get(&key);
    if schedule.is_some() {
        storage::extend_persistent_ttl(env, &key);
    }
    schedule
}
