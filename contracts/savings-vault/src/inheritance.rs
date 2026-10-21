//! Savings inheritance — issue #439.
//!
//! Lets an account owner designate one or more beneficiaries who may claim
//! the balance if the owner has been inactive for a configurable timeout.
//!
//! # How it works
//!
//! 1. **Designate** — The owner calls [`designate_beneficiary`] with an
//!    address and a share in basis points (1/100 of a percent). Multiple
//!    beneficiaries may be designated; their shares must sum to exactly
//!    `10_000` bps (100%) before the inheritance is active.
//! 2. **Timeout** — The owner sets an inactivity timeout in seconds with
//!    [`set_inactivity_timeout`]. Any interaction with the flexible-savings
//!    module (deposit or withdraw) resets the owner's `last_active_at`
//!    timestamp. Once `now >= last_active_at + timeout`, the account is
//!    considered inactive and beneficiaries may claim.
//! 3. **Claim** — A beneficiary calls [`claim_inheritance`] with the
//!    owner's address. If the timeout has elapsed, each beneficiary's
//!    proportional share of the flexible balance is transferred to them.
//!    The claim is atomic: if any transfer fails the entire call reverts
//!    with the original balance intact.
//!
//! # Storage
//!
//! Each owner's inheritance plan is stored under
//! [`DataKey::Inheritance(owner)`] in persistent storage, with a TTL
//! bumped on every read/write.

use soroban_sdk::{Address, Env, Vec};

use crate::error::Error;
use crate::storage::{extend_instance_ttl, extend_persistent_ttl, transfer_out};
use crate::types::{DataKey, InheritancePlan};

// ── Internal helpers ───────────────────────────────────────────────────────

fn load_plan(env: &Env, owner: &Address) -> Result<InheritancePlan, Error> {
    let key = DataKey::Inheritance(owner.clone());
    let plan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &key);
    Ok(plan)
}

fn save_plan(env: &Env, plan: &InheritancePlan) {
    let key = DataKey::Inheritance(plan.owner.clone());
    env.storage().persistent().set(&key, plan);
    extend_persistent_ttl(env, &key);
}

fn require_owner(env: &Env, owner: &Address) {
    owner.require_auth();
    let _ = env; // used implicitly by require_auth
}

/// Validate that a set of beneficiary shares sums to `10_000` bps.
fn validate_shares_sum(beneficiaries: &Vec<crate::types::Beneficiary>) -> Result<(), Error> {
    let mut total: u32 = 0;
    for b in beneficiaries.iter() {
        total = total.checked_add(b.share_bps).ok_or(Error::Overflow)?;
    }
    if !beneficiaries.is_empty() && total != 10_000 {
        return Err(Error::InvalidShares);
    }
    Ok(())
}

// ── Public entrypoints ─────────────────────────────────────────────────────

/// Add or update a beneficiary for the caller's flexible savings balance.
///
/// # Arguments
/// * `owner`      — The savings account owner. Must authorise.
/// * `beneficiary`— Address that will receive `share_bps` of the balance.
/// * `share_bps`  — This beneficiary's share in basis points (1–10_000).
///
/// # Behaviour
/// - Creates an [`InheritancePlan`] if one does not already exist.
/// - If `beneficiary` already appears in the plan, updates their share.
/// - Otherwise appends them.
/// - An inactivity timeout of `0` means inheritance is disabled even when
///   shares sum to 10_000; call [`set_inactivity_timeout`] to activate.
///
/// # Errors
/// - [`Error::InvalidAmount`] if `share_bps == 0 || share_bps > 10_000`.
/// - [`Error::Paused`]        if the vault is paused.
pub fn designate_beneficiary(
    env: &Env,
    owner: Address,
    beneficiary: Address,
    share_bps: u32,
) -> Result<(), Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    require_owner(env, &owner);

    if share_bps == 0 || share_bps > 10_000 {
        return Err(Error::InvalidAmount);
    }

    // Load or create the plan.
    let key = DataKey::Inheritance(owner.clone());
    let mut plan: InheritancePlan = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| InheritancePlan {
            owner: owner.clone(),
            beneficiaries: Vec::new(env),
            inactivity_timeout: 0,
            last_active_at: env.ledger().timestamp(),
        });

    // Update existing or append new.
    let mut found = false;
    let mut updated: Vec<crate::types::Beneficiary> = Vec::new(env);
    for mut b in plan.beneficiaries.iter() {
        if b.address == beneficiary {
            b.share_bps = share_bps;
            found = true;
        }
        updated.push_back(b);
    }
    if !found {
        updated.push_back(crate::types::Beneficiary {
            address: beneficiary.clone(),
            share_bps,
        });
    }
    plan.beneficiaries = updated;

    save_plan(env, &plan);

    env.events().publish(
        (soroban_sdk::symbol_short!("inherit"), soroban_sdk::symbol_short!("benef_set")),
        (owner, beneficiary, share_bps),
    );
    Ok(())
}

