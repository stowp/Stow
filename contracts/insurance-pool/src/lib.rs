#![no_std]
//! # Stow Insurance Pool
//!
//! Protects savers against smart contract failures. Savers buy a policy
//! covering an amount for a period and pay a premium priced from that
//! coverage. Premiums and underwriter capital form the pool. When a covered
//! failure happens the policy holder files a claim; the claim is verified
//! against an incident oracle and, once confirmed, paid out automatically.
//!
//! - [`InsurancePool::quote_premium`] — premium for a coverage amount and term
//! - [`InsurancePool::buy_policy`] — pay the premium, get a policy
//! - [`InsurancePool::file_claim`] / [`InsurancePool::process_claim`] — see [`claims`]
//! - [`InsurancePool::stats`] / [`InsurancePool::coverage_ratio_bps`] /
//!   [`InsurancePool::is_solvent`] — solvency tracking
//!
//! ## Solvency
//!
//! The pool tracks its own balance (capital + premiums − payouts − capital
//! withdrawals) and the total coverage of active policies. The coverage
//! ratio is `balance * 10_000 / active_coverage`, in basis points. Selling a
//! policy or withdrawing capital is refused when it would push the ratio
//! below the admin-configured `min_coverage_ratio_bps`.

mod claims;

#[cfg(test)]
#[path = "test/insurance_test.rs"]
mod insurance_test;

pub use claims::{Claim, ClaimStatus, IncidentStatus};

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Symbol,
};

/// 100% in basis points.
pub const BPS: i128 = 10_000;
/// Seconds in a (non-leap) year; premium rates are annual.
pub const YEAR_SECONDS: u64 = 31_536_000;
/// Longest policy term that can be bought in one go.
pub const MAX_POLICY_DURATION: u64 = 5 * YEAR_SECONDS;

const INSTANCE_BUMP: u32 = 518_400; // ~30 days at 5s ledgers
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - 17_280;
const PERSISTENT_BUMP: u32 = 3_110_400; // ~180 days
const PERSISTENT_THRESHOLD: u32 = PERSISTENT_BUMP - 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    /// Zero or negative amount, or a zero/oversized duration.
    InvalidAmount = 4,
    /// A configuration value is out of range.
    InvalidParameters = 5,
    PolicyNotFound = 6,
    /// The policy is expired, already claimed, or outside its term.
    PolicyInactive = 7,
    ClaimNotFound = 8,
    /// The claim has already been paid or rejected.
    ClaimAlreadyResolved = 9,
    /// Claimed amount is larger than the policy's coverage.
    ClaimExceedsCoverage = 10,
    /// The policy already has a claim awaiting verification.
    ClaimPending = 11,
    /// The action would push the coverage ratio below the configured minimum.
    CoverageRatioBreached = 12,
    /// The pool does not hold enough funds for this payout or withdrawal.
    InsufficientPoolFunds = 13,
    Overflow = 14,
    /// The oracle has not ruled on the incident yet.
    ClaimNotVerified = 15,
    /// The oracle call failed.
    OracleUnavailable = 16,
    /// The policy cannot expire yet, or has a pending claim.
    PolicyStillActive = 17,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolConfig {
    pub admin: Address,
    /// Token premiums, capital and payouts are denominated in.
    pub token: Address,
    /// Incident oracle consulted before every payout. Must implement
    /// [`claims::IncidentOracle`].
    pub oracle: Address,
    /// Annual premium rate, in bps of the covered amount.
    pub premium_rate_bps: u32,
    /// Minimum `balance / active_coverage`, in bps, the pool must keep.
    pub min_coverage_ratio_bps: u32,
}

/// Running totals used for solvency tracking.
#[contracttype]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PoolStats {
    /// Funds held by the pool and available for payouts.
    pub balance: i128,
    /// Sum of coverage across active (unexpired, unclaimed) policies.
    pub active_coverage: i128,
    pub total_premiums: i128,
    pub total_capital: i128,
    pub total_payouts: i128,
    pub policy_count: u64,
    pub claim_count: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyStatus {
    Active,
    /// A claim on the policy was paid; its coverage is released.
    Claimed,
    /// The term ended without a paid claim; its coverage is released.
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub id: u64,
    pub holder: Address,
    pub coverage: i128,
    pub premium: i128,
    pub start: u64,
    pub end: u64,
    pub status: PolicyStatus,
}

