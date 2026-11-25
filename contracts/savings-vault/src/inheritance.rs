//! Savings vault inheritance planning (#635).
//!
//! Lets an owner hand their flexible savings to one or more beneficiaries
//! gradually, rather than in one irreversible step.
//!
//! # Lifecycle
//!
//! 1. **Setup** — The owner calls [`setup_inheritance`] with a map of
//!    beneficiaries to shares (basis points summing to exactly `10_000`),
//!    an inactivity period, a partial-access percentage and an optional
//!    proof-of-death verifier. Emits `InheritanceSetup`.
//! 2. **Activity** — Every owner deposit or withdrawal (and the explicit
//!    [`check_in`]) resets the inactivity clock. A live owner also voids any
//!    proof of death that was attested against them.
//! 3. **Partial access** — Once `now >= last_active_at + inactivity_period`
//!    each beneficiary may claim `partial_access_bps` of their share.
//! 4. **Proof of death** — The configured verifier attests a proof hash with
//!    [`verify_death_proof`]. The rest of every share then unlocks. Plans
//!    without a verifier skip this step and unlock in full at step 3.
//! 5. **Claim** — Each beneficiary calls [`claim_inheritance`] themselves and
//!    receives whatever has unlocked for them and not yet been paid. Emits
//!    `InheritanceClaimed` on every payout. When every share has been paid in
//!    full the plan is removed.
//!
//! All shares are computed against a snapshot of the flexible balance taken
//! at the first claim, so the order in which beneficiaries claim never
//! changes how much each one receives.

use soroban_sdk::{Address, BytesN, Env, Map, Vec};

use crate::admin;
use crate::error::Error;
use crate::events::{
    TOPIC_INHERITANCE_CANCELLED, TOPIC_INHERITANCE_CLAIMED, TOPIC_INHERITANCE_PROOF_VERIFIED,
    TOPIC_INHERITANCE_SETUP,
};
use crate::storage::{self, extend_instance_ttl};
use crate::types::{Beneficiary, DataKey, FlexibleAccount, InheritancePlan};

/// 100% in basis points.
pub const BPS_DENOMINATOR: u32 = 10_000;

// ── Internal helpers ───────────────────────────────────────────────────────

fn load_plan(env: &Env, owner: &Address) -> Result<InheritancePlan, Error> {
    let key = DataKey::Inheritance(owner.clone());
    let plan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(plan)
}

fn save_plan(env: &Env, plan: &InheritancePlan) {
    let key = DataKey::Inheritance(plan.owner.clone());
    env.storage().persistent().set(&key, plan);
    storage::extend_persistent_ttl(env, &key);
}

fn any_claimed(plan: &InheritancePlan) -> bool {
    plan.beneficiaries.iter().any(|b| b.claimed > 0)
}

/// Share of each beneficiary's entitlement unlocked right now, in bps.
/// `0` while the owner is still within the inactivity period.
fn unlocked_bps(env: &Env, plan: &InheritancePlan) -> Result<u32, Error> {
    let unlocks_at = plan
        .last_active_at
        .checked_add(plan.inactivity_period)
        .ok_or(Error::Overflow)?;
    if env.ledger().timestamp() < unlocks_at {
        return Ok(0);
    }
    if plan.verifier.is_some() && plan.proof_verified_at.is_none() {
        return Ok(plan.partial_access_bps);
    }
    Ok(BPS_DENOMINATOR)
}

/// `balance * share_bps * unlocked_bps / 10_000²`, rounded down.
fn entitlement(balance: i128, share_bps: u32, unlocked_bps: u32) -> Result<i128, Error> {
    balance
        .checked_mul(share_bps as i128)
        .and_then(|v| v.checked_mul(unlocked_bps as i128))
        .ok_or(Error::Overflow)?
        .checked_div((BPS_DENOMINATOR as i128) * (BPS_DENOMINATOR as i128))
        .ok_or(Error::DivisionByZero)
}

fn flexible_balance(env: &Env, owner: &Address) -> i128 {
    env.storage()
        .persistent()
        .get::<DataKey, FlexibleAccount>(&DataKey::Flexible(owner.clone()))
        .map(|a| a.balance)
        .unwrap_or(0)
}

// ── Public entrypoints ─────────────────────────────────────────────────────

