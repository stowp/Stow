use soroban_sdk::{contracttype, Address, BytesN, Map, String, Vec};

// NOTE(#648): the `boost-nft` sibling crate is WIP and not yet publishable.
// DataKey::BoostNft and DataKey::BoostState, plus the `BoostState` struct and
// the `Tier` enum, will be added here once boost-nft lands. For now they are
// omitted so types.rs compiles on this branch.

// ---------------------------------------------------------------------------
// Rewards (new for #440)
// ---------------------------------------------------------------------------

/// Loyalty-multiplier tier: holds a position for at least `min_seconds` to
/// earn `multiplier_bps` (10_000 = 1.0×).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LoyaltyTier {
    /// Minimum continuous hold time in seconds to qualify.
    pub min_seconds: u64,
    /// Reward multiplier in basis points (10_000 = 1.0×).
    pub multiplier_bps: u32,
}

/// Admin-configurable rewards parameters.
///
/// Stored as a single instance-storage entry under `DataKey::RewardsConfig`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RewardsConfig {
    /// Annual base reward rate in basis points.
    pub base_rate_bps: u32,
    /// How many seconds make one accrual period (e.g. 604_800 = 1 week). Must be > 0.
    pub accrual_period_seconds: u64,
    /// Loyalty tiers (sorted ascending by `min_seconds`). Up to 4 tiers.
    pub loyalty_tiers: Vec<LoyaltyTier>,
    /// Maximum loyalty multiplier in basis points (≥ 10_000).
    pub loyalty_cap_bps: u32,
    /// Extra reward per consecutive kept streak period, in bps of principal.
    pub streak_bonus_bps_per_period: u32,
    /// Maximum streak bonus in basis points.
    pub streak_bonus_cap_bps: u32,
    /// Length of one streak period in seconds. Must be > 0.
    pub streak_period_seconds: u64,
}

/// Per-user reward tracking. Stored as a persistent entry under
/// `DataKey::RewardState(owner)`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RewardState {
    pub owner: Address,
    /// Rewards accrued but not yet claimed, in token stroops.
    pub pending: i128,
    /// Ledger timestamp of the last accrual.
    pub last_accrued_at: u64,
    /// Number of consecutive streak periods kept so far.
    pub streak: u32,
    /// Ledger timestamp of the start of the current streak period window.
    pub streak_period_start: u64,
    /// Whether the current streak period has already been satisfied.
    pub streak_period_kept: bool,
}

// ---------------------------------------------------------------------------
// Existing types
// ---------------------------------------------------------------------------

/// A flexible savings account: deposit and withdraw any time.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FlexibleAccount {
    pub owner: Address,
    /// Current balance held for this owner, in token stroops.
    pub balance: i128,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Interval used by a recurring deposit. Monthly means a fixed 30-day period.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecurringFrequency {
    Daily,
    Weekly,
    Monthly,
}

impl RecurringFrequency {
    pub fn seconds(self) -> u64 {
        match self {
            Self::Daily => 86_400,
            Self::Weekly => 604_800,
            Self::Monthly => 2_592_000,
        }
    }
}

/// One recurring wallet deposit schedule per owner.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecurringDeposit {
    pub owner: Address,
    pub amount: i128,
    pub frequency: RecurringFrequency,
    /// Ledger timestamp at or after which the next deposit may execute.
    pub next_execution: u64,
}

/// A pending threshold-approved withdrawal from a group pool.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GroupWithdrawalRequest {
    pub id: u64,
    pub group_id: u64,
    pub requester: Address,
    pub recipient: Address,
    pub amount: i128,
    /// Number of distinct group-member approvals required for execution.
    pub threshold: u32,
    /// Distinct member approvals received so far.
    pub approvers: Vec<Address>,
    pub expires_at: u64,
    pub rejected: bool,
    pub executed: bool,
}

/// A locked savings plan: funds cannot be withdrawn until `unlock_at`.
#[contracttype]
#[derive(Clone)]
pub struct LockedPlan {
    pub id: u64,
    pub owner: Address,
    pub balance: i128,
    /// Ledger timestamp after which withdrawal is permitted.
    pub unlock_at: u64,
    pub created_at: u64,
}

