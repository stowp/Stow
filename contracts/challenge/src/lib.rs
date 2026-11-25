#![no_std]
//! # Stow Savings Challenges
//!
//! A standalone contract for savings challenges with an entry stake, a goal
//! and a deadline.
//!
//! # Lifecycle
//!
//! 1. **Create** — [`ChallengeContract::create_challenge`] opens a challenge
//!    with a [`ChallengeConfig`]. Emits `(challenge, created)`.
//! 2. **Join** — [`ChallengeContract::join`] pays the entry stake. Open until
//!    the deadline. Emits `(challenge, joined)`.
//! 3. **Save** — [`ChallengeContract::deposit`] saves toward the goal and
//!    updates the participant's progress. Emits `(challenge, progress)`.
//! 4. **Settle** — after the deadline, [`ChallengeContract::settle`] pays out
//!    one participant. The first settlement fixes the outcome and emits
//!    `(challenge, final)`. Each settlement emits `(challenge, settled)`, and
//!    the last one emits `(challenge, closed)`.
//!
//! # Payouts
//!
//! Savings are always returned in full. An unsuccessful participant gets
//! their stake back minus `penalty_bps` of it. The penalties form the prize
//! pool, which successful participants share equally on top of their full
//! stake; the last winner to settle also receives any rounding remainder, so
//! the pool is paid out exactly.
//!
//! If nobody succeeds, or fewer than `min_participants` joined, no penalty is
//! taken and everyone gets their stake and savings back.

mod types;

#[cfg(test)]
#[path = "test/challenge_test.rs"]
mod challenge_test;

use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, Vec};

pub use crate::types::{
    Challenge, ChallengeConfig, ChallengeKind, ChallengeStatus, DataKey, Error, Participant,
};

/// Most participants a single challenge can hold. Settlement walks the
/// participant list once, so this keeps it within resource limits.
pub const MAX_PARTICIPANTS: u32 = 100;

const BPS_DENOMINATOR: i128 = 10_000;

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;
const PERSISTENT_BUMP_AMOUNT: u32 = 90 * DAY_IN_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = PERSISTENT_BUMP_AMOUNT - DAY_IN_LEDGERS;

#[contract]
pub struct ChallengeContract;