/// Remove a beneficiary from the caller's inheritance plan.
///
/// # Errors
/// - [`Error::NotFound`] if no plan exists or the beneficiary is not in it.
/// - [`Error::Paused`]   if the vault is paused.
pub fn remove_beneficiary(env: &Env, owner: Address, beneficiary: Address) -> Result<(), Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    require_owner(env, &owner);

    let mut plan = load_plan(env, &owner)?;

    let mut found = false;
    let mut updated: Vec<crate::types::Beneficiary> = Vec::new(env);
    for b in plan.beneficiaries.iter() {
        if b.address == beneficiary {
            found = true;
        } else {
            updated.push_back(b);
        }
    }
    if !found {
        return Err(Error::NotFound);
    }
    plan.beneficiaries = updated;
    save_plan(env, &plan);

    env.events().publish(
        (soroban_sdk::symbol_short!("inherit"), soroban_sdk::symbol_short!("benef_rm")),
        (owner, beneficiary),
    );
    Ok(())
}

/// Set the inactivity timeout for the caller's inheritance plan.
///
/// Once `now >= last_active_at + timeout` and the total shares equal
/// `10_000` bps, beneficiaries may call [`claim_inheritance`].
///
/// Setting `timeout = 0` effectively disables automatic inheritance (the
/// claim check treats it as no timeout configured).
///
/// # Errors
/// - [`Error::NotFound`] if no inheritance plan exists for `owner`.
/// - [`Error::Paused`]   if the vault is paused.
pub fn set_inactivity_timeout(env: &Env, owner: Address, timeout_seconds: u64) -> Result<(), Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    require_owner(env, &owner);

    let mut plan = load_plan(env, &owner)?;
    plan.inactivity_timeout = timeout_seconds;
    save_plan(env, &plan);

    env.events().publish(
        (soroban_sdk::symbol_short!("inherit"), soroban_sdk::symbol_short!("timeout_set")),
        (owner, timeout_seconds),
    );
    Ok(())
}

/// Record `now` as `owner`'s last-active timestamp.
///
/// Called by `flexible::deposit` and `flexible::withdraw` to keep the
/// inactivity clock reset while the owner is actively using their account.
/// Not a public entrypoint — only the flexible module calls this.
pub(crate) fn touch_owner(env: &Env, owner: &Address) {
    let key = DataKey::Inheritance(owner.clone());
    if let Some(mut plan) = env.storage().persistent().get::<DataKey, InheritancePlan>(&key) {
        plan.last_active_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &plan);
        extend_persistent_ttl(env, &key);
    }
    // If no plan exists yet, there's nothing to update.
}