/// Auto-rollover settings for a locked plan (#638).
///
/// At maturity (`now >= plan.unlock_at`) the plan's balance plus accrued
/// interest is moved into a brand-new locked plan, and the original plan is
/// closed with a zero balance.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RolloverConfig {
    pub plan_id: u64,
    pub owner: Address,
    /// Lock period of the new plan, in seconds. `0` reuses the original
    /// plan's term (`unlock_at - created_at`).
    pub lock_period: u64,
    pub enabled_at: u64,
}

/// One heir in an owner's inheritance plan (#635).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Beneficiary {
    pub address: Address,
    /// Share of the owner's flexible balance, in basis points. All shares in
    /// a plan sum to exactly `10_000`.
    pub share_bps: u32,
    /// Amount already paid out to this beneficiary, in stroops.
    pub claimed: i128,
}

/// Inheritance plan for an owner's flexible savings (#635).
///
/// Access unlocks gradually:
/// 1. While the owner is active (`now < last_active_at + inactivity_period`)
///    beneficiaries cannot claim anything.
/// 2. Once the owner has been inactive for `inactivity_period`, each
///    beneficiary may claim `partial_access_bps` of their share.
/// 3. When the `verifier` attests a proof of death, the remainder of every
///    share unlocks. Plans without a verifier unlock in full at step 2.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InheritancePlan {
    pub owner: Address,
    pub beneficiaries: Vec<Beneficiary>,
    /// Seconds of owner inactivity after which access starts to unlock.
    pub inactivity_period: u64,
    /// Ledger timestamp of the owner's last recorded activity.
    pub last_active_at: u64,
    /// Portion of each share (bps) claimable before proof of death.
    pub partial_access_bps: u32,
    /// Trusted party that attests proof of death. `None` means no proof
    /// is required.
    pub verifier: Option<Address>,
    /// Hash of the attested proof-of-death document, once verified.
    pub proof_hash: Option<BytesN<32>>,
    /// Ledger timestamp at which the proof was attested.
    pub proof_verified_at: Option<u64>,
    /// Flexible balance frozen at the first claim; every share is computed
    /// against it so payout order cannot change what anyone receives.
    pub snapshot_balance: Option<i128>,
    pub created_at: u64,
}

/// A condition gating an automated withdrawal from a flexible account (#639).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum WithdrawalCondition {
    /// Withdraw once the oracle price of `asset` is strictly greater than
    /// `threshold` (in the oracle's price units).
    PriceAbove(Address, i128),
    /// Withdraw once the ledger timestamp reaches the given value.
    AfterDate(u64),
    /// Withdraw once the flexible account balance is strictly greater than
    /// the given amount, in token stroops.
    BalanceAbove(i128),
}

/// A pending conditional withdrawal: `amount` is paid to `owner` from their
/// flexible account once `condition` holds.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ConditionalWithdrawalRule {
    pub owner: Address,
    pub condition: WithdrawalCondition,
    pub amount: i128,
    pub created_at: u64,
}

/// A goal-based savings target with automated milestone tracking.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Goal {
    pub id: u64,
    pub owner: Address,
    pub name: String,
    pub target_amount: i128,
    pub saved_amount: i128,
    pub created_at: u64,
    /// Set when `saved_amount >= target_amount`.
    pub reached_at: Option<u64>,
    /// When true, claiming this goal restarts it instead of closing it:
    /// `saved_amount` is reset to 0 and `reached_at` is cleared, keeping the
    /// same id, name, and target so the owner can save toward it again.
    pub auto_renew: bool,
}

/// A group savings pool with shared rules and contract-enforced payouts.
#[contracttype]
#[derive(Clone)]
pub struct Group {
    pub id: u64,
    pub creator: Address,
    pub name: String,
    pub members: Vec<Address>,
    /// Total pooled balance.
    pub balance: i128,
    /// Per-member split in basis points (must sum to 10_000) for group-split payout.
    /// Empty for equal-split groups.
    pub shares_bps: Map<Address, u32>,
    pub open: bool,
    pub created_at: u64,
    /// Voting window, in seconds, for spending proposals on this group. Set
    /// by the creator via `group_set_voting_period`; `0` means proposals are
    /// disabled. See [`crate::voting`].
    pub voting_period: u64,
}

