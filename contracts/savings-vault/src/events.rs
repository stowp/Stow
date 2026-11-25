//! Event topic registry.
#![allow(dead_code)]
//!
//! The off-chain indexer decodes contract events by topic. This module is
//! the canonical, compile-checked registry of topic name strings; the full
//! schema — data fields, types, encoding, and stability guarantees — is
//! documented in `README.md` under "Event schema". Keep the two in sync:
//! any change here (new topic, renamed topic) must be reflected there.
//!
//! Schema version: [`EVENT_SCHEMA_VERSION`]. Bump it whenever a change is
//! breaking for a decoder built against the previous version — see the
//! README's "Stability guarantees" for the exact rules.

/// Schema version for the event topics defined below, documented in
/// `README.md` ("Event schema"). A decoder should read this from the
/// `init` event's data payload to confirm it matches what it was built
/// against before trusting subsequent events on a given contract instance.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

// --- lifecycle ---------------------------------------------------------
/// Emitted once, at the end of a successful `initialize` call.
pub const TOPIC_INIT: &str = "init";
/// Emitted at the end of a successful `set_admin` call.
pub const TOPIC_ADMIN_SET: &str = "admin_set";

// --- pause mechanism -------------------------------------------------------
/// Emitted when the vault is paused (via `pause` or `set_paused(true)`).
pub const TOPIC_PAUSED: &str = "paused";
/// Emitted when the vault is unpaused (via `unpause` or `set_paused(false)`).
pub const TOPIC_UNPAUSED: &str = "unpaused";

// --- flexible ------------------------------------------------------------
/// Emitted at the end of a successful `deposit` call.
pub const TOPIC_DEPOSIT: &str = "deposit";
/// Emitted at the end of a successful `withdraw` call.
pub const TOPIC_WITHDRAW: &str = "withdraw";

// --- locked --------------------------------------------------------------
/// Emitted at the end of a successful `locked_create` call.
pub const TOPIC_LOCKED_CREATED: &str = "locked_created";
/// Emitted at the end of a successful `locked_top_up` call.
pub const TOPIC_LOCKED_TOP_UP: &str = "locked_top_up";
/// Emitted at the end of a successful `locked_withdraw` call.
pub const TOPIC_LOCKED_WITHDRAW: &str = "locked_withdraw";
/// Emitted at the end of a successful `locked_early_withdraw` call (a
/// penalized withdrawal before `unlock_at`).
pub const TOPIC_LOCKED_EARLY_WITHDRAW: &str = "locked_early_withdraw";

/// Emitted at the end of a successful `partial_liquidate` call. Data is
/// `(plan_id, owner, liquidated, penalty, remaining_balance, timestamp)`.
pub const TOPIC_PARTIAL_LIQUIDATION: &str = "PartialLiquidation";

// --- goal ------------------------------------------------------------------
/// Emitted at the end of a successful `goal_create` call.
pub const TOPIC_GOAL_CREATED: &str = "goal_created";
/// Emitted on every successful `goal_contribute` call.
pub const TOPIC_GOAL_CONTRIBUTION: &str = "goal_contribution";
/// Emitted once, the first time a goal's `saved_amount` reaches
/// `target_amount` (may be co-emitted with `goal_contribution` in the same
/// `goal_contribute` call).
pub const TOPIC_GOAL_REACHED: &str = "goal_reached";
/// Emitted at the end of a successful `goal_claim` call.
pub const TOPIC_GOAL_CLAIMED: &str = "goal_claimed";
/// Emitted at the end of a successful `goal_set_auto_renew` call.
pub const TOPIC_GOAL_AUTO_RENEW_SET: &str = "goal_auto_renew_set";
/// Emitted when claiming an auto-renewing goal restarts it (co-emitted with
/// `goal_claimed` in the same `goal_claim` call).
pub const TOPIC_GOAL_RENEWED: &str = "goal_renewed";
/// Emitted once per contributor during a successful shared-goal claim.
pub const TOPIC_GOAL_SPLIT_PAID: &str = "goal_split_paid";

