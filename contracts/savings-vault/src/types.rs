use soroban_sdk::{contracttype, Address, Map, String, Vec};

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
#[derive(Clone)]
pub struct Goal {
    pub id: u64,
    pub owner: Address,
    pub name: String,
    pub target_amount: i128,
    pub saved_amount: i128,
    pub created_at: u64,
    /// Set when `saved_amount >= target_amount`.
    pub reached_at: Option<u64>,
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
}
