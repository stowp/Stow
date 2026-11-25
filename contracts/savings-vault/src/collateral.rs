//! Savings vault loan collateralization — issue #645.
//!
//! # Design
//!
//! A vault owner can mark their flexible or interest-bearing vault as
//! collateral for a loan managed by an external registered lender. Once
//! enabled, the vault's balance cannot be withdrawn below the amount needed
//! to cover outstanding debt; this lock is enforced in every withdrawal path.
//!
//! ## Ratio model (integer basis points, no floats)
//!
//! ```text
//! borrow_ratio_bps      = 8_000  (80 %)  — default; configurable per vault
//! liquidation_ratio_bps = 9_000  (90 %)  — default; must be > borrow_ratio_bps
//!
//! max_borrow            = balance * borrow_ratio_bps / 10_000  (floor)
//! min_locked_balance    = borrowed * 10_000 / borrow_ratio_bps (ceil)
//! liquidation allowed when:
//!     borrowed * 10_000 > balance * liquidation_ratio_bps
//! ```
//!
//! ## Multi-vault loans
//!
//! A single loan id can be backed by multiple vault owners. Each vault tracks
//! its own `borrowed` allocation independently (per-vault allocation model).
//! The lender is responsible for distributing borrow capacity across vaults;
//! this contract enforces the ratio individually per vault and never
//! double-counts the same vault across two loans.
//!
//! ## Lender authorization
//!
//! The admin registers trusted lender addresses via `register_lender` /
//! `deregister_lender`. Only a registered lender may call `record_borrow` or
//! `record_repay`. `liquidate` is permissionless — anyone can trigger it once
//! the position crosses the liquidation threshold.
//!
//! ## "Auto-liquidate" clarification
//!
//! Soroban contracts cannot self-trigger. "Auto-liquidate" here means a
//! permissionless `liquidate` entrypoint that anyone can call, plus a health
//! check inside every withdrawal path that blocks a withdrawal that would put
//! a healthy vault below the liquidation threshold.
//!
//! ## Balance source
//!
//! Collateral checks use the **flexible** `FlexibleAccount.balance` or the
//! **interest** `InterestAccount.principal` as the live balance, whichever
//! vault type is backing the loan. The balance returned by
//! [`vault_balance`] is always the latest on-chain value (interest accrual
//! is *not* settled here — only the already-compounded principal is used, so
//! the check is conservative in the protocol's favour).

use soroban_sdk::{Address, Env, Vec};

use crate::admin;
use crate::error::Error;
use crate::events::{
    TOPIC_COLLATERAL_DISABLED, TOPIC_COLLATERAL_ENABLED, TOPIC_COLLATERAL_LIQUIDATED,
    TOPIC_COLLATERAL_REPAID, TOPIC_COLLATERAL_USED, TOPIC_LENDER_DEREGISTERED,
    TOPIC_LENDER_REGISTERED,
};
use crate::storage::{self, extend_instance_ttl, extend_persistent_ttl};
use crate::types::{CollateralState, DataKey, FlexibleAccount, InterestAccount, LoanRecord};

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

/// Default collateral borrow ratio: 80 %.
#[allow(dead_code)]
pub const DEFAULT_BORROW_RATIO_BPS: u32 = 8_000;
/// Default liquidation threshold: 90 %. Must be > DEFAULT_BORROW_RATIO_BPS.
#[allow(dead_code)]
pub const DEFAULT_LIQUIDATION_RATIO_BPS: u32 = 9_000;
/// Maximum settable borrow ratio: 95 %.
pub const MAX_BORROW_RATIO_BPS: u32 = 9_500;
/// Denominator for all basis-point arithmetic.
const BPS_DENOM: i128 = 10_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Load `CollateralState` for `owner`, or return `NotFound`.
fn load_collateral(env: &Env, owner: &Address) -> Result<CollateralState, Error> {
    let key = DataKey::CollateralState(owner.clone());
    let state = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &key);
    Ok(state)
}