#[contractimpl]
impl ChallengeContract {
    /// Create a challenge. The creator does not join automatically.
    ///
    /// Returns the new challenge id (ids start at 1).
    ///
    /// # Errors
    /// - [`Error::InvalidAmount`]     if `entry_fee` or `target` is not positive.
    /// - [`Error::InvalidTimestamp`]  if `deadline` is not in the future.
    /// - [`Error::InvalidParameters`] if `penalty_bps > 10_000`,
    ///   `min_participants` is zero, `max_participants` is below
    ///   `min_participants` or above [`MAX_PARTICIPANTS`], or a consistency
    ///   challenge has a zero `period` or a target that cannot be reached
    ///   before the deadline.
    pub fn create_challenge(
        env: Env,
        creator: Address,
        config: ChallengeConfig,
    ) -> Result<u64, Error> {
        creator.require_auth();
        extend_instance_ttl(&env);

        if config.entry_fee <= 0 || config.target <= 0 {
            return Err(Error::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if config.deadline <= now {
            return Err(Error::InvalidTimestamp);
        }
        if i128::from(config.penalty_bps) > BPS_DENOMINATOR
            || config.min_participants == 0
            || config.max_participants < config.min_participants
            || config.max_participants > MAX_PARTICIPANTS
        {
            return Err(Error::InvalidParameters);
        }
        if config.kind == ChallengeKind::Consistency {
            if config.period == 0 {
                return Err(Error::InvalidParameters);
            }
            // Periods touched by [now, deadline): a target above this can
            // never be met.
            let reachable = (config.deadline - now - 1) / config.period + 1;
            if config.target > i128::from(reachable) {
                return Err(Error::InvalidParameters);
            }
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextChallengeId)
            .unwrap_or(0u64)
            + 1;
        env.storage().instance().set(&DataKey::NextChallengeId, &id);

        let challenge = Challenge {
            id,
            creator: creator.clone(),
            config: config.clone(),
            status: ChallengeStatus::Open,
            start: now,
            participant_count: 0,
            winners: 0,
            prize_pool: 0,
            prize_paid: 0,
            winners_settled: 0,
            settled_count: 0,
        };
        save_challenge(&env, &challenge);
        save_participants(&env, id, &Vec::new(&env));

        env.events().publish(
            (symbol_short!("challenge"), symbol_short!("created")),
            (
                id,
                creator,
                config.kind,
                config.target,
                config.entry_fee,
                config.deadline,
            ),
        );
        Ok(id)
    }

    /// Join a challenge by paying its entry stake.
    ///
    /// # Errors
    /// - [`Error::NotFound`]       if the challenge does not exist.
    /// - [`Error::ChallengeEnded`] if the deadline has passed.
    /// - [`Error::AlreadyJoined`]  if `participant` already joined.
    /// - [`Error::ChallengeFull`]  if `max_participants` is reached.
    pub fn join(env: Env, participant: Address, challenge_id: u64) -> Result<(), Error> {
        participant.require_auth();
        extend_instance_ttl(&env);

        let mut challenge = load_challenge(&env, challenge_id)?;
        let now = env.ledger().timestamp();
        if challenge.status != ChallengeStatus::Open || now >= challenge.config.deadline {
            return Err(Error::ChallengeEnded);
        }
        if load_participant(&env, challenge_id, participant.clone()).is_some() {
            return Err(Error::AlreadyJoined);
        }
        if challenge.participant_count >= challenge.config.max_participants {
            return Err(Error::ChallengeFull);
        }

        let stake = challenge.config.entry_fee;
        token::Client::new(&env, &challenge.config.token).transfer(
            &participant,
            &env.current_contract_address(),
            &stake,
        );

        save_participant(
            &env,
            challenge_id,
            &Participant {
                address: participant.clone(),
                stake,
                saved: 0,
                deposits: 0,
                first_deposit: 0,
                active_periods: 0,
                last_period: 0,
                joined_at: now,
                settled: false,
                payout: 0,
            },
        );
        let mut list = load_participants(&env, challenge_id)?;
        list.push_back(participant.clone());
        save_participants(&env, challenge_id, &list);

        challenge.participant_count += 1;
        save_challenge(&env, &challenge);

        env.events().publish(
            (symbol_short!("challenge"), symbol_short!("joined")),
            (challenge_id, participant, stake),
        );
        Ok(())
    }

    /// Save `amount` toward the participant's goal.
    ///
    /// # Errors
    /// - [`Error::InvalidAmount`]   if `amount` is not positive.
    /// - [`Error::NotFound`]        if the challenge does not exist.
    /// - [`Error::ChallengeEnded`]  if the deadline has passed.
    /// - [`Error::NotAParticipant`] if `participant` has not joined.
    pub fn deposit(
        env: Env,
        participant: Address,
        challenge_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        participant.require_auth();
        extend_instance_ttl(&env);

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let challenge = load_challenge(&env, challenge_id)?;
        let now = env.ledger().timestamp();
        if challenge.status != ChallengeStatus::Open || now >= challenge.config.deadline {
            return Err(Error::ChallengeEnded);
        }
        let mut p = load_participant(&env, challenge_id, participant.clone())
            .ok_or(Error::NotAParticipant)?;

        token::Client::new(&env, &challenge.config.token).transfer(
            &participant,
            &env.current_contract_address(),
            &amount,
        );

        if p.deposits == 0 {
            p.first_deposit = amount;
        }
        if challenge.config.period > 0 {
            let period = (now - challenge.start) / challenge.config.period;
            if p.deposits == 0 || period != p.last_period {
                p.active_periods = p.active_periods.checked_add(1).ok_or(Error::Overflow)?;
                p.last_period = period;
            }
        }
        p.saved = p.saved.checked_add(amount).ok_or(Error::Overflow)?;
        p.deposits = p.deposits.checked_add(1).ok_or(Error::Overflow)?;
        save_participant(&env, challenge_id, &p);

        env.events().publish(
            (symbol_short!("challenge"), symbol_short!("progress")),
            (challenge_id, participant, amount, p.saved, p.deposits),
        );
        Ok(())
    }

    /// Settle one participant after the deadline and pay them out. Anyone can
    /// call this; funds only ever go to the participant.
    ///
    /// Returns the amount paid.
    ///
    /// # Errors
    /// - [`Error::NotFound`]          if the challenge does not exist.
    /// - [`Error::ChallengeNotEnded`] if the deadline has not passed.
    /// - [`Error::NotAParticipant`]   if `participant` did not join.
    /// - [`Error::AlreadySettled`]    if `participant` was already settled.
    pub fn settle(env: Env, challenge_id: u64, participant: Address) -> Result<i128, Error> {
        extend_instance_ttl(&env);

        let mut challenge = load_challenge(&env, challenge_id)?;
        if env.ledger().timestamp() < challenge.config.deadline {
            return Err(Error::ChallengeNotEnded);
        }
        let mut p = load_participant(&env, challenge_id, participant.clone())
            .ok_or(Error::NotAParticipant)?;
        if p.settled {
            return Err(Error::AlreadySettled);
        }

        if challenge.status == ChallengeStatus::Open {
            finalize(&env, &mut challenge)?;
        }

        let base = p.stake.checked_add(p.saved).ok_or(Error::Overflow)?;
        let won = challenge.winners > 0 && is_successful(&challenge.config, &p)?;
        let payout = if challenge.winners == 0 {
            base
        } else if won {
            challenge.winners_settled += 1;
            let prize = if challenge.winners_settled == challenge.winners {
                challenge.prize_pool - challenge.prize_paid
            } else {
                challenge.prize_pool / i128::from(challenge.winners)
            };
            challenge.prize_paid = challenge
                .prize_paid
                .checked_add(prize)
                .ok_or(Error::Overflow)?;
            base.checked_add(prize).ok_or(Error::Overflow)?
        } else {
            base.checked_sub(penalty(&challenge.config, p.stake)?)
                .ok_or(Error::Overflow)?
        };

        p.settled = true;
        p.payout = payout;
        save_participant(&env, challenge_id, &p);
        challenge.settled_count += 1;
        if challenge.settled_count == challenge.participant_count {
            challenge.status = ChallengeStatus::Closed;
        }
        save_challenge(&env, &challenge);

        if payout > 0 {
            token::Client::new(&env, &challenge.config.token).transfer(
                &env.current_contract_address(),
                &participant,
                &payout,
            );
        }

        env.events().publish(
            (symbol_short!("challenge"), symbol_short!("settled")),
            (challenge_id, participant, won, payout),
        );
        if challenge.status == ChallengeStatus::Closed {
            env.events().publish(
                (symbol_short!("challenge"), symbol_short!("closed")),
                (challenge_id, challenge.prize_pool),
            );
        }
        Ok(payout)
    }

    /// Read a challenge.
    pub fn get_challenge(env: Env, challenge_id: u64) -> Result<Challenge, Error> {
        load_challenge(&env, challenge_id)
    }

    /// Read a participant's progress.
    pub fn get_participant(
        env: Env,
        challenge_id: u64,
        participant: Address,
    ) -> Result<Participant, Error> {
        load_challenge(&env, challenge_id)?;
        load_participant(&env, challenge_id, participant).ok_or(Error::NotAParticipant)
    }

    /// Addresses that joined, in join order.
    pub fn get_participants(env: Env, challenge_id: u64) -> Result<Vec<Address>, Error> {
        load_participants(&env, challenge_id)
    }

    /// Whether the participant currently meets the challenge goal.
    pub fn is_on_track(env: Env, challenge_id: u64, participant: Address) -> Result<bool, Error> {
        let challenge = load_challenge(&env, challenge_id)?;
        let p = load_participant(&env, challenge_id, participant).ok_or(Error::NotAParticipant)?;
        is_successful(&challenge.config, &p)
    }
}

// ── Internal helpers ───────────────────────────────────────────────────────

/// Whether `p` meets the goal for the challenge's kind.
fn is_successful(config: &ChallengeConfig, p: &Participant) -> Result<bool, Error> {
    Ok(match config.kind {
        ChallengeKind::TotalSaved => p.saved >= config.target,
        ChallengeKind::Consistency => i128::from(p.active_periods) >= config.target,
        ChallengeKind::GrowthRate => {
            if p.first_deposit <= 0 {
                return Ok(false);
            }
            // (saved - first) / first >= target / 10_000, cross-multiplied.
            let growth = p.saved - p.first_deposit;
            let lhs = growth
                .checked_mul(BPS_DENOMINATOR)
                .ok_or(Error::Overflow)?;
            let rhs = config
                .target
                .checked_mul(p.first_deposit)
                .ok_or(Error::Overflow)?;
            lhs >= rhs
        }
    })
}

fn penalty(config: &ChallengeConfig, stake: i128) -> Result<i128, Error> {
    Ok(stake
        .checked_mul(i128::from(config.penalty_bps))
        .ok_or(Error::Overflow)?
        / BPS_DENOMINATOR)
}

/// Fix the outcome once the deadline has passed: count winners and build the
/// prize pool from the losers' penalties. With no winner, or fewer than
/// `min_participants`, nobody pays a penalty.
fn finalize(env: &Env, challenge: &mut Challenge) -> Result<(), Error> {
    let list = load_participants(env, challenge.id)?;

    let mut winners: u32 = 0;
    let mut pool: i128 = 0;
    for address in list.iter() {
        let p = load_participant(env, challenge.id, address).ok_or(Error::NotFound)?;
        if is_successful(&challenge.config, &p)? {
            winners += 1;
        } else {
            pool = pool
                .checked_add(penalty(&challenge.config, p.stake)?)
                .ok_or(Error::Overflow)?;
        }
    }
    if winners == 0 || challenge.participant_count < challenge.config.min_participants {
        winners = 0;
        pool = 0;
    }

    challenge.winners = winners;
    challenge.prize_pool = pool;
    challenge.status = ChallengeStatus::Settling;

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("final")),
        (challenge.id, winners, pool),
    );
    Ok(())
}

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
}