/// Per-member contribution limits for a group pool, set at creation.
///
/// A value of `0` disables that limit.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GroupLimits {
    /// Smallest amount accepted for a single contribution.
    pub min_contribution: i128,
    /// Largest cumulative amount a single member may contribute.
    pub max_contribution: i128,
}

/// A member proposal to spend part of a group's pool.
///
/// Any member opens one via `group_propose`; members cast one vote each with
/// `group_vote` before `voting_ends_at`, and `group_execute` settles the
/// outcome once the window closes. See [`crate::voting`].
#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub group_id: u64,
    pub proposer: Address,
    /// Address that receives `amount` if the proposal passes.
    pub recipient: Address,
    pub amount: i128,
    /// Ledger timestamp at/after which voting is closed and `group_execute`
    /// may run.
    pub voting_ends_at: u64,
    /// Members who voted in favour (one entry each).
    pub yes_voters: Vec<Address>,
    /// Members who voted against (one entry each).
    pub no_voters: Vec<Address>,
    pub created_at: u64,
    /// Set once `group_execute` has settled this proposal (whether it passed
    /// or not), so it can never be executed twice.
    pub executed: bool,
    /// Outcome recorded by `group_execute`: true if the yes votes exceeded
    /// half of all members at execution time.
    pub passed: bool,
}

/// How often accrued interest is compounded on an [`InterestAccount`].
///
/// Each variant maps to a fixed period length ([`Self::period_seconds`]);
/// interest compounds once per whole elapsed period. The frequency is set
/// admin-wide via `interest_set_frequency`. See [`crate::interest`].
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum CompoundFrequency {
    Daily,
    Weekly,
    Monthly,
    Quarterly,
    Annually,
}

impl CompoundFrequency {
    /// Length of one compounding period, in seconds.
    pub fn period_seconds(&self) -> u64 {
        match self {
            CompoundFrequency::Daily => 86_400,
            CompoundFrequency::Weekly => 604_800,
            CompoundFrequency::Monthly => 2_592_000,
            CompoundFrequency::Quarterly => 7_776_000,
            CompoundFrequency::Annually => 31_536_000,
        }
    }

    /// Nominal number of compounding periods in a year. Used to derive the
    /// per-period rate from the annual rate (`annual_bps / periods_per_year`).
    pub fn periods_per_year(&self) -> u32 {
        match self {
            CompoundFrequency::Daily => 365,
            CompoundFrequency::Weekly => 52,
            CompoundFrequency::Monthly => 12,
            CompoundFrequency::Quarterly => 4,
            CompoundFrequency::Annually => 1,
        }
    }
}

/// An interest-bearing savings account. Its balance grows by compound
/// interest at the admin-configured annual rate and compounding frequency.
///
/// Interest is **lazy**: it is never written per period. Instead it is
/// derived on demand from `principal`, `last_compound_at`, and the account's
/// `rate_bps` / `frequency` snapshot, and only folded into `principal`
/// (compounding it) when the owner calls `interest_claim`, or on the next
/// deposit/withdraw. This keeps accrual gas-cheap regardless of how much
/// time has elapsed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InterestAccount {
    pub owner: Address,
    /// Compounded principal: deposits plus interest credited so far.
    pub principal: i128,
    /// Timestamp from which the next *uncredited* period accrues. Advances by
    /// whole periods only, so partial-period time is carried forward rather
    /// than discarded.
    pub last_compound_at: u64,
    /// Annual interest-rate snapshot, in basis points, captured when the
    /// account was last touched. Accrual uses this snapshot so a later admin
    /// rate change never re-prices time that has already accrued.
    pub rate_bps: u32,
    /// Compounding-frequency snapshot, captured alongside `rate_bps`.
    pub frequency: CompoundFrequency,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A pending upgrade proposal with a timelock delay.
#[contracttype]
#[derive(Clone)]
pub struct UpgradeProposal {
    pub new_wasm_hash: BytesN<32>,
    pub proposed_by: Address,
    pub proposed_at: u64,
    pub execute_after: u64,
}