// --- group -------------------------------------------------------------
/// Emitted at the end of a successful `group_create` call.
pub const TOPIC_GROUP_CREATED: &str = "group_created";
/// Emitted at the end of a successful `group_join` call.
pub const TOPIC_GROUP_JOINED: &str = "group_joined";
/// Emitted on every successful `group_contribute` call.
pub const TOPIC_GROUP_CONTRIBUTION: &str = "group_contribution";
/// Emitted at the end of a successful `group_close` call.
pub const TOPIC_GROUP_CLOSED: &str = "group_closed";
/// Emitted once per member during a successful `group_payout_equal` call.
pub const TOPIC_GROUP_PAYOUT: &str = "group_payout";
/// Emitted when a multi-signature group withdrawal is requested.
pub const TOPIC_GROUP_WITHDRAWAL_REQUESTED: &str = "group_withdrawal_requested";
/// Emitted when a group member approves a pending withdrawal.
pub const TOPIC_GROUP_WITHDRAWAL_APPROVED: &str = "group_withdrawal_approved";
/// Emitted when a member rejects a pending group withdrawal.
pub const TOPIC_GROUP_WITHDRAWAL_REJECTED: &str = "group_withdrawal_rejected";
/// Emitted when a group withdrawal reaches threshold and is paid.
pub const TOPIC_GROUP_WITHDRAWAL_EXECUTED: &str = "group_withdrawal_executed";

// --- group split -------------------------------------------------------
/// Emitted at the end of a successful `group_set_shares` call.
pub const TOPIC_GROUP_SHARES_SET: &str = "group_shares_set";
/// Emitted once per member during a successful `group_settle` call.
///
/// Topics: `(Symbol("group_split_settled"), member: Address, group_id: u64)`
/// Data:   `(group_id: u64, member: Address, amount: i128, timestamp: u64)`
pub const TOPIC_GROUP_SPLIT_SETTLED: &str = "group_split_settled";

// --- group voting ------------------------------------------------------
/// Emitted at the end of a successful `group_set_voting_period` call.
pub const TOPIC_GROUP_VOTING_PERIOD_SET: &str = "group_voting_period_set";
/// Emitted at the end of a successful `group_propose` call.
pub const TOPIC_GROUP_PROPOSAL_CREATED: &str = "group_proposal_created";
/// Emitted on every successful `group_vote` call.
pub const TOPIC_GROUP_VOTE_CAST: &str = "group_vote_cast";
/// Emitted at the end of a successful `group_execute` call, recording the
/// outcome (`passed`) and the amount actually paid out (`spent`, 0 on a fail).
pub const TOPIC_GROUP_PROPOSAL_EXECUTED: &str = "group_proposal_executed";

// --- interest ----------------------------------------------------------
/// Emitted at the end of a successful `set_interest_rate` call.
pub const TOPIC_INTEREST_RATE_SET: &str = "interest_rate_set";
/// Emitted at the end of a successful `set_interest_frequency` call.
pub const TOPIC_INTEREST_FREQUENCY_SET: &str = "interest_frequency_set";
/// Emitted at the end of a successful `interest_deposit` call.
pub const TOPIC_INTEREST_DEPOSIT: &str = "interest_deposit";
/// Emitted at the end of a successful `interest_withdraw` call.
pub const TOPIC_INTEREST_WITHDRAW: &str = "interest_withdraw";
/// Emitted at the end of a successful `interest_claim` call, recording the
/// interest credited to principal.
pub const TOPIC_INTEREST_CLAIMED: &str = "interest_claimed";
/// Emitted when the effective interest rate changes for an account, e.g.
/// after a deposit crosses a balance tier threshold or the lock period
/// changes. Also emitted by `set_tiered_rate_config`.
///
/// Topics: `(Symbol("interest_rate_changed"), owner: Address)` or just
///         `(Symbol("interest_rate_changed"),)` for the admin config event.
/// Data:   see [`crate::interest_tiers`] for field ordering.
pub const TOPIC_INTEREST_RATE_CHANGED: &str = "interest_rate_changed";

// --- recurring deposits (#615) --------------------------------------------
/// Emitted after a recurring deposit is successfully executed.
pub const TOPIC_RECURRING_DEPOSIT_EXECUTED: &str = "RecurringDepositExecuted";