/// Persist `CollateralState` and bump its TTL.
fn save_collateral(env: &Env, state: &CollateralState) {
    let key = DataKey::CollateralState(state.owner.clone());
    env.storage().persistent().set(&key, state);
    extend_persistent_ttl(env, &key);
}

/// Return the current balance of `owner`'s vault — flexible first, then
/// interest. Returns `0` if neither account exists.
pub fn vault_balance(env: &Env, owner: &Address) -> i128 {
    // Try flexible account first (if it has positive balance).
    if let Some(acc) = env
        .storage()
        .persistent()
        .get::<_, FlexibleAccount>(&DataKey::Flexible(owner.clone()))
    {
        if acc.balance > 0 {
            return acc.balance;
        }
    }
    // Fall back to interest account principal (not yet-accrued interest).
    if let Some(acc) = env
        .storage()
        .persistent()
        .get::<_, InterestAccount>(&DataKey::InterestAccount(owner.clone()))
    {
        return acc.principal;
    }
    0
}

/// Minimum balance that must remain after any withdrawal: `ceil(borrowed *
/// 10_000 / borrow_ratio_bps)`. Returns `0` when `borrowed == 0`.
///
/// Rounding is in the protocol's favour (ceiling), so the locked amount is
/// never under-stated.
pub fn min_locked_balance(borrowed: i128, borrow_ratio_bps: u32) -> Result<i128, Error> {
    if borrowed == 0 || borrow_ratio_bps == 0 {
        return Ok(0);
    }
    // ceil(a / b) = (a + b - 1) / b
    let numerator = borrowed
        .checked_mul(BPS_DENOM)
        .ok_or(Error::Overflow)?
        .checked_add(borrow_ratio_bps as i128 - 1)
        .ok_or(Error::Overflow)?;
    let result = numerator
        .checked_div(borrow_ratio_bps as i128)
        .ok_or(Error::Overflow)?;
    Ok(result)
}

/// Maximum amount that may be borrowed against a balance.
/// `floor(balance * borrow_ratio_bps / 10_000)`.
pub fn max_borrow(balance: i128, borrow_ratio_bps: u32) -> Result<i128, Error> {
    balance
        .checked_mul(borrow_ratio_bps as i128)
        .ok_or(Error::Overflow)?
        .checked_div(BPS_DENOM)
        .ok_or(Error::Overflow)
}

/// True when the position is undercollateralized and may be liquidated.
/// `borrowed * 10_000 > balance * liquidation_ratio_bps`
fn is_liquidatable(balance: i128, borrowed: i128, liquidation_ratio_bps: u32) -> bool {
    if borrowed == 0 {
        return false;
    }
    // Use saturating mul to avoid panic; if either side saturates the
    // comparison is still safe (a saturated borrow side only triggers more
    // liquidations, which is the safe direction).
    let lhs = borrowed.saturating_mul(BPS_DENOM);
    let rhs = balance.saturating_mul(liquidation_ratio_bps as i128);
    lhs > rhs
}