/// Snapshot of the state before the most recent `execute_upgrade`, kept in
/// instance storage under `DataKey::PreviousVersion` to enable a one-step
/// rollback via `rollback_upgrade`.
///
/// Cleared by `rollback_upgrade` so only a single rollback level is
/// supported per upgrade cycle. After rollback, a fresh `propose_upgrade` →
/// `execute_upgrade` sequence must be used for further changes.
#[contracttype]
#[derive(Clone)]
pub struct PreviousVersionSnapshot {
    /// The Wasm hash that was installed as part of the upgrade we may roll
    /// back from. Used to re-install the Wasm on rollback.
    pub wasm_hash: BytesN<32>,
    /// The version number before the upgrade (i.e. what `Version` will be
    /// restored to on rollback).
    pub version: u32,
}

/// An approved insurance claim that a user can redeem.
#[contracttype]
#[derive(Clone)]
pub struct InsuranceClaimRecord {
    pub claimant: Address,
    pub amount: i128,
    pub approved_at: u64,
    pub redeemed: bool,
}

/// Permission level granted to a delegate for savings management.
///
/// Variants are ordered by capability: `ViewOnly < Deposit < Full`, so a
/// derived `Ord` comparison ("does this level include that level?") matches
/// the intuitive hierarchy. See [`crate::delegation`].
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum PermissionLevel {
    /// Read-only access to the owner's savings accounts.
    ViewOnly,
    /// Can deposit into the owner's flexible account on the owner's behalf.
    /// Withdrawals are not permitted.
    Deposit,
    /// Full management: deposit and withdraw. Withdrawals are always sent to
    /// the **owner's** wallet, never the delegate's.
    Full,
}

/// A savings delegation: an owner authorizes a delegate to manage savings on
/// their behalf at a given [`PermissionLevel`], optionally expiring at a
/// ledger timestamp.
///
/// See [`crate::delegation`] for the full lifecycle (grant, update, revoke,
/// and delegated deposit/withdraw).
#[contracttype]
#[derive(Clone)]
pub struct Delegation {
    /// The savings owner who granted this delegation.
    pub owner: Address,
    /// The authorized delegate address.
    pub delegate: Address,
    /// What the delegate is allowed to do.
    pub level: PermissionLevel,
    /// Ledger timestamp after which the delegation is no longer valid.
    /// `None` means the delegation never expires on its own.
    pub expires_at: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// The set of admin actions that must pass through the timelock.
///
/// Each variant carries exactly the parameters that the underlying admin
/// function needs, so `execute_action` can apply it without any extra
/// context. `set_paused` is intentionally not timelocked: an emergency pause
/// must take effect immediately.
#[contracttype]
#[derive(Clone)]
pub enum TimelockAction {
    /// Rotate the admin key. Equivalent to `set_admin(new_admin)`.
    SetAdmin(Address),
    /// Swap the contract Wasm. Equivalent to `upgrade(new_wasm_hash)`.
    Upgrade(BytesN<32>),
    /// Change the per-account deposit cap (in stroops). `0` = unlimited.
    SetDepositCap(i128),
    /// Change the minimum deposit (in stroops). `0` = no minimum.
    SetMinDeposit(i128),
    /// Change the early-withdrawal penalty, in basis points.
    SetEarlyWithdrawPenaltyBps(u32),
    /// Change the address that receives early-withdrawal penalties.
    SetPenaltyRecipient(Address),
    /// Change the minimum lock period before early withdrawal, in seconds.
    SetMinLockPeriod(u64),
    /// Change the annual interest rate, in basis points.
    SetInterestRate(u32),
    /// Change the compounding frequency for interest accounts.
    SetInterestFrequency(CompoundFrequency),
    /// Change the timelock delay itself, in seconds.
    SetTimelockDelay(u64),
}

/// Lifecycle state of a queued action.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ActionStatus {
    /// Waiting to reach the ETA (or already past it but not yet executed).
    Pending,
    /// Successfully applied by `execute_action`.
    Executed,
    /// Cancelled by the admin before execution.
    Cancelled,
}