// --- emergency pause (#428) -----------------------------------------------
/// Emitted when the contract enters or exits emergency mode.
pub const TOPIC_EMERGENCY_MODE_SET: &str = "emergency_mode_set";
/// Emitted on a successful emergency withdrawal.
pub const TOPIC_EMERGENCY_WITHDRAW: &str = "emergency_withdraw";

// --- contract upgrade (#429 / #618) ---------------------------------------
/// Emitted when an upgrade is proposed.
pub const TOPIC_UPGRADE_PROPOSED: &str = "upgrade_proposed";
/// Emitted when a pending upgrade is cancelled.
pub const TOPIC_UPGRADE_CANCELLED: &str = "upgrade_cancelled";
/// Emitted when a pending upgrade executes successfully.
///
/// Topics: `(Symbol("upgraded"),)`
/// Data:   `(caller: Address, new_wasm_hash: BytesN<32>, old_version: u32,
///            new_version: u32, timestamp: u64)`
pub const TOPIC_UPGRADED: &str = "upgraded";
/// Emitted when the contract is rolled back to a previous version.
///
/// Topics: `(Symbol("upgrade_rolled_back"),)`
/// Data:   `(caller: Address, restored_version: u32, timestamp: u64)`
pub const TOPIC_UPGRADE_ROLLED_BACK: &str = "upgrade_rolled_back";

// --- vault split (#629) ---------------------------------------------------
/// Emitted at the end of a successful `vault_split_request` call.
///
/// Topics: `(Symbol("vault_split_requested"), requester: Address, group_id: u64)`
/// Data:   `(split_id: u64, group_id: u64, requester: Address, timestamp: u64)`
pub const TOPIC_VAULT_SPLIT_REQUESTED: &str = "vault_split_requested";
/// Emitted each time a co-owner approves a pending split.
///
/// Topics: `(Symbol("vault_split_approved"), approver: Address, split_id: u64)`
/// Data:   `(split_id: u64, group_id: u64, approver: Address, timestamp: u64)`
pub const TOPIC_VAULT_SPLIT_APPROVED: &str = "vault_split_approved";
/// Emitted once per owner when a split is executed (one event per new vault).
///
/// Topics: `(Symbol("vault_split"), owner: Address, split_id: u64)`
/// Data:   `(split_id: u64, group_id: u64, owner: Address, amount: i128, timestamp: u64)`
pub const TOPIC_VAULT_SPLIT: &str = "vault_split";

// --- insurance fund (#435) ------------------------------------------------
/// Emitted when the insurance premium rate changes.
pub const TOPIC_INSURANCE_PREMIUM_SET: &str = "insurance_premium_set";
/// Emitted when funds are added to the insurance pool.
pub const TOPIC_INSURANCE_FUNDED: &str = "insurance_funded";
/// Emitted when an insurance claim is approved.
pub const TOPIC_INSURANCE_CLAIM_APPROVED: &str = "insurance_claim_approved";
/// Emitted when an insurance claim is redeemed.
pub const TOPIC_INSURANCE_CLAIM_REDEEMED: &str = "insurance_claim_redeemed";

// --- rewards -----------------------------------------------------------
/// Emitted when a reward pool is funded.
pub const TOPIC_REWARD_FUNDED: &str = "reward_funded";
/// Emitted when reward configuration is set.
pub const TOPIC_REWARD_CONFIG_SET: &str = "reward_config_set";
/// Emitted when a reward accrues to a user.
pub const TOPIC_REWARD_ACCRUED: &str = "reward_accrued";
/// Emitted when a user claims accrued rewards.
pub const TOPIC_REWARD_CLAIMED: &str = "reward_claimed";
/// Emitted when a user's savings streak is updated.
pub const TOPIC_STREAK_UPDATED: &str = "streak_updated";

// --- timelock ----------------------------------------------------------
/// Emitted when an admin action is queued behind the timelock.
pub const TOPIC_TIMELOCK_QUEUED: &str = "timelock_queued";
/// Emitted when a queued action is executed.
pub const TOPIC_TIMELOCK_EXECUTED: &str = "timelock_executed";
/// Emitted when a queued action is cancelled.
pub const TOPIC_TIMELOCK_CANCELLED: &str = "timelock_cancelled";

