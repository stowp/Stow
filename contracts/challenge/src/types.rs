//! Types, error codes and storage keys for the challenge contract.

use soroban_sdk::{contracterror, contracttype, Address};

/// Contract error codes.
///
/// Keep these stable and append-only — clients and the indexer map to them.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// An amount was zero or negative.
    InvalidAmount = 1,
    /// A challenge parameter is out of range (see [`ChallengeConfig`]).
    InvalidParameters = 2,
    /// The deadline is not in the future.
    InvalidTimestamp = 3,
    /// The challenge or participant does not exist.
    NotFound = 4,
    /// The address has already joined this challenge.
    AlreadyJoined = 5,
    /// The address has not joined this challenge.
    NotAParticipant = 6,
    /// The challenge has reached `max_participants`.
    ChallengeFull = 7,
    /// The deadline has passed: joins and deposits are closed.
    ChallengeEnded = 8,
    /// The deadline has not passed yet: settlement is not open.
    ChallengeNotEnded = 9,
    /// The participant has already been settled.
    AlreadySettled = 10,
    /// An arithmetic operation overflowed.
    Overflow = 11,
}

/// How a participant's success is measured. The unit of
/// [`ChallengeConfig::target`] depends on the kind.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ChallengeKind {
    /// Total amount saved, in stroops, must reach `target`.
    TotalSaved,
    /// Number of distinct periods (of `period` seconds, counted from the
    /// challenge start) with at least one deposit must reach `target`.
    Consistency,
    /// Growth of savings over the participant's first deposit, in basis
    /// points, must reach `target`. `10_000` means the participant at least
    /// doubled their opening deposit.
    GrowthRate,
}

/// Lifecycle state of a [`Challenge`].
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ChallengeStatus {
    /// Accepting joins and deposits until the deadline. Settlement opens once
    /// the deadline passes.
    Open,
    /// The deadline has passed and the outcome is fixed (winners and prize
    /// pool). Participants are being settled.
    Settling,
    /// Every participant has been settled; no funds remain.
    Closed,
}

/// Parameters for [`crate::ChallengeContract::create_challenge`].
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ChallengeConfig {
    /// SEP-41 token used for stakes and savings.
    pub token: Address,
    pub kind: ChallengeKind,
    /// Success threshold; its unit depends on `kind`.
    pub target: i128,
    /// Stake, in stroops, each participant pays to join.
    pub entry_fee: i128,
    /// Share of an unsuccessful participant's stake, in basis points
    /// (`0..=10_000`), that goes to the prize pool.
    pub penalty_bps: u32,
    /// Ledger timestamp after which joins and deposits stop and settlement
    /// opens.
    pub deadline: u64,
    /// Period length in seconds for [`ChallengeKind::Consistency`]. Ignored
    /// by the other kinds.
    pub period: u64,
    /// Participants required for prizes to be paid. With fewer, everyone is
    /// refunded in full.
    pub min_participants: u32,
    /// Upper bound on participants (at most [`crate::MAX_PARTICIPANTS`]).
    pub max_participants: u32,
}

/// A savings challenge.
///
/// Stored under [`DataKey::Challenge`] in persistent storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Challenge {
    pub id: u64,
    pub creator: Address,
    pub config: ChallengeConfig,
    pub status: ChallengeStatus,
    /// Ledger timestamp at creation; consistency periods count from here.
    pub start: u64,
    pub participant_count: u32,
    /// Successful participants. Set when the outcome is fixed; zero when the
    /// challenge refunds everyone.
    pub winners: u32,
    /// Sum of the penalties taken from unsuccessful participants. Set when
    /// the outcome is fixed.
    pub prize_pool: i128,
    /// Prize money already paid out to settled winners.
    pub prize_paid: i128,
    pub winners_settled: u32,
    pub settled_count: u32,
}

/// One participant's progress in a challenge.
///
/// Stored under [`DataKey::Participant`] in persistent storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Participant {
    pub address: Address,
    /// Stake paid on joining (the challenge's `entry_fee`).
    pub stake: i128,
    /// Total stroops saved in the challenge.
    pub saved: i128,
    /// Number of deposits made.
    pub deposits: u32,
    /// Amount of the first deposit; the baseline for
    /// [`ChallengeKind::GrowthRate`].
    pub first_deposit: i128,
    /// Distinct periods with at least one deposit (for
    /// [`ChallengeKind::Consistency`]).
    pub active_periods: u32,
    /// Index of the last period with a deposit.
    pub last_period: u64,
    pub joined_at: u64,
    pub settled: bool,
    /// Amount paid out on settlement.
    pub payout: i128,
}

/// Storage keys.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Monotonic challenge id counter (instance storage).
    NextChallengeId,
    /// [`Challenge`] by id (persistent).
    Challenge(u64),
    /// Addresses that joined a challenge, in join order (persistent).
    Participants(u64),
    /// [`Participant`] by challenge id and address (persistent).
    Participant(u64, Address),
}