/// Assert that the state after a potential withdrawal passes the collateral
/// check. Called from every withdrawal path.
///
/// `new_balance` is what the balance would become after the withdrawal.
/// Returns `CollateralWithdrawalBlocked` if the new balance would be below
/// the minimum locked amount.
pub fn check_withdrawal(env: &Env, owner: &Address, new_balance: i128) -> Result<(), Error> {
    let key = DataKey::CollateralState(owner.clone());
    // No collateral state means no lock — fast path.
    let Some(state) = env.storage().persistent().get::<_, CollateralState>(&key) else {
        return Ok(());
    };
    extend_persistent_ttl(env, &key);

    if !state.enabled || state.borrowed == 0 {
        return Ok(());
    }

    let required = min_locked_balance(state.borrowed, state.borrow_ratio_bps)?;
    if new_balance < required {
        return Err(Error::CollateralWithdrawalBlocked);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Lender registry (admin-only)
// ---------------------------------------------------------------------------

/// Register `lender` as an authorised lender. Admin-only.
///
/// Registered lenders may call `record_borrow` and `record_repay` on vaults
/// that have enabled them. Emits `lender_registered`.
pub fn register_lender(env: &Env, caller: Address, lender: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != admin {
        return Err(Error::Unauthorized);
    }

    env.storage()
        .instance()
        .set(&DataKey::RegisteredLender(lender.clone()), &true);

    env.events().publish(
        (TOPIC_LENDER_REGISTERED,),
        (lender, env.ledger().timestamp()),
    );
    Ok(())
}

/// Remove `lender` from the authorised lender registry. Admin-only.
///
/// Emits `lender_deregistered`.
pub fn deregister_lender(env: &Env, caller: Address, lender: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != admin {
        return Err(Error::Unauthorized);
    }

    env.storage()
        .instance()
        .remove(&DataKey::RegisteredLender(lender.clone()));

    env.events().publish(
        (TOPIC_LENDER_DEREGISTERED,),
        (lender, env.ledger().timestamp()),
    );
    Ok(())
}

/// True if `lender` is in the registry.
pub fn is_registered_lender(env: &Env, lender: &Address) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&DataKey::RegisteredLender(lender.clone()))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Collateral lifecycle
// ---------------------------------------------------------------------------

/// Enable `owner`'s vault as collateral for loan `loan_id`.
///
/// - `owner.require_auth()`.
/// - The vault must have a positive balance (flexible or interest account).
/// - Fails if already enabled (`CollateralAlreadyEnabled`).
/// - Fails if the vault is already backing another loan (`VaultAlreadyBacking`).
/// - `borrow_ratio_bps` must be in `(0, MAX_BORROW_RATIO_BPS]`.
/// - `liquidation_ratio_bps` must be `> borrow_ratio_bps` and `<= 10_000`.
/// - If `loan_id == 0` a new loan record is created; otherwise the vault is
///   added to an existing loan (the lender of that loan must exist).
/// - Emits `collateral_enabled`.
pub fn enable_as_collateral(
    env: &Env,
    owner: Address,
    loan_id: u64,
    borrow_ratio_bps: u32,
    liquidation_ratio_bps: u32,
) -> Result<u64, Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    // Validate ratios.
    if borrow_ratio_bps == 0 || borrow_ratio_bps > MAX_BORROW_RATIO_BPS {
        return Err(Error::InvalidParameters);
    }
    if liquidation_ratio_bps <= borrow_ratio_bps || liquidation_ratio_bps > 10_000 {
        return Err(Error::InvalidParameters);
    }

    // Check for existing state.
    let key = DataKey::CollateralState(owner.clone());
    if let Some(existing) = env.storage().persistent().get::<_, CollateralState>(&key) {
        if existing.enabled {
            return Err(Error::CollateralAlreadyEnabled);
        }
        if existing.loan_id != 0 {
            return Err(Error::VaultAlreadyBacking);
        }
    }

    // The vault must have a balance to be meaningful as collateral.
    if vault_balance(env, &owner) == 0 {
        return Err(Error::InsufficientBalance);
    }

    // Resolve / create the loan record.
    let resolved_loan_id = if loan_id == 0 {
        // Create a new loan record. For a new loan without a designated
        // lender, we store the owner as a placeholder (lender must be set
        // separately via register_lender). The first backing vault is seeded
        // here so the loan record is self-contained.
        let new_id = storage::next_id(env, DataKey::NextLoanId);
        let now = env.ledger().timestamp();
        let mut vaults = Vec::new(env);
        vaults.push_back(owner.clone());
        let loan = LoanRecord {
            loan_id: new_id,
            lender: owner.clone(),
            total_borrowed: 0,
            vaults,
            created_at: now,
        };
        let loan_key = DataKey::LoanRecord(new_id);
        env.storage().persistent().set(&loan_key, &loan);
        extend_persistent_ttl(env, &loan_key);
        new_id
    } else {
        // Join an existing loan — it must exist.
        let loan_key = DataKey::LoanRecord(loan_id);
        env.storage()
            .persistent()
            .get::<_, LoanRecord>(&loan_key)
            .ok_or(Error::NotFound)?;
        extend_persistent_ttl(env, &loan_key);
        loan_id
    };

    // Track the vault in the loan's vault set (embedded in the loan record).
    // For a new loan the first vault is already seeded above; for a join we
    // append here.
    if loan_id != 0 {
        let loan_key = DataKey::LoanRecord(resolved_loan_id);
        let mut loan: LoanRecord = env
            .storage()
            .persistent()
            .get(&loan_key)
            .ok_or(Error::NotFound)?;
        loan.vaults.push_back(owner.clone());
        env.storage().persistent().set(&loan_key, &loan);
        extend_persistent_ttl(env, &loan_key);
    }

    // Write the collateral state.
    let now = env.ledger().timestamp();
    let state = CollateralState {
        owner: owner.clone(),
        enabled: true,
        loan_id: resolved_loan_id,
        borrowed: 0,
        borrow_ratio_bps,
        liquidation_ratio_bps,
    };
    env.storage().persistent().set(&key, &state);
    extend_persistent_ttl(env, &key);

    env.events().publish(
        (TOPIC_COLLATERAL_ENABLED, owner.clone()),
        (
            owner,
            resolved_loan_id,
            borrow_ratio_bps,
            liquidation_ratio_bps,
            now,
        ),
    );

    Ok(resolved_loan_id)
}