#[contracttype]
#[derive(Clone)]
pub(crate) enum DataKey {
    Config,
    Stats,
    Policy(u64),
    Claim(u64),
    /// Id of the pending claim on a policy, if any.
    PendingClaim(u64),
}

// ── Storage helpers ────────────────────────────────────────────────────────

pub(crate) fn config(env: &Env) -> Result<PoolConfig, Error> {
    let config = env
        .storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)?;
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
    Ok(config)
}

pub(crate) fn stats(env: &Env) -> PoolStats {
    env.storage()
        .instance()
        .get(&DataKey::Stats)
        .unwrap_or_default()
}

pub(crate) fn save_stats(env: &Env, stats: &PoolStats) {
    env.storage().instance().set(&DataKey::Stats, stats);
}

pub(crate) fn load_persistent<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
    env: &Env,
    key: &DataKey,
) -> Option<V> {
    let value = env.storage().persistent().get(key);
    if value.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
    }
    value
}

pub(crate) fn save_persistent<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
    env: &Env,
    key: &DataKey,
    value: &V,
) {
    env.storage().persistent().set(key, value);
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
}

pub(crate) fn load_policy(env: &Env, policy_id: u64) -> Result<Policy, Error> {
    load_persistent(env, &DataKey::Policy(policy_id)).ok_or(Error::PolicyNotFound)
}

pub(crate) fn save_policy(env: &Env, policy: &Policy) {
    save_persistent(env, &DataKey::Policy(policy.id), policy);
}

/// `balance * 10_000 / coverage`, or `None` when nothing is covered.
fn ratio_bps(balance: i128, coverage: i128) -> Option<i128> {
    if coverage <= 0 {
        return None;
    }
    balance.checked_mul(BPS).map(|v| v / coverage)
}

/// Whether `balance` can back `coverage` at the configured minimum ratio.
pub(crate) fn meets_min_ratio(
    balance: i128,
    coverage: i128,
    min_ratio_bps: u32,
) -> Result<bool, Error> {
    if coverage <= 0 {
        return Ok(true);
    }
    let lhs = balance.checked_mul(BPS).ok_or(Error::Overflow)?;
    let rhs = coverage
        .checked_mul(min_ratio_bps as i128)
        .ok_or(Error::Overflow)?;
    Ok(lhs >= rhs)
}

fn require_admin(env: &Env, caller: &Address) -> Result<PoolConfig, Error> {
    let config = config(env)?;
    caller.require_auth();
    if *caller != config.admin {
        return Err(Error::Unauthorized);
    }
    Ok(config)
}

/// Premium for `coverage` over `duration` seconds at `rate_bps` per year,
/// rounded up so the pool never undercharges. Minimum 1 stroop.
pub fn premium_for(coverage: i128, duration: u64, rate_bps: u32) -> Result<i128, Error> {
    if coverage <= 0 || duration == 0 || duration > MAX_POLICY_DURATION {
        return Err(Error::InvalidAmount);
    }
    let numerator = coverage
        .checked_mul(rate_bps as i128)
        .and_then(|v| v.checked_mul(duration as i128))
        .ok_or(Error::Overflow)?;
    let denominator = BPS * YEAR_SECONDS as i128;
    let premium = (numerator + denominator - 1) / denominator;
    Ok(premium.max(1))
}

#[contract]
pub struct InsurancePool;

#[contractimpl]
impl InsurancePool {
    // --- lifecycle ---------------------------------------------------------

