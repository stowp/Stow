use soroban_sdk::contracterror;

/// Contract-wide error codes.
///
/// Keep these stable and append-only — clients and the indexer map to them.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // --- lifecycle ---
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract must be initialized before this call.
    NotInitialized = 2,

    // --- auth ---
    /// Caller is not authorized for this action.
    Unauthorized = 3,

    // --- generic validation ---
    /// A provided amount was zero or negative.
    InvalidAmount = 4,
    /// The referenced account/plan/goal/group does not exist.
    NotFound = 5,
    /// The caller has insufficient balance for the requested withdrawal.
    InsufficientBalance = 6,

    // --- locked savings ---
    /// Funds are still locked; unlock time has not been reached.
    StillLocked = 7,
    /// The provided unlock time is in the past.
    InvalidUnlockTime = 8,

    // --- goal savings ---
    /// The goal target has not yet been reached.
    GoalNotReached = 9,

    // --- group savings ---
    /// The group is full or the round is closed to new members.
    GroupClosed = 10,
    /// Member shares do not sum to the expected total (basis points).
    InvalidShares = 11,
    /// Caller is not a member of this group.
    NotAMember = 12,

    // --- arithmetic / limits ---
    /// A monetary computation would have overflowed or underflowed `i128`.
    Overflow = 13,
    /// The admin-configured per-account deposit cap would be exceeded.
    DepositCapExceeded = 14,

    // --- lifecycle (admin) ---
    /// The contract is paused; mutating entrypoints are rejected.
    Paused = 15,

    // --- policy limits ---
    /// The deposit amount was below the admin-configured minimum deposit.
    DepositBelowMinimum = 16,
}