/// A pending (or completed) timelock entry.
///
/// Stored under [`DataKey::QueuedAction(id)`] in persistent storage.
#[contracttype]
#[derive(Clone)]
pub struct QueuedAction {
    /// Unique monotonic id allocated by [`DataKey::NextTimelockId`].
    pub id: u64,
    /// The action payload to apply at execution time.
    pub action: TimelockAction,
    /// Ledger timestamp before which `execute_action` is rejected
    /// (`Error::TimelockNotReady`).
    pub eta: u64,
    /// Ledger timestamp after which `execute_action` is rejected
    /// (`Error::TimelockExpired`).
    pub expires_at: u64,
    /// Current lifecycle state.
    pub status: ActionStatus,
    /// Ledger timestamp when this entry was queued.
    pub queued_at: u64,
}

/// What a challenge participant must achieve by the deadline to win a prize.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ChallengeKind {
    /// Total amount saved (stroops) must reach `target_amount`.
    TotalSaved,
    /// Number of separate deposits must reach `target_amount`.
    Consistency,
    /// Amount saved, in basis points of the entry stake, must reach `target_amount`.
    GrowthRate,
}

/// Lifecycle state of a [`Challenge`].
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ChallengeStatus {
    /// Accepting joins and savings until the deadline.
    Open,
    /// Every participant has settled; no funds remain to be claimed.
    Closed,
}

/// One participant's record inside a [`Challenge`].
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ChallengeParticipant {
    pub address: Address,
    /// Total stroops saved toward the challenge target so far.
    pub saved: i128,
    /// Number of separate `save` calls made by this participant.
    pub deposits: u32,
    /// Entry stake paid when joining (always `== challenge.entry_fee`).
    pub fee_paid: i128,
    /// Set once the participant has called `settle`.
    pub settled: bool,
}

/// A savings challenge with an entry stake, a target and a deadline.
///
/// Stored under [`DataKey::Challenge(id)`] in persistent storage.
#[contracttype]
#[derive(Clone)]
pub struct Challenge {
    pub id: u64,
    pub creator: Address,
    pub kind: ChallengeKind,
    /// Success threshold; its unit depends on `kind` (see [`ChallengeKind`]).
    pub target_amount: i128,
    /// Stroops each participant stakes to join.
    pub entry_fee: i128,
    /// Ledger timestamp after which joins and saves stop and settlement opens.
    pub deadline: u64,
    /// Minimum participants required before any prize is paid out.
    pub min_participants: u32,
    /// Protocol fee rate, in basis points, snapshotted at creation. Each
    /// participant's fee funds the prize pool.
    pub fee_bps: u32,
    pub status: ChallengeStatus,
    pub participants: Vec<ChallengeParticipant>,
    pub created_at: u64,
}

/// Rounding granularity for automatic savings round-ups (#622).
///
/// Each external transaction is rounded up to the next multiple of this step;
/// the difference is saved.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RoundupLevel {
    /// Round to the nearest 1 unit: nothing is saved.
    Nearest1,
    /// Round up to the next multiple of 5.
    Nearest5,
    /// Round up to the next multiple of 10.
    Nearest10,
}

/// An owner's round-up configuration and running totals.
///
/// Stored under [`DataKey::Roundup(owner)`] in persistent storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RoundupConfig {
    pub owner: Address,
    pub level: RoundupLevel,
    /// Whether round-ups are currently on. Disabled configs keep their totals.
    pub enabled: bool,
    /// Sum of all external transaction amounts tracked so far, in stroops.
    pub tracked_total: i128,
    /// Sum of all round-up amounts deposited so far, in stroops.
    pub deposited_total: i128,
    /// Sum of round-up amounts skipped because the owner's token balance
    /// could not cover them, in stroops.
    pub skipped_total: i128,
}

// ---------------------------------------------------------------------------
// Loan collateral (#645)
// ---------------------------------------------------------------------------

/// Per-vault collateral state, stored under `DataKey::CollateralState(owner)`.
///
/// `max_borrow = balance * borrow_ratio_bps / 10_000` (rounded down).
/// Liquidation allowed when `borrowed * 10_000 > balance * liquidation_ratio_bps`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CollateralState {
    pub owner: Address,
    /// Whether this vault is currently enabled as collateral.
    pub enabled: bool,
    /// The loan id this vault is backing. `0` means not currently backing any loan.
    pub loan_id: u64,
    /// Amount currently borrowed against this vault, in token stroops.
    pub borrowed: i128,
    /// Collateral borrow ratio in basis points (e.g. 8_000 = 80 %).
    pub borrow_ratio_bps: u32,
    /// Liquidation threshold in basis points (e.g. 9_000 = 90 %).
    pub liquidation_ratio_bps: u32,
}

