#![no_std]
//! # Stow Savings Vault
//!
//! Non-custodial savings on Soroban. Funds move only under contract rules.
//! Five savings mechanisms, each in its own module:
//!
//! - [`flexible`] — deposit / withdraw any time
//! - [`locked`]   — deterministic on-chain time locks
//! - [`goal`]     — save toward a target with milestones
//! - [`group`]    — shared pools with enforced payouts
//! - [`group_split`] — pools settled back to members by agreed shares
//! - [`voting`]   — members vote to spend a group's pool
//! - [`interest`] — balances that grow by compound interest
//!
//! This is a **skeleton**: every entrypoint is stubbed with `unimplemented!()`
//! and a `TODO(issue)` describing the work. Each stub is one contributor issue.

mod admin;
mod delegation;
mod error;
mod events;
mod fees;
mod flexible;
mod goal;
mod group;
mod group_split;
mod insurance;
mod interest;
pub mod interest_tiers;
mod limits;
mod challenge;
mod locked;
pub mod migration;
pub mod rewards;
mod split;
mod storage;
mod timelock;
mod types;
pub mod upgrade;
mod voting;

#[cfg(test)]
mod test;

// Standalone so it builds and runs independently of the large `test` module.
#[cfg(test)]
#[path = "test/limits_test.rs"]
mod limits_test;

// Standalone split tests (#629).
#[cfg(test)]
#[path = "test/split_test.rs"]
mod split_test;

// Standalone interest tier tests (#619).
#[cfg(test)]
#[path = "test/interest_test.rs"]
mod interest_test;

// Standalone upgrade tests (#618).
#[cfg(test)]
#[path = "test/upgrade_test.rs"]
mod upgrade_test;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Map, String};

use crate::error::Error;
use crate::types::{
    CompoundFrequency, FlexibleAccount, Goal, Group, GroupLimits, InsuranceClaimRecord, InterestAccount,
    LockedPlan, Proposal, SplitRequest, TieredRateConfig, UpgradeProposal,
};

#[contract]
pub struct SavingsVault;

