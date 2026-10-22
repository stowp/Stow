use soroban_sdk::contracterror;

/// Contract-wide error codes.
///
/// Keep these stable and append-only — clients and the indexer map to them.
/// Max 50 variants total (XDR `SCSpecUDTErrorEnumV0.cases<50>` limit).
///
/// Error codes are organized by category for maintainability:
/// - 1-9: Lifecycle and initialization
/// - 10-19: Authentication and authorization
/// - 20-29: Generic validation
/// - 30-39: Locked savings
/// - 40-49: Goal savings
/// - 50-59: Group savings
/// - 60-69: Arithmetic and limits
/// - 70-79: Admin lifecycle
/// - 80-89: Policy limits
/// - 90-99: Time-based operations
/// - 110-119: Storage & State
/// - 120-129: Rewards
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // --- Lifecycle (1-9) ---
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract must be initialized before this call.
    NotInitialized = 2,

    // --- Authentication & Authorization (10-19) ---
    /// Caller is not authorized for this action.
    Unauthorized = 10,

    // --- Generic Validation (20-29) ---
    /// A provided amount was zero or negative.
    InvalidAmount = 20,
    /// The referenced account/plan/goal/group does not exist.
    NotFound = 21,
    /// The caller has insufficient balance for the requested withdrawal.
    InsufficientBalance = 22,
    /// Invalid parameter combination provided.
    InvalidParameters = 25,

    // --- Locked Savings (30-39) ---
    /// Funds are still locked; unlock time has not been reached.
    StillLocked = 30,
    /// The provided unlock time is in the past.
    InvalidUnlockTime = 31,

    // --- Goal Savings (40-49) ---
    /// The goal target has not yet been reached.
    GoalNotReached = 40,

    // --- Group Savings (50-59) ---
    /// The group is full or the round is closed to new members.
    GroupClosed = 50,
    /// Member shares do not sum to the expected total (basis points).
    InvalidShares = 51,
    /// Caller is not a member of this group.
    NotAMember = 52,
    /// Group has insufficient funds for payout.
    InsufficientGroupFunds = 55,
    /// Member already exists in group.
    MemberAlreadyExists = 56,
    /// The caller has already voted on this proposal.
    AlreadyVoted = 57,
    /// The proposal has already been executed.
    ProposalAlreadyExecuted = 58,

    // --- Arithmetic & Limits (60-69) ---
    /// A monetary computation would have overflowed or underflowed `i128`.
    Overflow = 60,
    /// The admin-configured per-account deposit cap would be exceeded.
    DepositCapExceeded = 61,

    // --- Admin Lifecycle (70-79) ---
    /// The contract is paused; mutating entrypoints are rejected.
    Paused = 70,

    // --- Policy Limits (80-89) ---
    /// The deposit amount was below the admin-configured minimum deposit.
    DepositBelowMinimum = 80,

    // --- Time-based Operations (90-99) ---
    /// Operation has expired.
    OperationExpired = 92,
    /// Time window for operation has not opened yet.
    TimeWindowNotOpen = 93,

    // --- Storage & State (110-119) ---
    /// A goal cannot be claimed in the ledger where it was last funded.
    SameLedger = 114,
    /// A token callback attempted a nested token transfer.
    ReentrantCall = 115,

    // --- Rewards (120-129) ---
    /// The reward pool has insufficient funds; partial payment was made.
    RewardPoolShortfall = 120,
    /// Reward config values are invalid (e.g. tiers not sorted, bps > cap).
    InvalidRewardConfig = 121,
    /// No reward has accrued yet (nothing to claim).
    NoRewardAccrued = 122,
}
