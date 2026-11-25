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
//! - [`rollover`] — locked plans that roll into a new term at maturity
//! - [`conditional`] — withdrawals gated on price, date or balance conditions
//! - [`inheritance`] — gradual hand-over of savings to beneficiaries
//!
//! This is a **skeleton**: every entrypoint is stubbed with `unimplemented!()`
//! and a `TODO(issue)` describing the work. Each stub is one contributor issue.

mod admin;
mod challenge;
mod collateral;
mod conditional;
mod delegation;
mod error;
mod events;
mod fees;
mod flexible;
mod goal;
mod group;
mod group_split;
mod inheritance;
mod insurance;
mod interest;
pub mod interest_tiers;
mod limits;
mod locked;
mod multisig;
mod profit_share;
mod recurring;
pub mod rewards;
mod rollover;
mod roundup;
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

#[cfg(test)]
#[path = "test/collateral_test.rs"]
mod collateral_test;

#[cfg(test)]
#[path = "test/profit_share_test.rs"]
mod profit_share_test;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Map, String, Vec};

use crate::error::Error;
use crate::types::{
    Challenge, ChallengeKind, CompoundFrequency, Delegation, FlexibleAccount, Goal, Group,
    GroupLimits, GroupWithdrawalRequest, InheritancePlan, InsuranceClaimRecord, InterestAccount, LockedPlan,
    PermissionLevel, Proposal, QueuedAction, RecurringDeposit, RecurringFrequency, RewardState,
    RewardsConfig, RoundupConfig, RoundupLevel, TimelockAction, UpgradeProposal,
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

    // --- conditional withdrawals (#639) -----------------------------------
    /// Set the price oracle consulted by price-based withdrawal conditions.
    /// Admin-only.
    pub fn set_price_oracle(env: Env, caller: Address, oracle: Address) -> Result<(), Error> {
        conditional::set_price_oracle(&env, caller, oracle)
    }

    /// The configured price oracle, if any.
    pub fn price_oracle(env: Env) -> Option<Address> {
        conditional::price_oracle(&env)
    }

    /// Register a withdrawal of `amount` from the owner's flexible account
    /// that may only execute once `condition` holds.
    pub fn set_withdrawal_condition(
        env: Env,
        owner: Address,
        condition: WithdrawalCondition,
        amount: i128,
    ) -> Result<(), Error> {
        conditional::set_withdrawal_condition(&env, owner, condition, amount)
    }

    /// Cancel the owner's pending conditional withdrawal.
    pub fn cancel_withdrawal_condition(env: Env, owner: Address) -> Result<(), Error> {
        conditional::cancel_withdrawal_condition(&env, owner)
    }

    /// The owner's pending conditional withdrawal, if any.
    pub fn withdrawal_condition(env: Env, owner: Address) -> Option<ConditionalWithdrawalRule> {
        conditional::get_withdrawal_condition(&env, owner)
    }

    /// Execute the owner's conditional withdrawal once its condition holds.
    /// Permissionless; funds are always paid to `owner`.
    pub fn execute_conditional_withdrawal(env: Env, owner: Address) -> Result<i128, Error> {
        conditional::execute_conditional_withdrawal(&env, owner)
    }

    // --- recurring deposits (#615) ----------------------------------------
    /// Set up a recurring wallet deposit. The owner must authorize the call
    /// and approve the vault as a SEP-41 spender before execution.
    pub fn setup_recurring(
        env: Env,
        owner: Address,
        amount: i128,
        frequency: RecurringFrequency,
    ) -> Result<u64, Error> {
        recurring::setup(&env, owner, amount, frequency)
    }

    /// Execute a due recurring deposit. Permissionless; the owner's existing
    /// SEP-41 allowance funds the transfer.
    pub fn execute_recurring(env: Env, owner: Address) -> Result<(), Error> {
        recurring::execute(&env, owner)
    }

    /// Cancel the owner's recurring deposit schedule.
    pub fn cancel_recurring(env: Env, owner: Address) -> Result<(), Error> {
        recurring::cancel(&env, owner)
    }

    /// Read a recurring deposit schedule, if configured.
    pub fn recurring_deposit(env: Env, owner: Address) -> Option<RecurringDeposit> {
        recurring::get(&env, owner)
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

    /// Liquidate `liquidation_bps` basis points of a still-locked plan's
    /// balance, paying the early-withdrawal penalty on that slice only. See
    /// `locked::partial_liquidate`.
    pub fn partial_liquidate(
        env: Env,
        owner: Address,
        plan_id: u64,
        liquidation_bps: u32,
    ) -> Result<i128, Error> {
        locked::partial_liquidate(&env, owner, plan_id, liquidation_bps)
    }

    pub fn locked_plan(env: Env, plan_id: u64) -> Result<LockedPlan, Error> {
        locked::get_plan(&env, plan_id)
    }

    // --- inheritance planning (#635) --------------------------------------
    /// Create or replace the owner's inheritance plan. `beneficiaries` maps
    /// heir → share in bps (summing to 10 000). Access unlocks after
    /// `inactivity_period` seconds without owner activity: first
    /// `partial_access_bps` of each share, then the rest once `verifier`
    /// attests proof of death (`None` = no proof required, full unlock).
    /// Emits `InheritanceSetup`.
    pub fn setup_inheritance(
        env: Env,
        owner: Address,
        beneficiaries: Map<Address, u32>,
        inactivity_period: u64,
        partial_access_bps: u32,
        verifier: Option<Address>,
    ) -> Result<(), Error> {
        inheritance::setup_inheritance(
            &env,
            owner,
            beneficiaries,
            inactivity_period,
            partial_access_bps,
            verifier,
        )
    }

    /// Cancel the owner's inheritance plan.
    pub fn cancel_inheritance(env: Env, owner: Address) -> Result<(), Error> {
        inheritance::cancel_inheritance(&env, owner)
    }

    /// Reset the owner's inactivity clock without moving funds.
    pub fn inheritance_check_in(env: Env, owner: Address) -> Result<(), Error> {
        inheritance::check_in(&env, owner)
    }

    /// Verifier-only: attest the owner's proof of death, unlocking the full
    /// share of every beneficiary.
    pub fn verify_death_proof(
        env: Env,
        verifier: Address,
        owner: Address,
        proof_hash: BytesN<32>,
    ) -> Result<(), Error> {
        inheritance::verify_death_proof(&env, verifier, owner, proof_hash)
    }

    /// Beneficiary claims everything unlocked for them so far. Returns the
    /// amount paid. Emits `InheritanceClaimed`.
    pub fn claim_inheritance(env: Env, beneficiary: Address, owner: Address) -> Result<i128, Error> {
        inheritance::claim_inheritance(&env, beneficiary, owner)
    }

    /// The owner's inheritance plan, if any.
    pub fn inheritance_plan(env: Env, owner: Address) -> Option<InheritancePlan> {
        inheritance::get_plan(&env, owner)
    }

    /// Amount `beneficiary` could claim from `owner`'s plan right now.
    pub fn inheritance_claimable(env: Env, owner: Address, beneficiary: Address) -> i128 {
        inheritance::claimable(&env, owner, beneficiary)
    }

    // --- locked rollover (#638) -------------------------------------------
    /// Opt a locked plan into auto-rollover at maturity. `lock_period` is the
    /// new plan's lock length in seconds; `0` reuses the original term.
    pub fn enable_auto_rollover(
        env: Env,
        owner: Address,
        plan_id: u64,
        lock_period: u64,
    ) -> Result<(), Error> {
        rollover::enable_auto_rollover(&env, owner, plan_id, lock_period)
    }

    /// Opt a locked plan out of auto-rollover. Only allowed before maturity.
    pub fn disable_auto_rollover(env: Env, owner: Address, plan_id: u64) -> Result<(), Error> {
        rollover::disable_auto_rollover(&env, owner, plan_id)
    }

    /// Roll a matured plan (balance + interest) into a new locked plan and
    /// close the original. Permissionless; returns the new plan id.
    pub fn execute_rollover(env: Env, plan_id: u64) -> Result<u64, Error> {
        rollover::execute_rollover(&env, plan_id)
    }

    /// A plan's auto-rollover settings, if enabled.
    pub fn rollover_config(env: Env, plan_id: u64) -> Option<RolloverConfig> {
        rollover::get_config(&env, plan_id)
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

    // --- group multi-signature withdrawals (#616) -------------------------
    pub fn request_withdrawal(
        env: Env,
        requester: Address,
        group_id: u64,
        recipient: Address,
        amount: i128,
        threshold: u32,
        expires_at: u64,
    ) -> Result<u64, Error> {
        multisig::request_withdrawal(
            &env, requester, group_id, recipient, amount, threshold, expires_at,
        )
    }

    pub fn approve_withdrawal(env: Env, approver: Address, request_id: u64) -> Result<(), Error> {
        multisig::approve_withdrawal(&env, approver, request_id)
    }

    pub fn reject_withdrawal(env: Env, rejector: Address, request_id: u64) -> Result<(), Error> {
        multisig::reject_withdrawal(&env, rejector, request_id)
    }

    pub fn withdrawal_request(env: Env, request_id: u64) -> Result<GroupWithdrawalRequest, Error> {
        multisig::get_withdrawal_request(&env, request_id)
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

    // --- profit sharing (#642) ---------------------------------------------

    /// Configure profit sharing for the caller's interest account: interest
    /// it earns is split among `stakeholders` by `shares_bps` (which must sum
    /// to 10 000 bps) once per `frequency` period.
    ///
    /// Calling again on an existing config queues the update; it applies
    /// from the next distribution period.
    ///
    /// Errors: `NotFound` (no interest account), `InvalidProfitShares`.
    pub fn configure_profit_sharing(
        env: Env,
        owner: Address,
        stakeholders: Vec<Address>,
        shares_bps: Vec<u32>,
        frequency: DistributionFrequency,
    ) -> Result<(), Error> {
        profit_share::configure(&env, owner, stakeholders, shares_bps, frequency)
    }

    /// Split `owner`'s accumulated interest among its stakeholders. Callable
    /// by anyone once the distribution period has elapsed. Returns the total
    /// paid out and emits `ProfitDistributed`.
    ///
    /// Errors: `NotFound`, `DistributionNotDue`, `InsufficientBalance`.
    pub fn distribute_profit(env: Env, owner: Address) -> Result<i128, Error> {
        profit_share::distribute(&env, owner)
    }

    /// Read `owner`'s profit-sharing config, if any.
    pub fn profit_share_config(env: Env, owner: Address) -> Option<ProfitShareConfig> {
        profit_share::get_config(&env, owner)
    }

    /// Lifetime amount paid to `stakeholder` from `owner`'s profit sharing.
    pub fn profit_distributed(env: Env, owner: Address, stakeholder: Address) -> i128 {
        profit_share::distributed_to(&env, owner, stakeholder)
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
    pub fn propose_upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), Error> {
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

    // --- flexible fee structure (issue #430) ---------------------------------
    pub fn fee_bps(env: Env) -> u32 {
        fees::fee_bps(&env)
    }

    pub fn set_fee_bps(env: Env, bps: u32) -> Result<(), Error> {
        fees::set_fee_bps(&env, bps)
    }

    pub fn fee_recipient(env: Env) -> Result<Address, Error> {
        fees::fee_recipient(&env)
    }

    pub fn set_fee_recipient(env: Env, recipient: Address) -> Result<(), Error> {
        fees::set_fee_recipient(&env, recipient)
    }

    // --- rewards (issue #440) ------------------------------------------------
    pub fn reward_set_config(
        env: Env,
        caller: Address,
        config: RewardsConfig,
    ) -> Result<(), Error> {
        rewards::set_config(&env, caller, config)
    }

    pub fn reward_config(env: Env) -> RewardsConfig {
        rewards::get_config(&env)
    }

    pub fn reward_fund(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        rewards::fund_pool(&env, caller, amount)
    }

    pub fn reward_pool_balance(env: Env) -> i128 {
        rewards::pool_balance(&env)
    }

    pub fn reward_accrue(env: Env, owner: Address) -> Result<i128, Error> {
        rewards::accrue(&env, owner)
    }

    pub fn reward_claim(env: Env, owner: Address) -> Result<i128, Error> {
        rewards::claim(&env, owner)
    }

    pub fn reward_ping(env: Env, owner: Address) -> Result<(), Error> {
        rewards::ping(&env, owner)
    }

    pub fn reward_state(env: Env, owner: Address) -> Option<RewardState> {
        rewards::get_reward_state(&env, owner)
    }

    pub fn reward_accrued_preview(env: Env, owner: Address) -> Result<i128, Error> {
        rewards::accrued_preview(&env, owner)
    }

    // --- delegation (issue #437) ---------------------------------------------
    pub fn delegate_savings(
        env: Env,
        owner: Address,
        delegate: Address,
        level: PermissionLevel,
        expires_at: Option<u64>,
    ) -> Result<(), Error> {
        delegation::delegate_savings(&env, owner, delegate, level, expires_at)
    }

    pub fn update_delegation(
        env: Env,
        owner: Address,
        delegate: Address,
        level: PermissionLevel,
        expires_at: Option<u64>,
    ) -> Result<(), Error> {
        delegation::update_delegation(&env, owner, delegate, level, expires_at)
    }

    pub fn revoke_delegation(env: Env, owner: Address, delegate: Address) -> Result<(), Error> {
        delegation::revoke_delegation(&env, owner, delegate)
    }

    pub fn get_delegation(
        env: Env,
        owner: Address,
        delegate: Address,
    ) -> Result<Delegation, Error> {
        delegation::get_delegation(&env, owner, delegate)
    }

    pub fn delegated_deposit(
        env: Env,
        delegate: Address,
        owner: Address,
        amount: i128,
    ) -> Result<(), Error> {
        delegation::delegated_deposit(&env, delegate, owner, amount)
    }

    pub fn delegated_withdraw(
        env: Env,
        delegate: Address,
        owner: Address,
        amount: i128,
    ) -> Result<(), Error> {
        delegation::delegated_withdraw(&env, delegate, owner, amount)
    }

    // --- timelock (issue #438) -----------------------------------------------
    pub fn queue_action(env: Env, action: TimelockAction) -> Result<u64, Error> {
        timelock::queue_action(&env, action)
    }

    pub fn execute_action(env: Env, id: u64) -> Result<(), Error> {
        timelock::execute_action(&env, id)
    }

    pub fn cancel_action(env: Env, id: u64) -> Result<(), Error> {
        timelock::cancel_action(&env, id)
    }

    pub fn get_queued_action(env: Env, id: u64) -> Result<QueuedAction, Error> {
        timelock::get_queued_action(&env, id)
    }

    pub fn timelock_delay(env: Env) -> u64 {
        timelock::get_delay(&env)
    }

    // --- savings challenges (issues #442, #623) ------------------------------
    pub fn create_challenge(
        env: Env,
        creator: Address,
        kind: ChallengeKind,
        target_amount: i128,
        entry_fee: i128,
        deadline: u64,
        min_participants: u32,
    ) -> Result<u64, Error> {
        challenge::create(
            &env,
            creator,
            kind,
            target_amount,
            entry_fee,
            deadline,
            min_participants,
        )
    }

    pub fn join_challenge(env: Env, participant: Address, challenge_id: u64) -> Result<(), Error> {
        challenge::join(&env, participant, challenge_id)
    }

    pub fn save_challenge(
        env: Env,
        participant: Address,
        challenge_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        challenge::save(&env, participant, challenge_id, amount)
    }

    pub fn settle_challenge(
        env: Env,
        participant: Address,
        challenge_id: u64,
    ) -> Result<i128, Error> {
        challenge::settle(&env, participant, challenge_id)
    }

    pub fn get_challenge(env: Env, challenge_id: u64) -> Result<Challenge, Error> {
        challenge::get_challenge(&env, challenge_id)
    }

    // --- savings round-ups (issue #622) --------------------------------------
    pub fn enable_roundup(env: Env, owner: Address, level: RoundupLevel) -> Result<(), Error> {
        roundup::enable(&env, owner, level)
    }

    pub fn disable_roundup(env: Env, owner: Address) -> Result<(), Error> {
        roundup::disable(&env, owner)
    }

    pub fn roundup_config(env: Env, owner: Address) -> Result<RoundupConfig, Error> {
        roundup::get_config(&env, owner)
    }

    pub fn record_roundup_transaction(
        env: Env,
        owner: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        roundup::record_transaction(&env, owner, amount)
    }

    // --- savings vault loan collateralization (#645) ----------------------

    /// Register `lender` as an authorised lender. Admin-only.
    pub fn register_lender(env: Env, caller: Address, lender: Address) -> Result<(), Error> {
        collateral::register_lender(&env, caller, lender)
    }

    /// Deregister a lender. Admin-only.
    pub fn deregister_lender(env: Env, caller: Address, lender: Address) -> Result<(), Error> {
        collateral::deregister_lender(&env, caller, lender)
    }

    /// Whether `lender` is registered.
    pub fn is_registered_lender(env: Env, lender: Address) -> bool {
        collateral::is_registered_lender(&env, &lender)
    }

    /// Enable the caller's vault as collateral for `loan_id`.
    ///
    /// Pass `loan_id = 0` to create a new loan; pass an existing id to join it.
    /// Returns the loan id (new or existing).
    pub fn enable_as_collateral(
        env: Env,
        owner: Address,
        loan_id: u64,
        borrow_ratio_bps: u32,
        liquidation_ratio_bps: u32,
    ) -> Result<u64, Error> {
        collateral::enable_as_collateral(
            &env,
            owner,
            loan_id,
            borrow_ratio_bps,
            liquidation_ratio_bps,
        )
    }

    /// Disable the caller's vault as collateral. Only permitted when debt is 0.
    pub fn disable_collateral(env: Env, owner: Address) -> Result<(), Error> {
        collateral::disable_collateral(&env, owner)
    }

    /// Record a borrow of `amount` against `owner`'s vault. Lender-only.
    pub fn collateral_borrow(
        env: Env,
        lender: Address,
        owner: Address,
        amount: i128,
    ) -> Result<(), Error> {
        collateral::record_borrow(&env, lender, owner, amount)
    }

    /// Record a repayment of `amount` against `owner`'s vault. Lender-only.
    pub fn collateral_repay(
        env: Env,
        lender: Address,
        owner: Address,
        amount: i128,
    ) -> Result<(), Error> {
        collateral::record_repay(&env, lender, owner, amount)
    }

    /// Liquidate `owner`'s vault if undercollateralized. Permissionless.
    pub fn liquidate(env: Env, owner: Address) -> Result<(), Error> {
        collateral::liquidate(&env, owner)
    }

    /// Read the collateral state for `owner` (or `NotFound`).
    pub fn collateral_state(env: Env, owner: Address) -> Result<CollateralState, Error> {
        collateral::get_collateral_state(&env, owner)
    }

    /// Read the loan record for `loan_id` (or `NotFound`).
    pub fn loan_record(env: Env, loan_id: u64) -> Result<LoanRecord, Error> {
        collateral::get_loan_record(&env, loan_id)
    }

    /// Read the vault owner addresses backing `loan_id`.
    pub fn loan_vaults(env: Env, loan_id: u64) -> Vec<Address> {
        collateral::get_loan_vaults(&env, loan_id)
    }

    /// Designate a beneficiary for the caller's flexible savings balance.
    ///
    /// Creates the inheritance plan on the first call. Pass `share_bps` in
    /// basis points (1–10_000). To enable claiming, all beneficiary shares must
    /// sum to exactly 10_000 and an inactivity timeout must be configured.
    pub fn designate_beneficiary(
        env: Env,
        owner: Address,
        beneficiary: Address,
        share_bps: u32,
    ) -> Result<(), Error> {
        inheritance::designate_beneficiary(&env, owner, beneficiary, share_bps)
    }

    /// Remove a beneficiary from the caller's inheritance plan.
    pub fn remove_beneficiary(env: Env, owner: Address, beneficiary: Address) -> Result<(), Error> {
        inheritance::remove_beneficiary(&env, owner, beneficiary)
    }

    /// Set the inactivity timeout (in seconds) for the caller's inheritance plan.
    ///
    /// Once `now >= last_active_at + timeout` and beneficiary shares sum to
    /// 10_000, any beneficiary may call `claim_inheritance`. Setting `0`
    /// disables automatic inheritance.
    pub fn set_inactivity_timeout(
        env: Env,
        owner: Address,
        timeout_seconds: u64,
    ) -> Result<(), Error> {
        inheritance::set_inactivity_timeout(&env, owner, timeout_seconds)
    }

    /// Claim the inheritance of `owner`'s flexible balance.
    ///
    /// Succeeds when: a plan exists, the inactivity timeout has elapsed,
    /// beneficiary shares sum to 10_000, and `claimer` is a designated
    /// beneficiary. Each beneficiary receives their proportional share.
    pub fn claim_inheritance(env: Env, claimer: Address, owner: Address) -> Result<(), Error> {
        inheritance::claim_inheritance(&env, claimer, owner)
    }

    /// Read the inheritance plan for `owner`.
    pub fn get_inheritance_plan(env: Env, owner: Address) -> Result<InheritancePlan, Error> {
        inheritance::get_plan(&env, owner)
    }
}