/// A loan record, stored under `DataKey::LoanRecord(loan_id)`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LoanRecord {
    pub loan_id: u64,
    /// The registered lender that created this loan.
    pub lender: Address,
    /// Total amount borrowed against all vaults backing this loan.
    pub total_borrowed: i128,
    /// Owner addresses of the vaults backing this loan.
    pub vaults: Vec<Address>,
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// Inheritance (#439)
// ---------------------------------------------------------------------------

/// A single beneficiary in an inheritance plan, with their share.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Beneficiary {
    /// Address that will receive funds when the inheritance is claimed.
    pub address: Address,
    /// Share of the balance in basis points. All shares must sum to `10_000`.
    pub share_bps: u32,
}

/// An inheritance plan for a flexible savings account.
/// Stored under `DataKey::Inheritance(owner)`.
#[contracttype]
#[derive(Clone)]
pub struct InheritancePlan {
    pub owner: Address,
    /// Ordered list of beneficiaries. Shares must sum to `10_000` bps.
    pub beneficiaries: Vec<Beneficiary>,
    /// Seconds of inactivity before beneficiaries may claim. `0` disables inheritance.
    pub inactivity_timeout: u64,
    /// Ledger timestamp of the owner's most recent deposit or withdrawal.
    pub last_active_at: u64,
}

// ---------------------------------------------------------------------------
// Tiered interest rates (#619)
// ---------------------------------------------------------------------------

/// Admin-configurable tiered interest-rate parameters, in basis points.
/// Stored under `DataKey::TieredRateConfig` in instance storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TieredRateConfig {
    /// Annual rate for balances strictly below 1 000 token units.
    pub tier_low_rate_bps: u32,
    /// Annual rate for balances at or above 1 000 and below 10 000 token units.
    pub tier_mid_rate_bps: u32,
    /// Annual rate for balances at or above 10 000 token units.
    pub tier_high_rate_bps: u32,
    /// Additional bps for lock periods >= 3 months but < 6 months.
    pub lock_3mo_bonus_bps: u32,
    /// Additional bps for lock periods >= 6 months but < 12 months.
    pub lock_6mo_bonus_bps: u32,
    /// Additional bps for lock periods >= 12 months.
    pub lock_12mo_bonus_bps: u32,
}

