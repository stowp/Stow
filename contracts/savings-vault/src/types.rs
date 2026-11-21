use soroban_sdk::{contracttype, Address, BytesN, Map, String, Vec};

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

/// An approved insurance claim that a user can redeem.
#[contracttype]
#[derive(Clone)]
pub struct InsuranceClaimRecord {
    pub claimant: Address,
    pub amount: i128,
    pub approved_at: u64,
    pub redeemed: bool,
}

/// Storage keys. One variant per logical record family.
///
/// See `storage` module docs for the full storage model: durability
/// (instance vs. persistent), TTL policy, and cost implications per key.
/// Every variant below is documented with its durability + TTL at a glance;
/// treat the `storage` module doc as the canonical source if the two ever
/// disagree.
#[contracttype]
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
    /// A recurring deposit schedule keyed by its owner.
    ///
    /// Durability: persistent — one entry per owner. TTL is refreshed on
    /// setup, query, execution, and cancellation.
    RecurringDeposit(Address),
    /// Pending multi-signature group withdrawal by request id.
    GroupWithdrawal(u64),
    /// Monotonic counter for multi-signature group withdrawal request ids.
    NextGroupWithdrawalId,
}