#[contractimpl]
impl SavingsVault {
    // --- lifecycle ---------------------------------------------------------
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        admin::initialize(&env, admin, token)
    }

    pub fn token(env: Env) -> Result<Address, Error> {
        admin::token(&env)
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        admin::set_admin(&env, new_admin)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        admin::admin(&env)
    }

    /// Pause or unpause the vault. Admin-only. While paused, mutating
    /// entrypoints reject with `Error::Paused`; reads remain available.
    pub fn set_paused(env: Env, caller: Address, paused: bool) -> Result<(), Error> {
        admin::set_paused(&env, caller, paused)
    }

    /// Pause the vault. Admin-only. Blocks deposits and withdrawals until
    /// `unpause` is called; emergency withdrawals remain available. Emits a
    /// `paused` event.
    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        admin::pause(&env, caller)
    }

    /// Unpause the vault. Admin-only. Emits an `unpaused` event.
    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        admin::unpause(&env, caller)
    }

    pub fn is_paused(env: Env) -> bool {
        admin::is_paused(&env)
    }

    /// Per-account deposit cap, in token stroops. `0` means unlimited.
    pub fn deposit_cap(env: Env) -> i128 {
        admin::deposit_cap(&env)
    }

    /// Set the per-account deposit cap. Admin-only; `0` disables the cap.
    pub fn set_deposit_cap(env: Env, cap: i128) -> Result<(), Error> {
        admin::set_deposit_cap(&env, cap)
    }

    /// The minimum deposit amount, in token stroops. `0` means no minimum.
    pub fn min_deposit(env: Env) -> i128 {
        admin::min_deposit(&env)
    }

    /// Set the minimum deposit amount. Admin-only; `0` disables the minimum.
    pub fn set_min_deposit(env: Env, min: i128) -> Result<(), Error> {
        admin::set_min_deposit(&env, min)
    }

    /// The early-withdrawal penalty, in basis points. `0` means no penalty.
    pub fn early_withdraw_penalty_bps(env: Env) -> u32 {
        admin::early_withdraw_penalty_bps(&env)
    }

    /// Set the early-withdrawal penalty, in basis points. Admin-only; `0`
    /// disables it. Errors `InvalidParameters` above `10_000`.
    pub fn set_early_withdraw_penalty_bps(env: Env, bps: u32) -> Result<(), Error> {
        admin::set_early_withdraw_penalty_bps(&env, bps)
    }

    /// The address that receives early-withdrawal penalties (the admin by
    /// default).
    pub fn penalty_recipient(env: Env) -> Result<Address, Error> {
        admin::penalty_recipient(&env)
    }

    /// Set the address that receives early-withdrawal penalties. Admin-only.
    pub fn set_penalty_recipient(env: Env, recipient: Address) -> Result<(), Error> {
        admin::set_penalty_recipient(&env, recipient)
    }

    /// The minimum time a plan must be locked before early withdrawal, in
    /// seconds. `0` means no minimum.
    pub fn min_lock_period(env: Env) -> u64 {
        admin::min_lock_period(&env)
    }

    /// Set the minimum lock period for early withdrawal, in seconds.
    /// Admin-only; `0` disables it.
    pub fn set_min_lock_period(env: Env, seconds: u64) -> Result<(), Error> {
        admin::set_min_lock_period(&env, seconds)
    }

    /// Upgrade the contract's Wasm executable to `new_wasm_hash`. Admin-only.
    /// See `admin::upgrade` for the trust trade-off this implies.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        admin::upgrade(&env, caller, new_wasm_hash)
    }

    // --- flexible ----------------------------------------------------------
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        flexible::deposit(&env, from, amount)
    }

    pub fn withdraw(env: Env, owner: Address, amount: i128) -> Result<(), Error> {
        flexible::withdraw(&env, owner, amount)
    }

    pub fn get_account(env: Env, owner: Address) -> Result<FlexibleAccount, Error> {
        flexible::get_account(&env, owner)
    }

    // --- locked ------------------------------------------------------------
    pub fn locked_create(
        env: Env,
        owner: Address,
        amount: i128,
        unlock_at: u64,
    ) -> Result<u64, Error> {
        locked::create(&env, owner, amount, unlock_at)
    }

    pub fn locked_top_up(
        env: Env,
        owner: Address,
        plan_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        locked::top_up(&env, owner, plan_id, amount)
    }

    pub fn locked_withdraw(
        env: Env,
        owner: Address,
        plan_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        locked::withdraw(&env, owner, plan_id, amount)
    }

    /// Withdraw part of a still-locked plan early, paying an admin-configured
    /// penalty on the withdrawn amount. See `locked::early_withdraw`.
    pub fn locked_early_withdraw(
        env: Env,
        owner: Address,
        plan_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        locked::early_withdraw(&env, owner, plan_id, amount)
    }

    pub fn locked_plan(env: Env, plan_id: u64) -> Result<LockedPlan, Error> {
        locked::get_plan(&env, plan_id)
    }

    // --- goal --------------------------------------------------------------
    pub fn goal_create(
        env: Env,
        owner: Address,
        name: String,
        target_amount: i128,
    ) -> Result<u64, Error> {
        goal::create(&env, owner, name, target_amount)
    }

    pub fn goal_contribute(
        env: Env,
        from: Address,
        goal_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        goal::contribute(&env, from, goal_id, amount)
    }

    pub fn goal_claim(env: Env, owner: Address, goal_id: u64) -> Result<(), Error> {
        goal::claim(&env, owner, goal_id)
    }

    /// Enable or disable automatic renewal for a goal. Owner-only. When
    /// enabled, `goal_claim` restarts the goal instead of closing it.
    pub fn goal_set_auto_renew(
        env: Env,
        owner: Address,
        goal_id: u64,
        auto_renew: bool,
    ) -> Result<(), Error> {
        goal::set_auto_renew(&env, owner, goal_id, auto_renew)
    }

    pub fn goal(env: Env, goal_id: u64) -> Result<Goal, Error> {
        goal::get_goal(&env, goal_id)
    }

    pub fn goal_contributions(env: Env, goal_id: u64) -> Result<Map<Address, i128>, Error> {
        goal::get_contributions(&env, goal_id)
    }

    // --- group -------------------------------------------------------------
    pub fn group_create(env: Env, creator: Address, name: String) -> Result<u64, Error> {
        group::create(&env, creator, name)
    }

    /// Create a group with per-member contribution limits (`0` = no limit).
    ///
    /// `min_contribution` applies to each deposit; `max_contribution` caps a
    /// member's cumulative total in the pool.
    pub fn group_create_with_limits(
        env: Env,
        creator: Address,
        name: String,
        min_contribution: i128,
        max_contribution: i128,
    ) -> Result<u64, Error> {
        group::create_with_limits(&env, creator, name, min_contribution, max_contribution)
    }

    /// Contribution limits configured for a group. Both zero when unlimited.
    pub fn group_limits(env: Env, group_id: u64) -> Result<GroupLimits, Error> {
        group::get_limits(&env, group_id)
    }

    /// Total a member has contributed to a group so far.
    pub fn group_member_contribution(
        env: Env,
        group_id: u64,
        member: Address,
    ) -> Result<i128, Error> {
        group::get_member_contribution(&env, group_id, member)
    }

    pub fn group_join(env: Env, member: Address, group_id: u64) -> Result<(), Error> {
        group::join(&env, member, group_id)
    }

    pub fn group_contribute(
        env: Env,
        member: Address,
        group_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        group::contribute(&env, member, group_id, amount)
    }

    pub fn group_close(env: Env, creator: Address, group_id: u64) -> Result<(), Error> {
        group::close(&env, creator, group_id)
    }

    pub fn group_payout_equal(env: Env, caller: Address, group_id: u64) -> Result<(), Error> {
        group::payout_equal(&env, caller, group_id)
    }

    pub fn group(env: Env, group_id: u64) -> Result<Group, Error> {
        group::get_group(&env, group_id)
    }

    // --- group split -------------------------------------------------------
    pub fn group_set_shares(
        env: Env,
        creator: Address,
        group_id: u64,
        shares_bps: Map<Address, u32>,
    ) -> Result<(), Error> {
        group_split::set_shares(&env, creator, group_id, shares_bps)
    }

    pub fn group_settle(env: Env, caller: Address, group_id: u64) -> Result<(), Error> {
        group_split::settle(&env, caller, group_id)
    }

    // --- group voting ------------------------------------------------------
    /// Set the voting window for spending proposals, in seconds. Creator-only;
    /// `0` disables proposals for the group.
    pub fn group_set_voting_period(
        env: Env,
        creator: Address,
        group_id: u64,
        seconds: u64,
    ) -> Result<(), Error> {
        voting::set_voting_period(&env, creator, group_id, seconds)
    }

    /// Propose spending `amount` from the group pool to `recipient`. Any member
    /// may propose once the group is closed and a voting period is configured.
    pub fn group_propose(
        env: Env,
        proposer: Address,
        group_id: u64,
        recipient: Address,
        amount: i128,
    ) -> Result<u64, Error> {
        voting::propose(&env, proposer, group_id, recipient, amount)
    }

    /// Cast a vote on a proposal. One vote per member, either way, while the
    /// voting window is open.
    pub fn group_vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        approve: bool,
    ) -> Result<(), Error> {
        voting::vote(&env, voter, proposal_id, approve)
    }

    /// Settle a proposal once its voting window has closed. Permissionless;
    /// returns whether it passed, and on a pass pays the pool to the recipient.
    pub fn group_execute(env: Env, caller: Address, proposal_id: u64) -> Result<bool, Error> {
        voting::execute(&env, caller, proposal_id)
    }

    pub fn group_proposal(env: Env, proposal_id: u64) -> Result<Proposal, Error> {
        voting::get_proposal(&env, proposal_id)
    }

    // --- interest ----------------------------------------------------------
    /// Set the annual interest rate applied to interest accounts, in basis
    /// points. Admin-only; `0` disables interest.
    pub fn set_interest_rate(env: Env, caller: Address, rate_bps: u32) -> Result<(), Error> {
        interest::set_rate(&env, caller, rate_bps)
    }

    /// The annual interest rate, in basis points. `0` means no interest.
    pub fn interest_rate_bps(env: Env) -> u32 {
        interest::rate_bps(&env)
    }

    /// Set the compounding frequency for interest accounts. Admin-only.
    pub fn set_interest_frequency(
        env: Env,
        caller: Address,
        frequency: CompoundFrequency,
    ) -> Result<(), Error> {
        interest::set_frequency(&env, caller, frequency)
    }

    /// The current compounding frequency (defaults to `Annually`).
    pub fn interest_frequency(env: Env) -> CompoundFrequency {
        interest::frequency(&env)
    }

    /// Deposit into the caller's interest-bearing account, creating it on
    /// first deposit and settling any interest accrued so far.
    pub fn interest_deposit(env: Env, owner: Address, amount: i128) -> Result<(), Error> {
        interest::deposit(&env, owner, amount)
    }

    /// Withdraw from the caller's interest account, settling accrued interest
    /// into the principal first.
    pub fn interest_withdraw(env: Env, owner: Address, amount: i128) -> Result<(), Error> {
        interest::withdraw(&env, owner, amount)
    }

    /// Credit accrued interest into the caller's principal and return the
    /// amount credited.
    pub fn interest_claim(env: Env, owner: Address) -> Result<i128, Error> {
        interest::claim(&env, owner)
    }

    /// Read an interest account (or `NotFound`).
    pub fn interest_account(env: Env, owner: Address) -> Result<InterestAccount, Error> {
        interest::get_account(&env, owner)
    }

    /// Preview the interest accrued but not yet credited to `owner`.
    pub fn interest_accrued(env: Env, owner: Address) -> Result<i128, Error> {
        interest::accrued(&env, owner)
    }

    // --- interest rate tiers (#619) ----------------------------------------

    /// Set the tiered interest-rate configuration. Admin-only.
    ///
    /// Rates must be non-decreasing across balance tiers (`low ≤ mid ≤ high`).
    /// No individual rate or bonus may exceed 10 000 bps (100 %). Emits an
    /// `InterestRateChanged` event.
    ///
    /// Errors: `NotInitialized`, `Unauthorized`, `InvalidParameters`.
    pub fn set_tiered_rate_config(
        env: Env,
        caller: Address,
        config: TieredRateConfig,
    ) -> Result<(), Error> {
        interest_tiers::set_tiered_rate_config(&env, caller, config)
    }

    /// Return the effective annual interest rate (bps) for an account with
    /// principal `balance` and remaining lock duration `lock_secs`.
    ///
    /// Pass `lock_secs = 0` for accounts with no active lock. This is a
    /// read-only view; it neither mutates state nor emits events.
    pub fn query_interest_rate(env: Env, balance: i128, lock_secs: u64) -> u32 {
        interest_tiers::query_rate(&env, balance, lock_secs)
    }

    // --- emergency mode (#428) --------------------------------------------

    /// Activate or deactivate emergency mode. Admin-only.
    /// In emergency mode only withdrawals are permitted.
    pub fn set_emergency_mode(env: Env, caller: Address, active: bool) -> Result<(), Error> {
        admin::set_emergency_mode(&env, caller, active)
    }

    /// Whether the contract is in emergency mode.
    pub fn is_emergency_mode(env: Env) -> bool {
        admin::is_emergency_mode(&env)
    }

    /// Emergency withdrawal from a locked plan. Bypasses the timelock,
    /// no penalty. Only available during emergency mode.
    pub fn locked_emergency_withdraw(env: Env, owner: Address, plan_id: u64) -> Result<(), Error> {
        locked::emergency_withdraw(&env, owner, plan_id)
    }

    // --- contract upgrade pattern (#429) ----------------------------------

    /// The current contract version number.
    pub fn version(env: Env) -> u32 {
        admin::version(&env)
    }

    /// The configured upgrade delay in seconds.
    pub fn upgrade_delay(env: Env) -> u64 {
        admin::upgrade_delay(&env)
    }

    /// Set the minimum delay before a proposed upgrade can execute.
    pub fn set_upgrade_delay(env: Env, caller: Address, seconds: u64) -> Result<(), Error> {
        admin::set_upgrade_delay(&env, caller, seconds)
    }

    /// Propose an upgrade with a timelock delay.
    pub fn propose_upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        admin::propose_upgrade(&env, caller, new_wasm_hash)
    }

    /// Execute a pending upgrade after the timelock elapses.
    pub fn execute_upgrade(env: Env, caller: Address) -> Result<(), Error> {
        admin::execute_upgrade(&env, caller)
    }

    /// Cancel a pending upgrade.
    pub fn cancel_upgrade(env: Env, caller: Address) -> Result<(), Error> {
        admin::cancel_upgrade(&env, caller)
    }

    /// Read the pending upgrade proposal, if any.
    pub fn pending_upgrade(env: Env) -> Option<UpgradeProposal> {
        admin::pending_upgrade(&env)
    }

    /// Run post-upgrade state migration. Admin-only.
    pub fn migrate(env: Env, caller: Address) -> Result<(), Error> {
        admin::migrate(&env, caller)
    }

    /// Roll back to the previous version. Admin-only.
    ///
    /// Available only after a successful `execute_upgrade`; the rollback
    /// snapshot is cleared once used (single-level rollback). Decrements the
    /// version counter and emits an `upgrade_rolled_back` event.
    ///
    /// Errors `NoRollbackAvailable` if no snapshot exists (either no upgrade
    /// has been executed since initialize, or rollback has already been used
    /// once since the last upgrade).
    pub fn rollback_upgrade(env: Env, caller: Address) -> Result<(), Error> {
        upgrade::rollback_upgrade(&env, caller)
    }

    /// Whether a rollback snapshot is currently available.
    ///
    /// Returns `true` immediately after a successful `execute_upgrade` and
    /// `false` after `rollback_upgrade` is called (or before the first upgrade).
    pub fn rollback_available(env: Env) -> bool {
        upgrade::rollback_available(&env)
    }

    // --- insurance fund (#435) --------------------------------------------

    /// The insurance premium rate in basis points.
    pub fn insurance_premium_bps(env: Env) -> u32 {
        insurance::premium_bps(&env)
    }

    /// Set the insurance premium rate. Admin-only.
    pub fn set_insurance_premium_bps(env: Env, caller: Address, bps: u32) -> Result<(), Error> {
        insurance::set_premium_bps(&env, caller, bps)
    }

    /// The current insurance fund balance.
    pub fn insurance_fund_balance(env: Env) -> i128 {
        insurance::fund_balance(&env)
    }

    /// Add funds to the insurance pool. Admin-only.
    pub fn insurance_fund(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        insurance::fund(&env, caller, amount)
    }

    /// The maximum per-claim amount in basis points of fund balance.
    pub fn insurance_max_claim_bps(env: Env) -> u32 {
        insurance::max_claim_bps(&env)
    }

    /// Set the maximum per-claim basis points. Admin-only.
    pub fn set_insurance_max_claim_bps(env: Env, caller: Address, bps: u32) -> Result<(), Error> {
        insurance::set_max_claim_bps(&env, caller, bps)
    }

    /// Approve an insurance claim. Admin-only.
    pub fn insurance_approve_claim(
        env: Env,
        caller: Address,
        claimant: Address,
        amount: i128,
    ) -> Result<(), Error> {
        insurance::approve_claim(&env, caller, claimant, amount)
    }

    /// Redeem an approved insurance claim.
    pub fn insurance_redeem_claim(env: Env, claimant: Address) -> Result<i128, Error> {
        insurance::redeem_claim(&env, claimant)
    }

    /// Read an insurance claim record.
    pub fn insurance_claim(env: Env, claimant: Address) -> Result<InsuranceClaimRecord, Error> {
        insurance::get_claim(&env, claimant)
    }

    // --- vault split (#629) -----------------------------------------------

    /// Initiate a split of the joint vault identified by `group_id`.
    ///
    /// The group must be **closed** before a split can be requested.
    /// The requester is automatically counted as having approved. All other
    /// co-owners must call `vault_split_approve` before `vault_split_execute`
    /// becomes callable.
    ///
    /// Returns the new split-request id.
    pub fn vault_split_request(
        env: Env,
        requester: Address,
        group_id: u64,
    ) -> Result<u64, Error> {
        split::request_split(&env, requester, group_id)
    }

    /// Record `approver`'s consent to the pending split identified by
    /// `split_id`. Each co-owner may approve exactly once.
    pub fn vault_split_approve(
        env: Env,
        approver: Address,
        split_id: u64,
    ) -> Result<(), Error> {
        split::approve_split(&env, approver, split_id)
    }

    /// Execute a fully-approved split.
    ///
    /// Permissionless once all co-owners have approved — funds always go to
    /// the recorded members, never to `caller`.
    ///
    /// Each member's share of the pool is credited to their `FlexibleAccount`
    /// (created if absent) proportional to their contribution to the group.
    /// One `vault_split` event is emitted per member.
    pub fn vault_split_execute(env: Env, caller: Address, split_id: u64) -> Result<(), Error> {
        split::execute_split(&env, caller, split_id)
    }

    /// Read a split request by id, or `NotFound`.
    pub fn vault_split_request_get(
        env: Env,
        split_id: u64,
    ) -> Result<SplitRequest, Error> {
        split::get_split_request(&env, split_id)
    }

    /// Return the active (un-executed) split-request id for `group_id`, if any.
    pub fn vault_split_active(env: Env, group_id: u64) -> Option<u64> {
        split::active_split_id(&env, group_id)
    }
}