fn load_participant(env: &Env, challenge_id: u64, address: Address) -> Option<Participant> {
    let key = DataKey::Participant(challenge_id, address);
    let value = env.storage().persistent().get(&key);
    if value.is_some() {
        bump(env, &key);
    }
    value
}

fn save_participant(env: &Env, challenge_id: u64, participant: &Participant) {
    let key = DataKey::Participant(challenge_id, participant.address.clone());
    env.storage().persistent().set(&key, participant);
    bump(env, &key);
}

fn load_participants(env: &Env, challenge_id: u64) -> Result<Vec<Address>, Error> {
    let key = DataKey::Participants(challenge_id);
    let list = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    bump(env, &key);
    Ok(list)
}

fn save_participants(env: &Env, challenge_id: u64, list: &Vec<Address>) {
    let key = DataKey::Participants(challenge_id);
    env.storage().persistent().set(&key, list);
    bump(env, &key);
}

fn load_challenge(env: &Env, challenge_id: u64) -> Result<Challenge, Error> {
    let key = DataKey::Challenge(challenge_id);
    let challenge = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    bump(env, &key);
    Ok(challenge)
}

fn save_challenge(env: &Env, challenge: &Challenge) {
    let key = DataKey::Challenge(challenge.id);
    env.storage().persistent().set(&key, challenge);
    bump(env, &key);
}