/// Storage keys. One variant per logical record family.
///
/// See `storage` module docs for the full storage model: durability
/// (instance vs. persistent), TTL policy, and cost implications per key.
/// Every variant below is documented with its durability + TTL at a glance;
/// treat the `storage` module doc as the canonical source if the two ever
/// disagree.
#[contracttype(export = false)]
#[derive(Clone)]
pub enum DataKey {
    /// Global config / initialization guard.
    ///
    /// Durability: instance. TTL: bumped on every state-changing call via
    /// `extend_instance_ttl`. Currently unused as a standalone key — kept
    /// reserved for future config fields that don't warrant their own key.
    Config,
    /// The SEP-41 token (e.g. USDC) this vault holds.
    ///
    /// Durability: instance (one value, read on almost every entrypoint —
    /// instance storage is cheapest for hot, small, singleton data). TTL:
    /// bumped alongside the rest of instance storage; never expires as long
    /// as *any* mutation happens within the bump window.
    Token,
    /// Contract admin.
    ///
    /// Durability: instance, for the same reason as `Token`. TTL: same as
    /// `Token`.
    Admin,
    /// Emergency-pause flag. Absent/false means unpaused.
    Paused,
    /// Admin-configured per-account deposit cap, in token stroops. Absent
    /// (or `0`) means unlimited. See [`crate::admin::deposit_cap`].
    ///
    /// Durability: instance — a single scalar read on every `deposit`. TTL:
    /// bumped alongside the rest of instance storage.
    DepositCap,
    /// Admin-configured minimum deposit amount, in token stroops. Absent
    /// (or `0`) means no minimum. See [`crate::admin::min_deposit`].
    ///
    /// Durability: instance — a single scalar read on every `deposit`. TTL:
    /// bumped alongside the rest of instance storage.
    MinDeposit,
    /// Monotonic counters for plan/goal/group ids.
    ///
    /// Durability: instance — small, hot counters incremented on every
    /// `create`. TTL: bumped alongside the rest of instance storage.
    NextLockedId,
    NextGoalId,
    NextGroupId,
    /// `FlexibleAccount` by owner.
    ///
    /// Durability: persistent — one entry per user, unbounded key space, not
    /// appropriate for instance storage. TTL: **not currently bumped** by
    /// per-entry logic; relies on being re-written (which refreshes TTL) on
    /// every deposit/withdraw. An account that goes untouched for longer
    /// than the persistent minimum TTL could be archived; restoring it
    /// requires `extend_ttl`/`restore` before the next read. See the
    /// `storage` module doc for the tracked follow-up.
    Flexible(Address),
    /// `LockedPlan` by id.
    ///
    /// Durability: persistent — unbounded key space (one per plan).
    /// TTL: refreshed implicitly on `top_up`/`withdraw` writes; the same
    /// archival caveat as `Flexible` applies to long-dormant plans.
    Locked(u64),
    /// Goal by id.
    ///
    /// Durability: persistent, for the same reason as `Locked`. TTL: same
    /// caveat — refreshed only when written.
    Goal(u64),
    /// Group by id.
    ///
    /// Durability: persistent. TTL: same caveat as above.
    ///
    /// Cost note: a `Group` record embeds the *entire* `members: Vec<Address>`
    /// and `shares_bps: Map<Address, u32>` in one entry. Every `join`,
    /// `contribute`, or `set_shares` call reads and rewrites the whole
    /// entry, so write cost (and the rent needed to keep its TTL alive)
    /// grows linearly with membership size. There is currently no cap on
    /// group size — very large groups pay progressively more per mutation
    /// and are more expensive to keep alive.
    Group(u64),
    /// Admin-configured penalty charged on an early locked withdrawal, in
    /// basis points (1/100 of a percent) of the withdrawn amount. Absent (or
    /// `0`) means no penalty. See [`crate::admin::early_withdraw_penalty_bps`].
    ///
    /// Durability: instance — read on every `locked_early_withdraw`. TTL:
    /// bumped alongside the rest of instance storage.
    ///
    /// Appended after the id-keyed variants on purpose: `DataKey` is encoded
    /// by variant order, so new keys are added at the end to avoid shifting
    /// the case index of existing stored keys.
    EarlyWithdrawPenaltyBps,
    /// Address that receives early-withdrawal penalties. Absent means the
    /// penalty is paid to the current admin. See
    /// [`crate::admin::penalty_recipient`].
    ///
    /// Durability: instance — read on every `locked_early_withdraw`. TTL:
    /// bumped alongside the rest of instance storage.
    PenaltyRecipient,
    /// Minimum time, in seconds, a locked plan must have been locked before a
    /// penalized early withdrawal is allowed. Absent (or `0`) means no
    /// minimum. See [`crate::admin::min_lock_period`].
    ///
    /// Durability: instance — read on every `locked_early_withdraw`. TTL:
    /// bumped alongside the rest of instance storage.
    MinLockPeriod,
    /// `Proposal` by id.
    ///
    /// Durability: persistent — one entry per proposal. TTL: bumped on every
    /// read/write via `extend_persistent_ttl`.
    Proposal(u64),
    /// Monotonic counter for proposal ids.
    ///
    /// Durability: instance — small, hot counter incremented on every
    /// `group_propose`. TTL: bumped alongside the rest of instance storage.
    NextProposalId,
    /// `InterestAccount` by owner.
    ///
    /// Durability: persistent — one entry per owner. TTL: bumped on every
    /// read/write via `extend_persistent_ttl`.
    InterestAccount(Address),
    /// Admin-configured annual interest rate, in basis points. Absent (or
    /// `0`) means no interest accrues. See [`crate::interest::set_rate`].
    ///
    /// Durability: instance — read on every interest accrual. TTL: bumped
    /// alongside the rest of instance storage.
    InterestRateBps,
    /// Admin-configured compounding frequency applied to new/touched
    /// interest accounts. Absent defaults to
    /// [`CompoundFrequency::Annually`]. See [`crate::interest::set_frequency`].
    ///
    /// Durability: instance. TTL: same as `InterestRateBps`.
    InterestFrequency,
    /// Per-contributor amounts for a shared savings goal.
    GoalContributions(u64),
    /// Ledger sequence of the most recent contribution to a goal.
    GoalLastContributionLedger(u64),
    /// Set while an external token transfer is in progress (reentrancy guard).
    TokenTransferActive,