// --- delegation --------------------------------------------------------
/// Emitted when an owner grants a delegation.
pub const TOPIC_DELEGATION_GRANTED: &str = "delegation_granted";
/// Emitted when a delegation's permission level or expiry is updated.
pub const TOPIC_DELEGATION_UPDATED: &str = "delegation_updated";
/// Emitted when a delegation is revoked.
pub const TOPIC_DELEGATION_REVOKED: &str = "delegation_revoked";

// --- roundup -----------------------------------------------------------
/// Emitted when an owner turns round-ups on or changes the level.
pub const TOPIC_ROUNDUP_ENABLED: &str = "roundup_enabled";
/// Emitted when an owner turns round-ups off.
pub const TOPIC_ROUNDUP_DISABLED: &str = "roundup_disabled";
/// Emitted when an external transaction's round-up difference is deposited.
pub const TOPIC_ROUNDUP_DEPOSIT: &str = "RoundupDeposit";
/// Emitted when a round-up is skipped because the owner's token balance
/// cannot cover the difference.
pub const TOPIC_ROUNDUP_SKIPPED: &str = "RoundupSkipped";

// --- locked rollover (#638) ---------------------------------------------
/// Emitted when an owner enables (or reconfigures) auto-rollover on a plan.
pub const TOPIC_ROLLOVER_ENABLED: &str = "rollover_enabled";
/// Emitted when an owner opts out of auto-rollover before maturity.
pub const TOPIC_ROLLOVER_DISABLED: &str = "rollover_disabled";
/// Emitted when a matured plan is rolled into a new locked plan.
///
/// Topics: `(Symbol("VaultRolledOver"), owner: Address, old_plan_id: u64)`
/// Data:   `(old_plan_id: u64, new_plan_id: u64, principal: i128,
///          interest: i128, new_balance: i128, new_unlock_at: u64, timestamp: u64)`
pub const TOPIC_VAULT_ROLLED_OVER: &str = "VaultRolledOver";

// --- conditional withdrawals (#639) -------------------------------------
/// Emitted when the admin configures the price oracle.
pub const TOPIC_PRICE_ORACLE_SET: &str = "price_oracle_set";
/// Emitted when an owner sets a withdrawal condition.
pub const TOPIC_WITHDRAWAL_CONDITION_SET: &str = "withdrawal_condition_set";
/// Emitted when an owner cancels a pending withdrawal condition.
pub const TOPIC_WITHDRAWAL_CONDITION_CANCELLED: &str = "withdrawal_condition_cancelled";
/// Emitted when a conditional withdrawal executes.
///
/// Topics: `(Symbol("ConditionalWithdrawal"), owner: Address)`
/// Data:   `(owner: Address, amount: i128, condition: WithdrawalCondition,
///          observed: i128, new_balance: i128, timestamp: u64)`
pub const TOPIC_CONDITIONAL_WITHDRAWAL: &str = "ConditionalWithdrawal";

// --- inheritance planning (#635) ----------------------------------------
/// Emitted when an owner creates or replaces an inheritance plan.
///
/// Topics: `(Symbol("InheritanceSetup"), owner: Address)`
/// Data:   `(owner: Address, beneficiary_count: u32, inactivity_period: u64,
///          partial_access_bps: u32, proof_required: bool, timestamp: u64)`
pub const TOPIC_INHERITANCE_SETUP: &str = "InheritanceSetup";
/// Emitted when the verifier attests the owner's proof of death.
///
/// Topics: `(Symbol("InheritanceProofVerified"), owner: Address)`
/// Data:   `(owner: Address, verifier: Address, proof_hash: BytesN<32>, timestamp: u64)`
pub const TOPIC_INHERITANCE_PROOF_VERIFIED: &str = "InheritanceProofVerified";
/// Emitted on every successful beneficiary claim (partial or full).
///
/// Topics: `(Symbol("InheritanceClaimed"), owner: Address, beneficiary: Address)`
/// Data:   `(owner: Address, beneficiary: Address, amount: i128,
///          total_claimed: i128, unlocked_bps: u32, timestamp: u64)`
pub const TOPIC_INHERITANCE_CLAIMED: &str = "InheritanceClaimed";
/// Emitted when the owner cancels their inheritance plan.
pub const TOPIC_INHERITANCE_CANCELLED: &str = "InheritanceCancelled";