/// Disable collateral for `owner`'s vault.
///
/// - `owner.require_auth()`.
/// - Only permitted when `borrowed == 0`; use `record_repay` first to clear debt.
/// - Emits `collateral_disabled`.
pub fn disable_collateral(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    owner.require_auth();

    let mut state = load_collateral(env, &owner)?;

    if !state.enabled {
        return Err(Error::CollateralNotEnabled);
    }
    if state.borrowed > 0 {
        return Err(Error::CollateralLimitExceeded); // cannot disable while in debt
    }

    // Remove the vault from the loan's backing set (embedded in the record).
    let loan_key = DataKey::LoanRecord(state.loan_id);
    if let Some(mut loan) = env.storage().persistent().get::<_, LoanRecord>(&loan_key) {
        let mut new_vaults: Vec<Address> = Vec::new(env);
        for addr in loan.vaults.iter() {
            if addr != owner {
                new_vaults.push_back(addr);
            }
        }
        loan.vaults = new_vaults;
        env.storage().persistent().set(&loan_key, &loan);
        extend_persistent_ttl(env, &loan_key);
    }

    state.enabled = false;
    state.loan_id = 0;
    save_collateral(env, &state);

    env.events().publish(
        (TOPIC_COLLATERAL_DISABLED, owner.clone()),
        (owner, env.ledger().timestamp()),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Borrow accounting (lender-only)
// ---------------------------------------------------------------------------

/// Record that `amount` has been borrowed against `owner`'s vault.
///
/// - `lender.require_auth()`.
/// - Caller must be a registered lender.
/// - Vault must be enabled as collateral.
/// - `borrowed + amount` must not exceed `max_borrow(balance, ratio)`.
/// - Updates both the per-vault `CollateralState` and the `LoanRecord`.
/// - Emits `collateral_used`.
pub fn record_borrow(
    env: &Env,
    lender: Address,
    owner: Address,
    amount: i128,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    lender.require_auth();

    if !is_registered_lender(env, &lender) {
        return Err(Error::NotRegisteredLender);
    }
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut state = load_collateral(env, &owner)?;
    if !state.enabled {
        return Err(Error::CollateralNotEnabled);
    }

    let balance = vault_balance(env, &owner);
    let cap = max_borrow(balance, state.borrow_ratio_bps)?;
    let new_borrowed = state.borrowed.checked_add(amount).ok_or(Error::Overflow)?;

    if new_borrowed > cap {
        return Err(Error::CollateralLimitExceeded);
    }

    state.borrowed = new_borrowed;
    save_collateral(env, &state);

    // Update the loan record total and lender.
    let loan_key = DataKey::LoanRecord(state.loan_id);
    if let Some(mut loan) = env.storage().persistent().get::<_, LoanRecord>(&loan_key) {
        loan.total_borrowed = loan
            .total_borrowed
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        if !is_registered_lender(env, &loan.lender) {
            loan.lender = lender.clone();
        }
        env.storage().persistent().set(&loan_key, &loan);
        extend_persistent_ttl(env, &loan_key);
    }

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_COLLATERAL_USED, owner.clone(), state.loan_id),
        (
            owner,
            state.loan_id,
            amount,
            new_borrowed,
            state.borrow_ratio_bps,
            now,
        ),
    );
    Ok(())
}