/// Claim the inheritance of `owner`'s flexible balance.
///
/// # Conditions for a successful claim
/// 1. An [`InheritancePlan`] must exist for `owner`.
/// 2. The plan's `inactivity_timeout > 0`.
/// 3. The plan's beneficiaries must sum to exactly `10_000` bps.
/// 4. `now >= last_active_at + inactivity_timeout` (owner is inactive).
/// 5. The caller must be one of the designated beneficiaries.
///
/// When all conditions are met, each beneficiary receives their proportional
/// share of the flexible balance, the flexible account is zeroed, and the
/// inheritance plan is removed from storage.
///
/// # Errors
/// - [`Error::NotFound`]         if no plan or flexible account exists.
/// - [`Error::CooldownActive`]   if the inactivity timeout has not elapsed.
/// - [`Error::InvalidShares`]    if total shares ≠ 10_000.
/// - [`Error::Unauthorized`]     if `claimer` is not a beneficiary.
/// - [`Error::Paused`]           if the vault is paused.
pub fn claim_inheritance(env: &Env, claimer: Address, owner: Address) -> Result<(), Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    claimer.require_auth();

    let plan = load_plan(env, &owner)?;

    // Timeout must be configured.
    if plan.inactivity_timeout == 0 {
        return Err(Error::CooldownActive);
    }

    // Inactivity check.
    let now = env.ledger().timestamp();
    let inactive_since = plan
        .last_active_at
        .checked_add(plan.inactivity_timeout)
        .ok_or(Error::Overflow)?;
    if now < inactive_since {
        return Err(Error::CooldownActive);
    }

    // Shares must sum to 10_000.
    validate_shares_sum(&plan.beneficiaries)?;

    // Claimer must be a beneficiary.
    let is_beneficiary = plan.beneficiaries.iter().any(|b| b.address == claimer);
    if !is_beneficiary {
        return Err(Error::Unauthorized);
    }

    // Load the flexible account balance.
    let flex_key = DataKey::Flexible(owner.clone());
    let mut account = env
        .storage()
        .persistent()
        .get::<DataKey, crate::types::FlexibleAccount>(&flex_key)
        .ok_or(Error::NotFound)?;

    let total_balance = account.balance;
    if total_balance <= 0 {
        return Err(Error::InsufficientBalance);
    }

    // Pay each beneficiary their share (all-or-nothing).
    for b in plan.beneficiaries.iter() {
        // Integer arithmetic: share = balance * bps / 10_000.
        let share = total_balance
            .checked_mul(b.share_bps as i128)
            .ok_or(Error::Overflow)?
            .checked_div(10_000)
            .ok_or(Error::DivisionByZero)?;
        if share > 0 {
            transfer_out(env, &b.address, share)?;
        }
    }

    // Zero the flexible account.
    account.balance = 0;
    account.updated_at = now;
    env.storage().persistent().set(&flex_key, &account);
    extend_persistent_ttl(env, &flex_key);

    // Remove the inheritance plan — it has been consumed.
    env.storage()
        .persistent()
        .remove(&DataKey::Inheritance(owner.clone()));

    env.events().publish(
        (soroban_sdk::symbol_short!("inherit"), soroban_sdk::symbol_short!("claimed")),
        (claimer, owner, total_balance, now),
    );
    Ok(())
}

