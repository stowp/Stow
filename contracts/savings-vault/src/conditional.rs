//! Conditional withdrawals from flexible savings (#639).
//!
//! An owner registers a single pending rule with [`set_withdrawal_condition`]:
//! "pay me `amount` from my flexible account once `condition` holds". The
//! rule is executed by [`execute_conditional_withdrawal`], which is
//! permissionless so an off-chain keeper can automate it — funds are only
//! ever paid to the rule's owner, so a third-party caller gains nothing.
//!
//! Supported conditions ([`WithdrawalCondition`]):
//!
//! - `PriceAbove(asset, threshold)` — the oracle price of `asset` must be
//!   strictly greater than `threshold`. The price is read from the
//!   admin-configured oracle ([`set_price_oracle`]) at execution time; a
//!   missing oracle or a failing oracle call errors `OracleUnavailable`.
//! - `AfterDate(timestamp)` — the ledger timestamp must be `>= timestamp`.
//! - `BalanceAbove(amount)` — the owner's flexible balance must be strictly
//!   greater than `amount`.
//!
//! Until the condition holds, execution fails with `ConditionNotMet`. A rule
//! is one-shot: it is removed once it executes, and the owner may cancel it
//! at any time with [`cancel_withdrawal_condition`].

use soroban_sdk::{contractclient, Address, Env};

use crate::admin;
use crate::error::Error;
use crate::events::{
    TOPIC_CONDITIONAL_WITHDRAWAL, TOPIC_PRICE_ORACLE_SET, TOPIC_WITHDRAWAL_CONDITION_CANCELLED,
    TOPIC_WITHDRAWAL_CONDITION_SET,
};
use crate::storage::{self, extend_instance_ttl};
use crate::types::{ConditionalWithdrawalRule, DataKey, FlexibleAccount, WithdrawalCondition};

/// Minimal price-oracle interface consulted for `PriceAbove` conditions.
///
/// `price(asset)` returns the latest price of `asset` in the oracle's fixed
/// price units; conditions compare against thresholds in the same units.
#[allow(dead_code)]
#[contractclient(name = "PriceOracleClient")]
pub trait PriceOracle {
    fn price(env: Env, asset: Address) -> i128;
}

/// Configure the price oracle used by price-based conditions. Admin-only.
pub fn set_price_oracle(env: &Env, caller: Address, oracle: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != admin {
        return Err(Error::Unauthorized);
    }

    env.storage().instance().set(&DataKey::PriceOracle, &oracle);

    env.events().publish(
        (TOPIC_PRICE_ORACLE_SET,),
        (caller, oracle, env.ledger().timestamp()),
    );

    Ok(())
}

/// The configured price oracle, if any.
pub fn price_oracle(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PriceOracle)
}

/// Register (or replace) the owner's pending conditional withdrawal.
///
/// - `owner.require_auth()`; the owner must have a flexible account.
/// - Errors `InvalidAmount` if `amount <= 0`, `InvalidCondition` for a
///   non-positive price threshold, a negative balance threshold or a date
///   that is not in the future, `OracleUnavailable` for a price condition with no oracle set.
pub fn set_withdrawal_condition(
    env: &Env,
    owner: Address,
    condition: WithdrawalCondition,
    amount: i128,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let now = env.ledger().timestamp();
    match &condition {
        WithdrawalCondition::PriceAbove(_, threshold) => {
            if *threshold <= 0 {
                return Err(Error::InvalidCondition);
            }
            if price_oracle(env).is_none() {
                return Err(Error::OracleUnavailable);
            }
        }
        WithdrawalCondition::AfterDate(timestamp) => {
            if *timestamp <= now {
                return Err(Error::InvalidCondition);
            }
        }
        WithdrawalCondition::BalanceAbove(threshold) => {
            if *threshold < 0 {
                return Err(Error::InvalidCondition);
            }
        }
    }

    let account_key = DataKey::Flexible(owner.clone());
    if !env.storage().persistent().has(&account_key) {
        return Err(Error::NotFound);
    }
    storage::extend_persistent_ttl(env, &account_key);

    let rule = ConditionalWithdrawalRule {
        owner: owner.clone(),
        condition: condition.clone(),
        amount,
        created_at: now,
    };
    let key = DataKey::WithdrawalCondition(owner.clone());
    env.storage().persistent().set(&key, &rule);
    storage::extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_WITHDRAWAL_CONDITION_SET, owner.clone()),
        (owner, condition, amount, now),
    );

    Ok(())
}