    // --- Emergency pause (#428) ---
    /// Emergency mode flag. When active, only withdrawals are permitted.
    EmergencyMode,

    // --- Contract upgrade pattern (#429) ---
    /// Current contract version number.
    Version,
    /// Pending upgrade proposal: stores `UpgradeProposal`.
    PendingUpgrade,
    /// Minimum delay (in seconds) before a proposed upgrade can execute.
    UpgradeDelay,
    /// Rollback snapshot: stores `PreviousVersionSnapshot`. Written by
    /// `execute_upgrade`, cleared by `rollback_upgrade`.
    ///
    /// Durability: instance — single small record, same lifecycle as
    /// `PendingUpgrade`. Absent when no rollback is available.
    PreviousVersion,

    // --- Insurance fund (#435) ---
    /// Insurance fund pool balance.
    InsuranceFundBalance,
    /// Insurance premium rate in basis points, collected on deposits.
    InsurancePremiumBps,
    /// Maximum claimable amount per user from the insurance fund.
    InsuranceMaxClaimBps,
    /// Approved insurance claim by user address.
    InsuranceClaim(Address),

    // --- Group contribution limits (#579) ---
    /// `GroupLimits` for a group id. Absent means no limits.
    ///
    /// Durability: persistent — one entry per group. TTL: bumped on every
    /// read/write via `extend_persistent_ttl`.
    GroupLimits(u64),
    /// Cumulative amount a member has contributed to a group, keyed by
    /// `(group_id, member)`.
    ///
    /// Durability: persistent — kept out of the `Group` record so
    /// contributing does not grow it. TTL: bumped on every read/write.
    GroupContribution(u64, Address),

    /// Reward state by owner.
    RewardState(Address),
    /// Reward pool balance, in stroops.
    RewardPoolBalance,
    /// Admin-configured rewards parameters.
    RewardsConfig,
    /// Fee rate in basis points.
    FeeBps,
    /// Address that receives protocol fees.
    FeeRecipient,
    /// Delegation by (owner, delegate).
    Delegation(Address, Address),
    /// Admin-configured timelock delay, in seconds.
    TimelockDelay,
    /// Monotonic counter for queued-action ids.
    NextTimelockId,
    /// Queued timelock action by id.
    QueuedAction(u64),
    /// Savings challenge by id.
    Challenge(u64),
    /// Monotonic counter for challenge ids.
    NextChallengeId,

    /// Savings round-up configuration and totals by owner.
    Roundup(Address),
    /// A recurring deposit schedule keyed by its owner.
    ///
    /// Durability: persistent — one entry per owner. TTL is refreshed on
    /// setup, query, execution, and cancellation.
    RecurringDeposit(Address),
    /// Pending multi-signature group withdrawal by request id.
    GroupWithdrawal(u64),
    /// Monotonic counter for multi-signature group withdrawal request ids.
    NextGroupWithdrawalId,

    // --- Locked rollover (#638) ---
    /// `RolloverConfig` for a locked plan id. Absent means no auto-rollover.
    ///
    /// Durability: persistent — one entry per plan. TTL: bumped on every
    /// read/write via `extend_persistent_ttl`.
    Rollover(u64),

    // --- Conditional withdrawals (#639) ---
    /// Admin-configured price oracle used by price-based conditions.
    ///
    /// Durability: instance. TTL: bumped alongside the rest of instance storage.
    PriceOracle,
    /// Pending `ConditionalWithdrawalRule` for a flexible account owner.
    ///
    /// Durability: persistent — one entry per owner. TTL: bumped on every
    /// read/write via `extend_persistent_ttl`.
    WithdrawalCondition(Address),

    // --- Inheritance planning (#635) ---
    /// `InheritancePlan` for an owner. Absent means no plan.
    ///
    /// Durability: persistent — one entry per owner. TTL: bumped on every
    /// read/write via `extend_persistent_ttl`.
    Inheritance(Address),
}
