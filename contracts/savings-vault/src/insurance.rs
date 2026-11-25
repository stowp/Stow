//! Savings insurance fund (#435).
//!
//! A pool that collects a small premium on deposits and pays out approved
//! claims. The admin sets the premium rate and approves claims; users
//! redeem approved claims to receive funds from the pool.

use soroban_sdk::{Address, Env};

use crate::admin;
use crate::error::Error;
use crate::events::{
    TOPIC_INSURANCE_CLAIM_APPROVED, TOPIC_INSURANCE_CLAIM_REDEEMED, TOPIC_INSURANCE_FUNDED,
    TOPIC_INSURANCE_PREMIUM_SET,
};
use crate::storage::extend_instance_ttl;
use crate::types::{DataKey, InsuranceClaimRecord};

/// The insurance premium rate in basis points, collected on each deposit.
/// Defaults to 0 (no premium).
pub fn premium_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::InsurancePremiumBps)
        .unwrap_or(0)
}

/// Set the insurance premium rate. Admin-only. `0` disables the premium.
pub fn set_premium_bps(env: &Env, caller: Address, bps: u32) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_admin = admin::admin(env)?;
    caller.require_auth();
    if caller != current_admin {
        return Err(Error::Unauthorized);
    }

    if bps > 10_000 {
        return Err(Error::InvalidParameters);
    }

    env.storage()
        .instance()
        .set(&DataKey::InsurancePremiumBps, &bps);

    env.events().publish(
        (TOPIC_INSURANCE_PREMIUM_SET,),
        (caller, bps, env.ledger().timestamp()),
    );

    Ok(())
}

/// The current insurance fund balance.
pub fn fund_balance(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::InsuranceFundBalance)
        .unwrap_or(0)
}

/// Add funds to the insurance pool. Admin-only. The tokens are transferred
/// from the caller into the contract.
pub fn fund(env: &Env, caller: Address, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_admin = admin::admin(env)?;
    caller.require_auth();
    if caller != current_admin {
        return Err(Error::Unauthorized);
    }

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    crate::storage::transfer_in(env, &caller, amount)?;

    let balance = fund_balance(env);
    let new_balance = balance.checked_add(amount).ok_or(Error::Overflow)?;
    env.storage()
        .instance()
        .set(&DataKey::InsuranceFundBalance, &new_balance);

    env.events().publish(
        (TOPIC_INSURANCE_FUNDED,),
        (caller, amount, new_balance, env.ledger().timestamp()),
    );

    Ok(())
}

/// Collect insurance premium on a deposit. Called internally by deposit
/// functions. Returns the premium amount deducted (0 if no premium).
pub fn collect_premium(env: &Env, deposit_amount: i128) -> Result<i128, Error> {
    let bps = premium_bps(env);
    if bps == 0 {
        return Ok(0);
    }

    let premium = deposit_amount
        .checked_mul(bps as i128)
        .ok_or(Error::Overflow)?
        / 10_000;

    if premium > 0 {
        let balance = fund_balance(env);
        let new_balance = balance.checked_add(premium).ok_or(Error::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::InsuranceFundBalance, &new_balance);
    }

    Ok(premium)
}

/// The maximum claim amount in basis points of the fund balance. Defaults
/// to 1000 (10%).
pub fn max_claim_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::InsuranceMaxClaimBps)
        .unwrap_or(1_000)
}

/// Set the maximum claim amount in basis points. Admin-only.
pub fn set_max_claim_bps(env: &Env, caller: Address, bps: u32) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_admin = admin::admin(env)?;
    caller.require_auth();
    if caller != current_admin {
        return Err(Error::Unauthorized);
    }

    if bps > 10_000 {
        return Err(Error::InvalidParameters);
    }

    env.storage()
        .instance()
        .set(&DataKey::InsuranceMaxClaimBps, &bps);

    Ok(())
}

/// Approve an insurance claim for a user. Admin-only.
pub fn approve_claim(
    env: &Env,
    caller: Address,
    claimant: Address,
    amount: i128,
) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_admin = admin::admin(env)?;
    caller.require_auth();
    if caller != current_admin {
        return Err(Error::Unauthorized);
    }

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let balance = fund_balance(env);
    let max_bps = max_claim_bps(env);
    let max_amount = balance
        .checked_mul(max_bps as i128)
        .ok_or(Error::Overflow)?
        / 10_000;

    if amount > max_amount {
        return Err(Error::DepositCapExceeded);
    }

    if amount > balance {
        return Err(Error::InsufficientBalance);
    }

    let key = DataKey::InsuranceClaim(claimant.clone());
    if let Some(existing) = env
        .storage()
        .persistent()
        .get::<_, InsuranceClaimRecord>(&key)
    {
        if !existing.redeemed {
            return Err(Error::ConflictingState);
        }
    }

    let now = env.ledger().timestamp();
    let claim = InsuranceClaimRecord {
        claimant: claimant.clone(),
        amount,
        approved_at: now,
        redeemed: false,
    };

    env.storage().persistent().set(&key, &claim);
    crate::storage::extend_persistent_ttl(env, &key);

    env.events()
        .publish((TOPIC_INSURANCE_CLAIM_APPROVED,), (claimant, amount, now));

    Ok(())
}

/// Redeem an approved insurance claim. The claimant receives funds from
/// the insurance pool.
pub fn redeem_claim(env: &Env, claimant: Address) -> Result<i128, Error> {
    extend_instance_ttl(env);
    claimant.require_auth();

    let key = DataKey::InsuranceClaim(claimant.clone());
    let mut claim: InsuranceClaimRecord = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    crate::storage::extend_persistent_ttl(env, &key);

    if claim.redeemed {
        return Err(Error::ConflictingState);
    }

    let balance = fund_balance(env);
    if claim.amount > balance {
        return Err(Error::InsufficientBalance);
    }

    crate::storage::transfer_out(env, &claimant, claim.amount)?;

    let new_balance = balance.checked_sub(claim.amount).ok_or(Error::Overflow)?;
    env.storage()
        .instance()
        .set(&DataKey::InsuranceFundBalance, &new_balance);

    claim.redeemed = true;
    env.storage().persistent().set(&key, &claim);
    crate::storage::extend_persistent_ttl(env, &key);

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_INSURANCE_CLAIM_REDEEMED,),
        (claimant, claim.amount, new_balance, now),
    );

    Ok(claim.amount)
}

/// Read an insurance claim record for a user.
pub fn get_claim(env: &Env, claimant: Address) -> Result<InsuranceClaimRecord, Error> {
    let key = DataKey::InsuranceClaim(claimant);
    let claim = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    crate::storage::extend_persistent_ttl(env, &key);
    Ok(claim)
}