/// Create (or replace) the owner's inheritance plan.
///
/// # Arguments
/// * `beneficiaries`      — heir address → share in bps. Shares must be
///   non-zero and sum to exactly `10_000`. The owner cannot be an heir.
/// * `inactivity_period`  — seconds of owner inactivity before any access
///   unlocks. Must be non-zero.
/// * `partial_access_bps` — portion of each share claimable after the
///   inactivity period but before proof of death (`0..=10_000`). Ignored
///   when no verifier is set.
/// * `verifier`           — trusted party that attests proof of death.
///   `None` means time-based unlocking alone releases the full share.
///
/// # Errors
/// - `InvalidParameters` — no beneficiaries, owner listed as an heir,
///   zero inactivity period, or `partial_access_bps > 10_000`.
/// - `InvalidShares`     — a zero share, or shares not summing to 10 000.
/// - `InvalidAddress`    — the owner named as their own verifier.
/// - `ConflictingState`  — the existing plan already has paid-out claims.
pub fn setup_inheritance(
    env: &Env,
    owner: Address,
    beneficiaries: Map<Address, u32>,
    inactivity_period: u64,
    partial_access_bps: u32,
    verifier: Option<Address>,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    if beneficiaries.is_empty()
        || inactivity_period == 0
        || partial_access_bps > BPS_DENOMINATOR
    {
        return Err(Error::InvalidParameters);
    }
    if verifier.as_ref() == Some(&owner) {
        return Err(Error::InvalidAddress);
    }

    let mut total: u32 = 0;
    let mut heirs: Vec<Beneficiary> = Vec::new(env);
    for (address, share_bps) in beneficiaries.iter() {
        if address == owner {
            return Err(Error::InvalidParameters);
        }
        if share_bps == 0 {
            return Err(Error::InvalidShares);
        }
        total = total.checked_add(share_bps).ok_or(Error::InvalidShares)?;
        heirs.push_back(Beneficiary {
            address,
            share_bps,
            claimed: 0,
        });
    }
    if total != BPS_DENOMINATOR {
        return Err(Error::InvalidShares);
    }

    let key = DataKey::Inheritance(owner.clone());
    if let Some(existing) = env.storage().persistent().get::<DataKey, InheritancePlan>(&key) {
        if any_claimed(&existing) {
            return Err(Error::ConflictingState);
        }
    }

    let now = env.ledger().timestamp();
    let proof_required = verifier.is_some();
    let plan = InheritancePlan {
        owner: owner.clone(),
        beneficiaries: heirs,
        inactivity_period,
        last_active_at: now,
        partial_access_bps: if proof_required { partial_access_bps } else { BPS_DENOMINATOR },
        verifier,
        proof_hash: None,
        proof_verified_at: None,
        snapshot_balance: None,
        created_at: now,
    };
    let count = plan.beneficiaries.len();
    let partial = plan.partial_access_bps;
    save_plan(env, &plan);

    env.events().publish(
        (TOPIC_INHERITANCE_SETUP, owner.clone()),
        (owner, count, inactivity_period, partial, proof_required, now),
    );
    Ok(())
}

/// Cancel the owner's inheritance plan.
///
/// Errors: `NotFound` if there is no plan.
pub fn cancel_inheritance(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    load_plan(env, &owner)?;
    env.storage()
        .persistent()
        .remove(&DataKey::Inheritance(owner.clone()));

    env.events().publish(
        (TOPIC_INHERITANCE_CANCELLED, owner.clone()),
        (owner, env.ledger().timestamp()),
    );
    Ok(())
}

/// Explicit proof of life: resets the owner's inactivity clock without
/// moving funds.
///
/// Errors: `NotFound` if there is no plan.
pub fn check_in(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    owner.require_auth();
    load_plan(env, &owner)?;
    touch_owner(env, &owner);
    Ok(())
}

/// Record owner activity. Called from flexible deposits and withdrawals.
///
/// Resets the inactivity clock and voids any attested proof of death (the
/// owner has just proven they are alive). The balance snapshot is dropped
/// too unless claims were already paid against it.
pub(crate) fn touch_owner(env: &Env, owner: &Address) {
    let key = DataKey::Inheritance(owner.clone());
    if let Some(mut plan) = env
        .storage()
        .persistent()
        .get::<DataKey, InheritancePlan>(&key)
    {
        plan.last_active_at = env.ledger().timestamp();
        plan.proof_hash = None;
        plan.proof_verified_at = None;
        if !any_claimed(&plan) {
            plan.snapshot_balance = None;
        }
        save_plan(env, &plan);
    }
}

/// Attest the owner's proof of death. Only the plan's verifier may call
/// this, and only after the inactivity period has elapsed.
///
/// Errors: `NotFound` (no plan), `Unauthorized` (no verifier configured or
/// caller is not it), `StillLocked` (owner still within the inactivity
/// period), `ConflictingState` (proof already attested).
pub fn verify_death_proof(
    env: &Env,
    verifier: Address,
    owner: Address,
    proof_hash: BytesN<32>,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    verifier.require_auth();

    let mut plan = load_plan(env, &owner)?;
    if plan.verifier.as_ref() != Some(&verifier) {
        return Err(Error::Unauthorized);
    }
    if plan.proof_verified_at.is_some() {
        return Err(Error::ConflictingState);
    }
    if unlocked_bps(env, &plan)? == 0 {
        return Err(Error::StillLocked);
    }

    let now = env.ledger().timestamp();
    plan.proof_hash = Some(proof_hash.clone());
    plan.proof_verified_at = Some(now);
    save_plan(env, &plan);

    env.events().publish(
        (TOPIC_INHERITANCE_PROOF_VERIFIED, owner.clone()),
        (owner, verifier, proof_hash, now),
    );
    Ok(())
}

