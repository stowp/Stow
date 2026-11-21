//! Event topic registry.
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

// --- upgrade -----------------------------------------------------------

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