/// Cancel the owner's pending conditional withdrawal.
///
/// Errors `NotFound` if no rule is set.
pub fn cancel_withdrawal_condition(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();

    let key = DataKey::WithdrawalCondition(owner.clone());
    let rule: ConditionalWithdrawalRule = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    env.storage().persistent().remove(&key);

    env.events().publish(
        (TOPIC_WITHDRAWAL_CONDITION_CANCELLED, owner.clone()),
        (owner, rule.condition, rule.amount, env.ledger().timestamp()),
    );

    Ok(())
}

/// Read the owner's pending conditional withdrawal, if any.
pub fn get_withdrawal_condition(env: &Env, owner: Address) -> Option<ConditionalWithdrawalRule> {
    let key = DataKey::WithdrawalCondition(owner);
    let rule: Option<ConditionalWithdrawalRule> = env.storage().persistent().get(&key);
    if rule.is_some() {
        storage::extend_persistent_ttl(env, &key);
    }
    rule
}

/// Execute the owner's conditional withdrawal if its condition holds.
///
/// Permissionless: anyone may trigger it, but funds are always paid to
/// `owner`. Returns the amount withdrawn.
///
/// Errors: `NotFound` if no rule (or no account) exists, `ConditionNotMet`
/// while the condition does not hold, `OracleUnavailable` if a price
/// condition cannot be validated, `InsufficientBalance` if the account no
/// longer holds `amount`.
pub fn execute_conditional_withdrawal(env: &Env, owner: Address) -> Result<i128, Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;

    let rule_key = DataKey::WithdrawalCondition(owner.clone());
    let rule: ConditionalWithdrawalRule = env
        .storage()
        .persistent()
        .get(&rule_key)
        .ok_or(Error::NotFound)?;

    let account_key = DataKey::Flexible(owner.clone());
    let mut account: FlexibleAccount = env
        .storage()
        .persistent()
        .get(&account_key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &account_key);

    let now = env.ledger().timestamp();
    let observed = check_condition(env, &rule.condition, &account, now)?;

    if rule.amount > account.balance {
        return Err(Error::InsufficientBalance);
    }
    let new_balance = account
        .balance
        .checked_sub(rule.amount)
        .ok_or(Error::Overflow)?;

    // One-shot: clear the rule before moving funds.
    env.storage().persistent().remove(&rule_key);

    storage::transfer_out(env, &owner, rule.amount)?;

    account.balance = new_balance;
    account.updated_at = now;
    env.storage().persistent().set(&account_key, &account);
    storage::extend_persistent_ttl(env, &account_key);

    env.events().publish(
        (TOPIC_CONDITIONAL_WITHDRAWAL, owner.clone()),
        (
            owner,
            rule.amount,
            rule.condition,
            observed,
            new_balance,
            now,
        ),
    );

    Ok(rule.amount)
}

/// Evaluate `condition`, returning the observed value (price, timestamp or
/// balance) when it holds, or `ConditionNotMet` otherwise.
fn check_condition(
    env: &Env,
    condition: &WithdrawalCondition,
    account: &FlexibleAccount,
    now: u64,
) -> Result<i128, Error> {
    match condition {
        WithdrawalCondition::PriceAbove(asset, threshold) => {
            let oracle = price_oracle(env).ok_or(Error::OracleUnavailable)?;
            let price = match PriceOracleClient::new(env, &oracle).try_price(asset) {
                Ok(Ok(price)) => price,
                _ => return Err(Error::OracleUnavailable),
            };
            if price > *threshold {
                Ok(price)
            } else {
                Err(Error::ConditionNotMet)
            }
        }
        WithdrawalCondition::AfterDate(timestamp) => {
            if now >= *timestamp {
                Ok(now as i128)
            } else {
                Err(Error::ConditionNotMet)
            }
        }
        WithdrawalCondition::BalanceAbove(threshold) => {
            if account.balance > *threshold {
                Ok(account.balance)
            } else {
                Err(Error::ConditionNotMet)
            }
        }
    }
}