/// Pay `beneficiary` everything that has unlocked for them and not yet been
/// claimed. Returns the amount paid.
///
/// Errors: `NotFound` (no plan / no flexible account), `Unauthorized`
/// (caller is not a beneficiary), `StillLocked` (inactivity period not yet
/// elapsed, or nothing unlocked before proof), `InsufficientBalance`
/// (nothing left to claim).
pub fn claim_inheritance(env: &Env, beneficiary: Address, owner: Address) -> Result<i128, Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    beneficiary.require_auth();

    let mut plan = load_plan(env, &owner)?;
    let index = plan
        .beneficiaries
        .iter()
        .position(|b| b.address == beneficiary)
        .ok_or(Error::Unauthorized)? as u32;

    let unlocked = unlocked_bps(env, &plan)?;
    if unlocked == 0 {
        return Err(Error::StillLocked);
    }

    let flex_key = DataKey::Flexible(owner.clone());
    let mut account: FlexibleAccount = env
        .storage()
        .persistent()
        .get(&flex_key)
        .ok_or(Error::NotFound)?;

    let snapshot = match plan.snapshot_balance {
        Some(balance) => balance,
        None => {
            if account.balance <= 0 {
                return Err(Error::InsufficientBalance);
            }
            plan.snapshot_balance = Some(account.balance);
            account.balance
        }
    };

    let mut heir = plan.beneficiaries.get(index).ok_or(Error::NotFound)?;
    let due = entitlement(snapshot, heir.share_bps, unlocked)?
        .checked_sub(heir.claimed)
        .ok_or(Error::Overflow)?;
    let amount = if due > account.balance { account.balance } else { due };
    if amount <= 0 {
        return Err(Error::InsufficientBalance);
    }

    storage::transfer_out(env, &beneficiary, amount)?;

    let now = env.ledger().timestamp();
    account.balance = account.balance.checked_sub(amount).ok_or(Error::Overflow)?;
    account.updated_at = now;
    env.storage().persistent().set(&flex_key, &account);
    storage::extend_persistent_ttl(env, &flex_key);

    heir.claimed = heir.claimed.checked_add(amount).ok_or(Error::Overflow)?;
    let total_claimed = heir.claimed;
    plan.beneficiaries.set(index, heir);

    // The plan is complete once every share has been paid in full.
    let mut complete = unlocked == BPS_DENOMINATOR;
    if complete {
        for b in plan.beneficiaries.iter() {
            if b.claimed < entitlement(snapshot, b.share_bps, BPS_DENOMINATOR)? {
                complete = false;
                break;
            }
        }
    }
    if complete {
        env.storage()
            .persistent()
            .remove(&DataKey::Inheritance(owner.clone()));
    } else {
        save_plan(env, &plan);
    }

    env.events().publish(
        (TOPIC_INHERITANCE_CLAIMED, owner.clone(), beneficiary.clone()),
        (owner, beneficiary, amount, total_claimed, unlocked, now),
    );
    Ok(amount)
}

/// The owner's inheritance plan, if any.
pub fn get_plan(env: &Env, owner: Address) -> Option<InheritancePlan> {
    let key = DataKey::Inheritance(owner);
    let plan = env.storage().persistent().get(&key);
    if plan.is_some() {
        storage::extend_persistent_ttl(env, &key);
    }
    plan
}

/// How much `beneficiary` could claim from `owner`'s plan right now.
/// `0` when there is no plan, the caller is not an heir, or nothing has
/// unlocked.
pub fn claimable(env: &Env, owner: Address, beneficiary: Address) -> i128 {
    let plan = match get_plan(env, owner.clone()) {
        Some(plan) => plan,
        None => return 0,
    };
    let heir = match plan.beneficiaries.iter().find(|b| b.address == beneficiary) {
        Some(heir) => heir,
        None => return 0,
    };
    let unlocked = match unlocked_bps(env, &plan) {
        Ok(bps) => bps,
        Err(_) => return 0,
    };
    let balance = flexible_balance(env, &owner);
    let snapshot = plan.snapshot_balance.unwrap_or(balance);
    let due = entitlement(snapshot, heir.share_bps, unlocked)
        .unwrap_or(0)
        .saturating_sub(heir.claimed);
    due.min(balance).max(0)
}