    /// One-time setup. `premium_rate_bps` is annual (1..=10_000);
    /// `min_coverage_ratio_bps` is the solvency floor (> 0).
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        oracle: Address,
        premium_rate_bps: u32,
        min_coverage_ratio_bps: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        if premium_rate_bps == 0 || premium_rate_bps > BPS as u32 || min_coverage_ratio_bps == 0 {
            return Err(Error::InvalidParameters);
        }
        admin.require_auth();
        let config = PoolConfig {
            admin: admin.clone(),
            token,
            oracle,
            premium_rate_bps,
            min_coverage_ratio_bps,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        save_stats(&env, &PoolStats::default());
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
        env.events()
            .publish((Symbol::new(&env, "pool_initialized"),), admin);
        Ok(())
    }

    pub fn config(env: Env) -> Result<PoolConfig, Error> {
        config(&env)
    }

    /// Admin: change the annual premium rate for new policies.
    pub fn set_premium_rate(env: Env, caller: Address, premium_rate_bps: u32) -> Result<(), Error> {
        let mut config = require_admin(&env, &caller)?;
        if premium_rate_bps == 0 || premium_rate_bps > BPS as u32 {
            return Err(Error::InvalidParameters);
        }
        config.premium_rate_bps = premium_rate_bps;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    /// Admin: change the solvency floor.
    pub fn set_min_coverage_ratio(env: Env, caller: Address, ratio_bps: u32) -> Result<(), Error> {
        let mut config = require_admin(&env, &caller)?;
        if ratio_bps == 0 {
            return Err(Error::InvalidParameters);
        }
        config.min_coverage_ratio_bps = ratio_bps;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    /// Admin: point the pool at a different incident oracle.
    pub fn set_oracle(env: Env, caller: Address, oracle: Address) -> Result<(), Error> {
        let mut config = require_admin(&env, &caller)?;
        config.oracle = oracle;
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    // --- capital -------------------------------------------------------------

    /// Add underwriting capital to the pool. Anyone may contribute.
    pub fn deposit_capital(env: Env, provider: Address, amount: i128) -> Result<(), Error> {
        let config = config(&env)?;
        provider.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        token::Client::new(&env, &config.token).transfer(
            &provider,
            &env.current_contract_address(),
            &amount,
        );
        let mut stats = stats(&env);
        stats.balance = stats.balance.checked_add(amount).ok_or(Error::Overflow)?;
        stats.total_capital = stats
            .total_capital
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        save_stats(&env, &stats);
        env.events()
            .publish((Symbol::new(&env, "capital_deposited"), provider), amount);
        Ok(())
    }

    /// Admin: withdraw capital, as long as the pool stays above its
    /// minimum coverage ratio afterwards.
    pub fn withdraw_capital(env: Env, caller: Address, to: Address, amount: i128) -> Result<(), Error> {
        let config = require_admin(&env, &caller)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut stats = stats(&env);
        if amount > stats.balance {
            return Err(Error::InsufficientPoolFunds);
        }
        let remaining = stats.balance - amount;
        if !meets_min_ratio(remaining, stats.active_coverage, config.min_coverage_ratio_bps)? {
            return Err(Error::CoverageRatioBreached);
        }
        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        stats.balance = remaining;
        save_stats(&env, &stats);
        env.events()
            .publish((Symbol::new(&env, "capital_withdrawn"), to), amount);
        Ok(())
    }

    // --- policies ------------------------------------------------------------

    /// Premium for covering `coverage` for `duration` seconds at the current
    /// rate: `ceil(coverage * rate_bps * duration / (10_000 * YEAR))`.
    pub fn quote_premium(env: Env, coverage: i128, duration: u64) -> Result<i128, Error> {
        let config = config(&env)?;
        premium_for(coverage, duration, config.premium_rate_bps)
    }

    /// Buy a policy covering `coverage` for `duration` seconds starting now.
    /// The premium is collected from `holder` into the pool. Refused with
    /// `CoverageRatioBreached` if the pool could not back the extra coverage.
    pub fn buy_policy(env: Env, holder: Address, coverage: i128, duration: u64) -> Result<u64, Error> {
        let config = config(&env)?;
        holder.require_auth();
        let premium = premium_for(coverage, duration, config.premium_rate_bps)?;

        let mut stats = stats(&env);
        let new_balance = stats.balance.checked_add(premium).ok_or(Error::Overflow)?;
        let new_coverage = stats
            .active_coverage
            .checked_add(coverage)
            .ok_or(Error::Overflow)?;
        if !meets_min_ratio(new_balance, new_coverage, config.min_coverage_ratio_bps)? {
            return Err(Error::CoverageRatioBreached);
        }

        token::Client::new(&env, &config.token).transfer(
            &holder,
            &env.current_contract_address(),
            &premium,
        );

        let now = env.ledger().timestamp();
        let id = stats.policy_count + 1;
        let policy = Policy {
            id,
            holder: holder.clone(),
            coverage,
            premium,
            start: now,
            end: now.checked_add(duration).ok_or(Error::Overflow)?,
            status: PolicyStatus::Active,
        };
        save_policy(&env, &policy);

        stats.policy_count = id;
        stats.balance = new_balance;
        stats.active_coverage = new_coverage;
        stats.total_premiums = stats
            .total_premiums
            .checked_add(premium)
            .ok_or(Error::Overflow)?;
        save_stats(&env, &stats);

        env.events().publish(
            (Symbol::new(&env, "policy_purchased"), holder),
            (id, coverage, premium, policy.end),
        );
        Ok(id)
    }

    /// Mark a policy whose term has ended as expired, releasing its coverage
    /// from the solvency calculation. Permissionless.
    pub fn expire_policy(env: Env, policy_id: u64) -> Result<(), Error> {
        config(&env)?;
        let mut policy = load_policy(&env, policy_id)?;
        if policy.status != PolicyStatus::Active {
            return Err(Error::PolicyInactive);
        }
        if env.ledger().timestamp() < policy.end
            || env
                .storage()
                .persistent()
                .has(&DataKey::PendingClaim(policy_id))
        {
            return Err(Error::PolicyStillActive);
        }
        policy.status = PolicyStatus::Expired;
        save_policy(&env, &policy);

        let mut stats = stats(&env);
        stats.active_coverage = stats.active_coverage.saturating_sub(policy.coverage).max(0);
        save_stats(&env, &stats);

        env.events()
            .publish((Symbol::new(&env, "policy_expired"), policy.holder), policy_id);
        Ok(())
    }

    pub fn policy(env: Env, policy_id: u64) -> Result<Policy, Error> {
        load_policy(&env, policy_id)
    }

    // --- claims (see `claims.rs`) ------------------------------------------

    /// File a claim against an active policy for a covered contract failure
    /// identified by `incident_id`. Returns the claim id.
    pub fn file_claim(
        env: Env,
        holder: Address,
        policy_id: u64,
        amount: i128,
        incident_id: BytesN<32>,
    ) -> Result<u64, Error> {
        claims::file_claim(&env, holder, policy_id, amount, incident_id)
    }

    /// Verify a pending claim with the oracle and, if the incident is
    /// confirmed, pay it out to the policy holder. Permissionless.
    pub fn process_claim(env: Env, claim_id: u64) -> Result<ClaimStatus, Error> {
        claims::process_claim(&env, claim_id)
    }

    pub fn claim(env: Env, claim_id: u64) -> Result<Claim, Error> {
        claims::get_claim(&env, claim_id)
    }

    // --- solvency ------------------------------------------------------------

    pub fn stats(env: Env) -> PoolStats {
        stats(&env)
    }

    /// Pool balance over active coverage, in bps. `None` when no coverage
    /// is outstanding.
    pub fn coverage_ratio_bps(env: Env) -> Option<i128> {
        let stats = stats(&env);
        ratio_bps(stats.balance, stats.active_coverage)
    }

    /// Whether the pool currently meets its minimum coverage ratio.
    pub fn is_solvent(env: Env) -> Result<bool, Error> {
        let config = config(&env)?;
        let stats = stats(&env);
        meets_min_ratio(stats.balance, stats.active_coverage, config.min_coverage_ratio_bps)
    }
}