/// Record a repayment of `amount` against `owner`'s vault.
///
/// - `lender.require_auth()`.
/// - Caller must be a registered lender.
/// - `amount` must not exceed the current `borrowed` on this vault.
/// - Emits `collateral_repaid`.
pub fn record_repay(env: &Env, lender: Address, owner: Address, amount: i128) -> Result<(), Error> {
    extend_instance_ttl(env);
    admin::require_not_paused(env)?;
    lender.require_auth();

    if !is_registered_lender(env, &lender) {
        return Err(Error::NotRegisteredLender);
    }
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut state = load_collateral(env, &owner)?;
    if !state.enabled {
        return Err(Error::CollateralNotEnabled);
    }
    if amount > state.borrowed {
        return Err(Error::InsufficientBalance);
    }

    let new_borrowed = state.borrowed.checked_sub(amount).ok_or(Error::Overflow)?;
    state.borrowed = new_borrowed;
    save_collateral(env, &state);

    // Update the loan record total.
    let loan_key = DataKey::LoanRecord(state.loan_id);
    if let Some(mut loan) = env.storage().persistent().get::<_, LoanRecord>(&loan_key) {
        loan.total_borrowed = loan.total_borrowed.saturating_sub(amount); // saturating: never go below zero
        env.storage().persistent().set(&loan_key, &loan);
        extend_persistent_ttl(env, &loan_key);
    }

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_COLLATERAL_REPAID, owner.clone(), state.loan_id),
        (owner, state.loan_id, amount, new_borrowed, now),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Liquidation (permissionless)
// ---------------------------------------------------------------------------

