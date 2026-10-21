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
mod error;
mod events;
mod flexible;
mod goal;
mod group;
mod group_split;
mod inheritance;
mod interest;
mod challenge;
mod locked;
mod storage;
mod types;
mod voting;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Map, String};

use crate::error::Error;
use crate::types::{
    Challenge, CompoundFrequency, FlexibleAccount, Goal, Group, InheritancePlan, InterestAccount,
    LockedPlan, Proposal,
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
    pub fn locked_create(env: Env, owner: Address, amount: i128, unlock_at: u64) -> Result<u64, Error> {
        locked::create(&env, owner, amount, unlock_at)
    }

    pub fn locked_top_up(env: Env, owner: Address, plan_id: u64, amount: i128) -> Result<(), Error> {
        locked::top_up(&env, owner, plan_id, amount)
    }

    pub fn locked_withdraw(env: Env, owner: Address, plan_id: u64, amount: i128) -> Result<(), Error> {
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
    pub fn goal_create(env: Env, owner: Address, name: String, target_amount: i128) -> Result<u64, Error> {
        goal::create(&env, owner, name, target_amount)
    }

    pub fn goal_contribute(env: Env, from: Address, goal_id: u64, amount: i128) -> Result<(), Error> {
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

    // --- group -------------------------------------------------------------
    pub fn group_create(env: Env, creator: Address, name: String) -> Result<u64, Error> {
        group::create(&env, creator, name)
    }

    pub fn group_join(env: Env, member: Address, group_id: u64) -> Result<(), Error> {
        group::join(&env, member, group_id)
    }

    pub fn group_contribute(env: Env, member: Address, group_id: u64, amount: i128) -> Result<(), Error> {
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
    pub fn group_set_shares(env: Env, creator: Address, group_id: u64, shares_bps: Map<Address, u32>) -> Result<(), Error> {
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

    // --- inheritance (issue #439) -------------------------------------------

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
    pub fn remove_beneficiary(
        env: Env,
        owner: Address,
        beneficiary: Address,
    ) -> Result<(), Error> {
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

    // --- challenges (issue #442) ---------------------------------------------

    /// Create a new savings challenge.
    ///
    /// `creator` becomes the first participant and pays the `entry_fee`.
    /// Returns the challenge id.
    pub fn create_challenge(
        env: Env,
        creator: Address,
        target_amount: i128,
        entry_fee: i128,
        deadline: u64,
        min_participants: u32,
    ) -> Result<u64, Error> {
        challenge::create(&env, creator, target_amount, entry_fee, deadline, min_participants)
    }

    /// Join a savings challenge and pay the entry fee.
    pub fn join_challenge(env: Env, participant: Address, challenge_id: u64) -> Result<(), Error> {
        challenge::join(&env, participant, challenge_id)
    }

    /// Deposit savings toward the caller's target within a challenge.
    pub fn save_challenge(
        env: Env,
        participant: Address,
        challenge_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        challenge::save(&env, participant, challenge_id, amount)
    }

    /// Verify on-chain that the caller has reached the target and claim the
    /// prize pool.
    pub fn claim_winner(env: Env, participant: Address, challenge_id: u64) -> Result<(), Error> {
        challenge::claim_winner(&env, participant, challenge_id)
    }

    /// Refund all entry fees after the deadline has passed without a winner.
    /// Permissionless — any address may trigger.
    pub fn refund_expired(env: Env, caller: Address, challenge_id: u64) -> Result<(), Error> {
        challenge::refund_expired(&env, caller, challenge_id)
    }

    /// Read a challenge by id.
    pub fn get_challenge(env: Env, challenge_id: u64) -> Result<Challenge, Error> {
        challenge::get_challenge(&env, challenge_id)
    }
}