/// Read the inheritance plan for `owner`, or `Error::NotFound`.
pub fn get_plan(env: &Env, owner: Address) -> Result<InheritancePlan, Error> {
    load_plan(env, &owner)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token, Env};

    use crate::test::{register_vault, setup_flexible_account};

    // ── helpers ─────────────────────────────────────────────────────────────

    fn advance(env: &Env, seconds: u64) {
        env.ledger().with_mut(|l| l.timestamp += seconds);
    }

    // ── beneficiary designation ──────────────────────────────────────────────

    #[test]
    fn designate_single_beneficiary() {
        let env = Env::default();
        env.mock_all_auths();
        let (vault, _token, owner) = register_vault(&env);
        let heir = Address::generate(&env);

        vault
            .designate_beneficiary(&owner, &heir, &10_000u32)
            .unwrap();

        let plan = vault.get_inheritance_plan(&owner).unwrap();
        assert_eq!(plan.beneficiaries.len(), 1);
        assert_eq!(plan.beneficiaries.get(0).unwrap().address, heir);
        assert_eq!(plan.beneficiaries.get(0).unwrap().share_bps, 10_000);
    }

    #[test]
    fn designate_two_beneficiaries_split() {
        let env = Env::default();
        env.mock_all_auths();
        let (vault, _token, owner) = register_vault(&env);
        let heir1 = Address::generate(&env);
        let heir2 = Address::generate(&env);

        vault
            .designate_beneficiary(&owner, &heir1, &6_000u32)
            .unwrap();
        vault
            .designate_beneficiary(&owner, &heir2, &4_000u32)
            .unwrap();

        let plan = vault.get_inheritance_plan(&owner).unwrap();
        assert_eq!(plan.beneficiaries.len(), 2);
    }

    #[test]
    fn update_existing_beneficiary_share() {
        let env = Env::default();
        env.mock_all_auths();
        let (vault, _token, owner) = register_vault(&env);
        let heir = Address::generate(&env);

        vault
            .designate_beneficiary(&owner, &heir, &5_000u32)
            .unwrap();
        // Update the share.
        vault
            .designate_beneficiary(&owner, &heir, &10_000u32)
            .unwrap();

        let plan = vault.get_inheritance_plan(&owner).unwrap();
        assert_eq!(plan.beneficiaries.len(), 1);
        assert_eq!(plan.beneficiaries.get(0).unwrap().share_bps, 10_000);
    }

    #[test]
    fn designate_rejects_zero_share() {
        let env = Env::default();
        env.mock_all_auths();
        let (vault, _token, owner) = register_vault(&env);
        let heir = Address::generate(&env);

        assert_eq!(
            vault.try_designate_beneficiary(&owner, &heir, &0u32),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn designate_rejects_share_above_10000() {
        let env = Env::default();
        env.mock_all_auths();
        let (vault, _token, owner) = register_vault(&env);
        let heir = Address::generate(&env);

        assert_eq!(
            vault.try_designate_beneficiary(&owner, &heir, &10_001u32),
            Err(Ok(Error::InvalidAmount))
        );
    }

    // ── inactivity timeout ───────────────────────────────────────────────────

    #[test]
    fn set_inactivity_timeout_stores_value() {
        let env = Env::default();
        env.mock_all_auths();
        let (vault, _token, owner) = register_vault(&env);
        let heir = Address::generate(&env);

        vault
            .designate_beneficiary(&owner, &heir, &10_000u32)
            .unwrap();
        vault
            .set_inactivity_timeout(&owner, &(30 * 24 * 3600u64))
            .unwrap();

        let plan = vault.get_inheritance_plan(&owner).unwrap();
        assert_eq!(plan.inactivity_timeout, 30 * 24 * 3600);
    }

    // ── claim process ────────────────────────────────────────────────────────

    #[test]
    fn claim_inheritance_succeeds_after_timeout() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let (vault, token, owner) = register_vault(&env);
        let heir = Address::generate(&env);
        let timeout = 90 * 24 * 3600u64; // 90 days

        // Owner deposits.
        setup_flexible_account(&env, &vault, &token, &owner, 1_000_000);

        // Designate heir and configure timeout.
        vault
            .designate_beneficiary(&owner, &heir, &10_000u32)
            .unwrap();
        vault.set_inactivity_timeout(&owner, &timeout).unwrap();

        // Advance past the timeout.
        advance(&env, timeout + 1);

        let heir_balance_before =
            token::Client::new(&env, &token).balance(&heir);

        vault.claim_inheritance(&heir, &owner).unwrap();

        let heir_balance_after =
            token::Client::new(&env, &token).balance(&heir);
        assert!(heir_balance_after > heir_balance_before);
    }

    #[test]
    fn claim_rejected_before_timeout_elapsed() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let (vault, token, owner) = register_vault(&env);
        let heir = Address::generate(&env);
        let timeout = 90 * 24 * 3600u64;

        setup_flexible_account(&env, &vault, &token, &owner, 1_000_000);
        vault
            .designate_beneficiary(&owner, &heir, &10_000u32)
            .unwrap();
        vault.set_inactivity_timeout(&owner, &timeout).unwrap();

        // Only half the timeout has passed — should be rejected.
        advance(&env, timeout / 2);

        assert_eq!(
            vault.try_claim_inheritance(&heir, &owner),
            Err(Ok(Error::CooldownActive))
        );
    }

    #[test]
    fn claim_rejected_for_non_beneficiary() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let (vault, token, owner) = register_vault(&env);
        let heir = Address::generate(&env);
        let stranger = Address::generate(&env);
        let timeout = 1u64;

        setup_flexible_account(&env, &vault, &token, &owner, 1_000_000);
        vault
            .designate_beneficiary(&owner, &heir, &10_000u32)
            .unwrap();
        vault.set_inactivity_timeout(&owner, &timeout).unwrap();
        advance(&env, timeout + 1);

        assert_eq!(
            vault.try_claim_inheritance(&stranger, &owner),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn claim_rejected_when_shares_dont_sum_to_10000() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let (vault, token, owner) = register_vault(&env);
        let heir = Address::generate(&env);
        let timeout = 1u64;

        setup_flexible_account(&env, &vault, &token, &owner, 1_000_000);
        // Only 5 000 bps — not 10 000.
        vault
            .designate_beneficiary(&owner, &heir, &5_000u32)
            .unwrap();
        vault.set_inactivity_timeout(&owner, &timeout).unwrap();
        advance(&env, timeout + 1);

        assert_eq!(
            vault.try_claim_inheritance(&heir, &owner),
            Err(Ok(Error::InvalidShares))
        );
    }

    #[test]
    fn claim_rejected_when_timeout_is_zero() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let (vault, token, owner) = register_vault(&env);
        let heir = Address::generate(&env);

        setup_flexible_account(&env, &vault, &token, &owner, 1_000_000);
        vault
            .designate_beneficiary(&owner, &heir, &10_000u32)
            .unwrap();
        // Timeout stays 0 — inheritance disabled.

        advance(&env, 999_999_999);

        assert_eq!(
            vault.try_claim_inheritance(&heir, &owner),
            Err(Ok(Error::CooldownActive))
        );
    }

    #[test]
    fn deposit_activity_resets_inactivity_clock() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let (vault, token, owner) = register_vault(&env);
        let heir = Address::generate(&env);
        let timeout = 100u64;

        setup_flexible_account(&env, &vault, &token, &owner, 1_000_000);
        vault
            .designate_beneficiary(&owner, &heir, &10_000u32)
            .unwrap();
        vault.set_inactivity_timeout(&owner, &timeout).unwrap();

        // Advance 90 seconds — still within timeout.
        advance(&env, 90);

        // Owner deposits (resets clock to now = 1_000_090).
        vault.deposit(&owner, &100i128).unwrap();

        // Advance another 90 seconds — only 90s since last activity.
        advance(&env, 90);

        // Should still be rejected because clock was reset.
        assert_eq!(
            vault.try_claim_inheritance(&heir, &owner),
            Err(Ok(Error::CooldownActive))
        );
    }

    #[test]
    fn multi_beneficiary_split_pays_proportional_amounts() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let (vault, token, owner) = register_vault(&env);
        let heir1 = Address::generate(&env);
        let heir2 = Address::generate(&env);
        let timeout = 1u64;

        let deposit_amount = 1_000_000i128;
        setup_flexible_account(&env, &vault, &token, &owner, deposit_amount);

        // 60% / 40% split.
        vault
            .designate_beneficiary(&owner, &heir1, &6_000u32)
            .unwrap();
        vault
            .designate_beneficiary(&owner, &heir2, &4_000u32)
            .unwrap();
        vault.set_inactivity_timeout(&owner, &timeout).unwrap();
        advance(&env, timeout + 1);

        let tok = token::Client::new(&env, &token);
        let before1 = tok.balance(&heir1);
        let before2 = tok.balance(&heir2);

        vault.claim_inheritance(&heir1, &owner).unwrap();

        let got1 = tok.balance(&heir1) - before1;
        let got2 = tok.balance(&heir2) - before2;
        assert_eq!(got1, 600_000);
        assert_eq!(got2, 400_000);
    }
}