/// Liquidate `owner`'s vault if it is undercollateralized.
///
/// Anyone may call this. The contract checks whether
/// `borrowed * 10_000 > balance * liquidation_ratio_bps` using the current
/// balance, and if so transfers the minimum amount needed to cover the debt
/// (up to the full balance) from the vault to the lender on record for this
/// loan, and clears the vault's debt.
///
/// ## What is seized
///
/// `seized = min(balance, min_locked_balance(borrowed, borrow_ratio_bps))`
///
/// That is, we seize the smallest amount that makes the position whole (the
/// locked amount), bounded by the actual balance. The lender receives the
/// seized tokens; the vault's `borrowed` is set to zero.
///
/// ## Emits
/// `CollateralLiquidated (owner, loan_id, seized_amount, remaining_debt = 0)`
///
/// ## Fails with
/// `PositionHealthy` when the position is not undercollateralized.
pub fn liquidate(env: &Env, owner: Address) -> Result<(), Error> {
    extend_instance_ttl(env);

    let mut state = load_collateral(env, &owner)?;
    if !state.enabled {
        return Err(Error::CollateralNotEnabled);
    }

    let balance = vault_balance(env, &owner);

    if !is_liquidatable(balance, state.borrowed, state.liquidation_ratio_bps) {
        return Err(Error::PositionHealthy);
    }

    // Determine the lender to pay.
    let loan_key = DataKey::LoanRecord(state.loan_id);
    let loan: LoanRecord = env
        .storage()
        .persistent()
        .get(&loan_key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &loan_key);

    // Seize the locked amount (capped at the actual balance).
    let required = min_locked_balance(state.borrowed, state.borrow_ratio_bps)?;
    let seized = required.min(balance);

    // Transfer seized tokens from the contract to the lender.
    storage::transfer_out(env, &loan.lender, seized)?;

    // Reduce the balance in the underlying vault record.
    debit_vault_balance(env, &owner, seized)?;

    // Clear the vault's debt; keep it enabled so the owner can re-use it.
    let old_borrowed = state.borrowed;
    state.borrowed = 0;
    save_collateral(env, &state);

    // Update the loan record.
    let mut loan_mut = loan;
    loan_mut.total_borrowed = loan_mut.total_borrowed.saturating_sub(old_borrowed);
    env.storage().persistent().set(&loan_key, &loan_mut);
    extend_persistent_ttl(env, &loan_key);

    let now = env.ledger().timestamp();
    env.events().publish(
        (TOPIC_COLLATERAL_LIQUIDATED, owner.clone(), state.loan_id),
        (owner, state.loan_id, seized, 0i128, now),
    );
    Ok(())
}

/// Reduce the balance stored in the owner's vault by `amount`.
///
/// Tries the flexible account first, then the interest account. This is
/// called only by `liquidate` after `transfer_out` has already moved the
/// tokens, so we are just updating the bookkeeping.
fn debit_vault_balance(env: &Env, owner: &Address, amount: i128) -> Result<(), Error> {
    let flex_key = DataKey::Flexible(owner.clone());
    if let Some(mut acc) = env
        .storage()
        .persistent()
        .get::<_, FlexibleAccount>(&flex_key)
    {
        if acc.balance >= amount {
            acc.balance = acc.balance.checked_sub(amount).ok_or(Error::Overflow)?;
            acc.updated_at = env.ledger().timestamp();
            env.storage().persistent().set(&flex_key, &acc);
            extend_persistent_ttl(env, &flex_key);
            return Ok(());
        }
    }

    let int_key = DataKey::InterestAccount(owner.clone());
    if let Some(mut acc) = env
        .storage()
        .persistent()
        .get::<_, InterestAccount>(&int_key)
    {
        acc.principal = acc.principal.checked_sub(amount).ok_or(Error::Overflow)?;
        acc.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&int_key, &acc);
        extend_persistent_ttl(env, &int_key);
        return Ok(());
    }

    Err(Error::NotFound)
}

// ---------------------------------------------------------------------------
// Read-only helpers
// ---------------------------------------------------------------------------

/// Read the collateral state for `owner`. Returns `NotFound` if none exists.
pub fn get_collateral_state(env: &Env, owner: Address) -> Result<CollateralState, Error> {
    load_collateral(env, &owner)
}

/// Read the loan record for `loan_id`. Returns `NotFound` if none exists.
pub fn get_loan_record(env: &Env, loan_id: u64) -> Result<LoanRecord, Error> {
    let key = DataKey::LoanRecord(loan_id);
    let loan = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &key);
    Ok(loan)
}

/// Return the vault addresses backing `loan_id`.
pub fn get_loan_vaults(env: &Env, loan_id: u64) -> Vec<Address> {
    let key = DataKey::LoanRecord(loan_id);
    match env.storage().persistent().get::<_, LoanRecord>(&key) {
        Some(loan) => {
            extend_persistent_ttl(env, &key);
            loan.vaults
        }
        None => Vec::new(env),
    }
}
