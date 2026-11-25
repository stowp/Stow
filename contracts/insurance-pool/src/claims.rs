//! Claim filing, oracle verification and automatic payouts.
//!
//! 1. **File** — the policy holder calls [`file_claim`] with the amount lost
//!    and the oracle's id for the contract-failure incident. A policy can
//!    have one pending claim at a time, and the amount cannot exceed its
//!    coverage.
//! 2. **Verify** — anyone calls [`process_claim`]. The pool asks the
//!    configured [`IncidentOracle`] for the incident's status:
//!    - `Unknown`   → the call fails with `ClaimNotVerified`; the claim stays
//!      pending and can be processed again later.
//!    - `Denied`    → the claim is rejected; the policy stays active.
//!    - `Confirmed` → the payout is sent to the holder in the same call, the
//!      policy is marked claimed and its coverage released.

use soroban_sdk::{contractclient, contracttype, token, Address, BytesN, Env, Symbol};

use crate::{
    config, load_persistent, load_policy, save_persistent, save_policy, save_stats, stats,
    DataKey, Error, PolicyStatus,
};

/// The oracle's verdict on a reported contract failure.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IncidentStatus {
    /// Not yet investigated (or unknown to the oracle).
    Unknown,
    /// The failure happened and is covered.
    Confirmed,
    /// The incident is not a covered failure.
    Denied,
}

/// Interface the incident oracle must implement.
#[contractclient(name = "IncidentOracleClient")]
pub trait IncidentOracle {
    fn incident_status(env: Env, incident_id: BytesN<32>) -> IncidentStatus;
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimStatus {
    Pending,
    Paid,
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub id: u64,
    pub policy_id: u64,
    pub holder: Address,
    pub amount: i128,
    pub incident_id: BytesN<32>,
    pub status: ClaimStatus,
    pub filed_at: u64,
    pub resolved_at: Option<u64>,
}

pub(crate) fn get_claim(env: &Env, claim_id: u64) -> Result<Claim, Error> {
    load_persistent(env, &DataKey::Claim(claim_id)).ok_or(Error::ClaimNotFound)
}

/// File a claim against `policy_id`. See the module docs.
///
/// Errors: `PolicyNotFound`, `Unauthorized` (caller is not the holder),
/// `PolicyInactive` (claimed, expired, or outside its term), `InvalidAmount`,
/// `ClaimExceedsCoverage`, `ClaimPending`.
pub(crate) fn file_claim(
    env: &Env,
    holder: Address,
    policy_id: u64,
    amount: i128,
    incident_id: BytesN<32>,
) -> Result<u64, Error> {
    config(env)?;
    holder.require_auth();

    let policy = load_policy(env, policy_id)?;
    if policy.holder != holder {
        return Err(Error::Unauthorized);
    }
    let now = env.ledger().timestamp();
    if policy.status != PolicyStatus::Active || now < policy.start || now >= policy.end {
        return Err(Error::PolicyInactive);
    }
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if amount > policy.coverage {
        return Err(Error::ClaimExceedsCoverage);
    }
    let pending_key = DataKey::PendingClaim(policy_id);
    if env.storage().persistent().has(&pending_key) {
        return Err(Error::ClaimPending);
    }

    let mut stats = stats(env);
    let id = stats.claim_count + 1;
    stats.claim_count = id;
    save_stats(env, &stats);

    let claim = Claim {
        id,
        policy_id,
        holder: holder.clone(),
        amount,
        incident_id: incident_id.clone(),
        status: ClaimStatus::Pending,
        filed_at: now,
        resolved_at: None,
    };
    save_persistent(env, &DataKey::Claim(id), &claim);
    save_persistent(env, &pending_key, &id);

    env.events().publish(
        (Symbol::new(env, "claim_filed"), holder),
        (id, policy_id, amount, incident_id),
    );
    Ok(id)
}

/// Verify a pending claim with the oracle and settle it. See the module docs.
///
/// Errors: `ClaimNotFound`, `ClaimAlreadyResolved`, `OracleUnavailable`,
/// `ClaimNotVerified`, `InsufficientPoolFunds` (claim stays pending).
pub(crate) fn process_claim(env: &Env, claim_id: u64) -> Result<ClaimStatus, Error> {
    let config = config(env)?;
    let mut claim = get_claim(env, claim_id)?;
    if claim.status != ClaimStatus::Pending {
        return Err(Error::ClaimAlreadyResolved);
    }

    let verdict = match IncidentOracleClient::new(env, &config.oracle)
        .try_incident_status(&claim.incident_id)
    {
        Ok(Ok(status)) => status,
        _ => return Err(Error::OracleUnavailable),
    };

    let now = env.ledger().timestamp();
    match verdict {
        IncidentStatus::Unknown => return Err(Error::ClaimNotVerified),
        IncidentStatus::Denied => {
            claim.status = ClaimStatus::Rejected;
            claim.resolved_at = Some(now);
            save_persistent(env, &DataKey::Claim(claim_id), &claim);
            env.storage()
                .persistent()
                .remove(&DataKey::PendingClaim(claim.policy_id));
            env.events().publish(
                (Symbol::new(env, "claim_rejected"), claim.holder),
                (claim_id, claim.policy_id),
            );
        }
        IncidentStatus::Confirmed => {
            let mut stats = stats(env);
            if claim.amount > stats.balance {
                return Err(Error::InsufficientPoolFunds);
            }
            let mut policy = load_policy(env, claim.policy_id)?;

            token::Client::new(env, &config.token).transfer(
                &env.current_contract_address(),
                &claim.holder,
                &claim.amount,
            );

            stats.balance -= claim.amount;
            stats.total_payouts = stats
                .total_payouts
                .checked_add(claim.amount)
                .ok_or(Error::Overflow)?;
            stats.active_coverage = stats.active_coverage.saturating_sub(policy.coverage).max(0);
            save_stats(env, &stats);

            policy.status = PolicyStatus::Claimed;
            save_policy(env, &policy);

            claim.status = ClaimStatus::Paid;
            claim.resolved_at = Some(now);
            save_persistent(env, &DataKey::Claim(claim_id), &claim);
            env.storage()
                .persistent()
                .remove(&DataKey::PendingClaim(claim.policy_id));

            env.events().publish(
                (Symbol::new(env, "claim_paid"), claim.holder),
                (claim_id, claim.policy_id, claim.amount),
            );
        }
    }
    Ok(claim.status)
}
