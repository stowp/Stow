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
mod locked;
mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Map, String};

use crate::error::Error;
use crate::types::{FlexibleAccount, Goal, Group, LockedPlan};

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
}
