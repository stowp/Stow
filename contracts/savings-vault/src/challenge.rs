//! Savings challenges (issues #442 and #623).
//!
//! A challenge is a fixed-length competition. Each participant stakes
//! `entry_fee` to join and then saves toward a goal set by the challenge's
//! [`ChallengeKind`]. After the deadline every participant calls [`settle`]
//! once to collect their payout.
//!
//! # Lifecycle
//!
//! 1. **Create** — [`create`] opens a challenge. The creator's stake is the
//!    first participant record. Emits `challenge/created`.
//! 2. **Join** — [`join`] stakes `entry_fee`. Open until the deadline. Emits
//!    `challenge/joined`.
//! 3. **Save** — [`save`] deposits toward the participant's goal. Emits
//!    `challenge/saved`.
//! 4. **Settle** — after the deadline each participant calls [`settle`] once.
//!    Emits `challenge/settled`, and `challenge/closed` when the last one
//!    settles.
//!
//! # Payouts
//!
//! Each participant pays a fee of `stake * fee_bps / 10_000` (`fee_bps` is the
//! protocol rate snapshotted at creation). The fees form the prize pool.
//! Successful participants share the pool equally; everyone gets back their
//! stake minus their own fee, plus their savings. Savings are always returned
//! in full. If no participant succeeds, or fewer than `min_participants`
//! joined, nothing is taken: every participant gets their stake and savings
//! back.
//!
//! # Storage
//!
//! - Each challenge is stored under [`DataKey::Challenge(id)`] in persistent
//!   storage.
//! - A monotonic `NextChallengeId` counter in instance storage allocates ids.

use soroban_sdk::{symbol_short, Address, Env};

use crate::error::Error;
use crate::storage::{extend_instance_ttl, extend_persistent_ttl, transfer_in, transfer_out};
use crate::types::{Challenge, ChallengeKind, ChallengeParticipant, ChallengeStatus, DataKey};

const BPS_DENOMINATOR: i128 = 10_000;

// ── Internal helpers ───────────────────────────────────────────────────────

fn load_challenge(env: &Env, challenge_id: u64) -> Result<Challenge, Error> {
    let key = DataKey::Challenge(challenge_id);
    let c = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &key);
    Ok(c)
}

fn save_challenge(env: &Env, challenge: &Challenge) {
    let key = DataKey::Challenge(challenge.id);
    env.storage().persistent().set(&key, challenge);
    extend_persistent_ttl(env, &key);
}

fn find_participant_index(c: &Challenge, addr: &Address) -> Option<u32> {
    for (i, p) in (0_u32..).zip(c.participants.iter()) {
        if p.address == *addr {
            return Some(i);
        }
    }
    None
}

/// Whether `p` meets the challenge goal for its kind.
fn is_successful(c: &Challenge, p: &ChallengeParticipant) -> Result<bool, Error> {
    Ok(match c.kind {
        ChallengeKind::TotalSaved => p.saved >= c.target_amount,
        ChallengeKind::Consistency => i128::from(p.deposits) >= c.target_amount,
        ChallengeKind::GrowthRate => {
            // saved / stake >= target / 10_000, cross-multiplied to stay integral.
            let lhs = p
                .saved
                .checked_mul(BPS_DENOMINATOR)
                .ok_or(Error::Overflow)?;
            let rhs = c
                .target_amount
                .checked_mul(p.fee_paid)
                .ok_or(Error::Overflow)?;
            lhs >= rhs
        }
    })
}

/// Fee rate, prize pool and winner count for a challenge that has reached its
/// deadline. The rate is zero, and there are no winners, unless prizes are
/// active (enough participants joined and at least one succeeded).
struct Terms {
    fee_bps: u32,
    pool: i128,
    winners: u32,
}

fn settlement_terms(c: &Challenge) -> Result<Terms, Error> {
    let mut winners: u32 = 0;
    for p in c.participants.iter() {
        if is_successful(c, &p)? {
            winners += 1;
        }
    }
    if winners == 0 || c.participants.len() < c.min_participants {
        return Ok(Terms {
            fee_bps: 0,
            pool: 0,
            winners: 0,
        });
    }

    let mut pool: i128 = 0;
    for p in c.participants.iter() {
        let fee = fee_on(p.fee_paid, c.fee_bps)?;
        pool = pool.checked_add(fee).ok_or(Error::Overflow)?;
    }
    Ok(Terms {
        fee_bps: c.fee_bps,
        pool,
        winners,
    })
}

fn fee_on(amount: i128, bps: u32) -> Result<i128, Error> {
    amount
        .checked_mul(i128::from(bps))
        .ok_or(Error::Overflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(Error::DivisionByZero)
}

// ── Public entrypoints ─────────────────────────────────────────────────────

/// Create a new savings challenge. The creator stakes `entry_fee` and becomes
/// the first participant.
///
/// # Arguments
/// * `kind`             — How success is measured; see [`ChallengeKind`].
/// * `target_amount`    — Goal for `kind`: stroops saved, number of deposits,
///   or growth in basis points of the stake.
/// * `entry_fee`        — Stroops each participant stakes to join.
/// * `deadline`         — Ledger timestamp after which joins and saves stop.
/// * `min_participants` — Joined participants required before prizes are paid.
///   Must be >= 2.
///
/// Returns the new challenge id.
///
/// # Errors
/// - [`Error::InvalidAmount`]     if `target_amount` or `entry_fee` is not positive.
/// - [`Error::InvalidTimestamp`]  if `deadline <= now`.
/// - [`Error::InvalidParameters`] if `min_participants < 2`, or a consistency
///   target does not fit in `u32`.
pub fn create(
    env: &Env,
    creator: Address,
    kind: ChallengeKind,
    target_amount: i128,
    entry_fee: i128,
    deadline: u64,
    min_participants: u32,
) -> Result<u64, Error> {
    crate::admin::require_not_paused(env)?;
    extend_instance_ttl(env);
    creator.require_auth();

    if target_amount <= 0 || entry_fee <= 0 {
        return Err(Error::InvalidAmount);
    }
    if kind == ChallengeKind::Consistency && target_amount > i128::from(u32::MAX) {
        return Err(Error::InvalidParameters);
    }
    let now = env.ledger().timestamp();
    if deadline <= now {
        return Err(Error::InvalidTimestamp);
    }
    if min_participants < 2 {
        return Err(Error::InvalidParameters);
    }

    transfer_in(env, &creator, entry_fee)?;

    let id = crate::storage::next_id(env, DataKey::NextChallengeId);
    let mut participants = soroban_sdk::Vec::new(env);
    participants.push_back(ChallengeParticipant {
        address: creator.clone(),
        saved: 0,
        deposits: 0,
        fee_paid: entry_fee,
        settled: false,
    });

    let challenge = Challenge {
        id,
        creator: creator.clone(),
        kind,
        target_amount,
        entry_fee,
        deadline,
        min_participants,
        fee_bps: crate::fees::fee_bps(env),
        status: ChallengeStatus::Open,
        participants,
        created_at: now,
    };
    save_challenge(env, &challenge);

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("created")),
        (id, creator, target_amount, entry_fee, deadline),
    );
    Ok(id)
}

/// Join an open challenge by staking `entry_fee`.
///
/// # Errors
/// - [`Error::NotFound`]          if the challenge does not exist.
/// - [`Error::GroupClosed`]       if the challenge is closed.
/// - [`Error::OperationExpired`]  if the deadline has passed.
/// - [`Error::MemberAlreadyExists`] if the caller already joined.
pub fn join(env: &Env, participant: Address, challenge_id: u64) -> Result<(), Error> {
    crate::admin::require_not_paused(env)?;
    extend_instance_ttl(env);
    participant.require_auth();

    let mut challenge = load_challenge(env, challenge_id)?;
    if challenge.status != ChallengeStatus::Open {
        return Err(Error::GroupClosed);
    }
    if env.ledger().timestamp() >= challenge.deadline {
        return Err(Error::OperationExpired);
    }
    if find_participant_index(&challenge, &participant).is_some() {
        return Err(Error::MemberAlreadyExists);
    }

    transfer_in(env, &participant, challenge.entry_fee)?;
    challenge.participants.push_back(ChallengeParticipant {
        address: participant.clone(),
        saved: 0,
        deposits: 0,
        fee_paid: challenge.entry_fee,
        settled: false,
    });
    save_challenge(env, &challenge);

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("joined")),
        (challenge_id, participant),
    );
    Ok(())
}

/// Deposit savings toward the caller's goal in a challenge.
///
/// # Errors
/// - [`Error::InvalidAmount`]    if `amount` is not positive.
/// - [`Error::NotFound`]         if the challenge does not exist.
/// - [`Error::GroupClosed`]      if the challenge is closed.
/// - [`Error::OperationExpired`] if the deadline has passed.
/// - [`Error::NotAMember`]       if the caller has not joined.
pub fn save(env: &Env, participant: Address, challenge_id: u64, amount: i128) -> Result<(), Error> {
    crate::admin::require_not_paused(env)?;
    extend_instance_ttl(env);
    participant.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let mut challenge = load_challenge(env, challenge_id)?;
    if challenge.status != ChallengeStatus::Open {
        return Err(Error::GroupClosed);
    }
    if env.ledger().timestamp() >= challenge.deadline {
        return Err(Error::OperationExpired);
    }
    let idx = find_participant_index(&challenge, &participant).ok_or(Error::NotAMember)?;

    transfer_in(env, &participant, amount)?;

    let mut p = challenge.participants.get(idx).ok_or(Error::NotFound)?;
    p.saved = p.saved.checked_add(amount).ok_or(Error::Overflow)?;
    p.deposits = p.deposits.checked_add(1).ok_or(Error::Overflow)?;
    challenge.participants.set(idx, p);
    save_challenge(env, &challenge);

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("saved")),
        (challenge_id, participant, amount),
    );
    Ok(())
}

/// Settle the caller's position after the deadline and pay out.
///
/// Returns the amount paid out. Each participant can settle once. The last
/// settlement closes the challenge.
///
/// # Errors
/// - [`Error::NotFound`]         if the challenge does not exist.
/// - [`Error::GroupClosed`]      if the caller has already settled.
/// - [`Error::TimeWindowNotOpen`] if the deadline has not passed yet.
/// - [`Error::NotAMember`]       if the caller did not join.
pub fn settle(env: &Env, participant: Address, challenge_id: u64) -> Result<i128, Error> {
    crate::admin::require_not_paused(env)?;
    extend_instance_ttl(env);
    participant.require_auth();

    let mut challenge = load_challenge(env, challenge_id)?;
    if challenge.status != ChallengeStatus::Open {
        return Err(Error::GroupClosed);
    }
    if env.ledger().timestamp() < challenge.deadline {
        return Err(Error::TimeWindowNotOpen);
    }
    let idx = find_participant_index(&challenge, &participant).ok_or(Error::NotAMember)?;
    let mut p = challenge.participants.get(idx).ok_or(Error::NotFound)?;
    if p.settled {
        return Err(Error::GroupClosed);
    }

    let terms = settlement_terms(&challenge)?;
    let own_fee = fee_on(p.fee_paid, terms.fee_bps)?;
    let mut payout = p
        .fee_paid
        .checked_sub(own_fee)
        .ok_or(Error::Overflow)?
        .checked_add(p.saved)
        .ok_or(Error::Overflow)?;
    if is_successful(&challenge, &p)? && terms.winners > 0 {
        let share = terms
            .pool
            .checked_div(i128::from(terms.winners))
            .ok_or(Error::DivisionByZero)?;
        payout = payout.checked_add(share).ok_or(Error::Overflow)?;
    }

    p.settled = true;
    challenge.participants.set(idx, p);
    if challenge.participants.iter().all(|q| q.settled) {
        challenge.status = ChallengeStatus::Closed;
    }
    save_challenge(env, &challenge);

    if payout > 0 {
        transfer_out(env, &participant, payout)?;
    }

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("settled")),
        (challenge_id, participant, payout),
    );
    if challenge.status == ChallengeStatus::Closed {
        env.events().publish(
            (symbol_short!("challenge"), symbol_short!("closed")),
            (challenge_id,),
        );
    }
    Ok(payout)
}

/// Read a challenge by id.
pub fn get_challenge(env: &Env, challenge_id: u64) -> Result<Challenge, Error> {
    load_challenge(env, challenge_id)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token, Env};

    use crate::test::register_vault;

    const DAY: u64 = 86_400;

    fn advance(env: &Env, seconds: u64) {
        env.ledger().with_mut(|l| l.timestamp += seconds);
    }

    fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
        token::StellarAssetClient::new(env, token).mint(to, &amount);
    }

    fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
        token::Client::new(env, token).balance(who)
    }

    #[test]
    fn create_returns_id_and_stakes_creator() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 100_000);

        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::TotalSaved,
            &50_000i128,
            &10_000i128,
            &(1_000 + DAY),
            &2u32,
        );
        assert_eq!(id, 1);
        assert_eq!(balance(&env, &token, &creator), 90_000);

        let c = vault.get_challenge(&id);
        assert_eq!(c.participants.len(), 1);
        assert_eq!(c.status, ChallengeStatus::Open);
    }

    #[test]
    fn create_rejects_invalid_parameters() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 100_000);

        // Non-positive target and fee.
        assert_eq!(
            vault.try_create_challenge(
                &creator,
                &ChallengeKind::TotalSaved,
                &0i128,
                &10_000i128,
                &(1_000 + DAY),
                &2u32
            ),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            vault.try_create_challenge(
                &creator,
                &ChallengeKind::TotalSaved,
                &50_000i128,
                &0i128,
                &(1_000 + DAY),
                &2u32
            ),
            Err(Ok(Error::InvalidAmount))
        );
        // Deadline in the past.
        assert_eq!(
            vault.try_create_challenge(
                &creator,
                &ChallengeKind::TotalSaved,
                &50_000i128,
                &10_000i128,
                &999u64,
                &2u32
            ),
            Err(Ok(Error::InvalidTimestamp))
        );
        // Fewer than two participants.
        assert_eq!(
            vault.try_create_challenge(
                &creator,
                &ChallengeKind::TotalSaved,
                &50_000i128,
                &10_000i128,
                &(1_000 + DAY),
                &1u32
            ),
            Err(Ok(Error::InvalidParameters))
        );
    }

    #[test]
    fn join_rejects_duplicates_and_late_joins() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let late = Address::generate(&env);
        mint(&env, &token, &creator, 100_000);
        mint(&env, &token, &late, 100_000);

        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::TotalSaved,
            &50_000i128,
            &10_000i128,
            &(1_000 + DAY),
            &2u32,
        );
        assert_eq!(
            vault.try_join_challenge(&creator, &id),
            Err(Ok(Error::MemberAlreadyExists))
        );

        advance(&env, DAY + 1);
        assert_eq!(
            vault.try_join_challenge(&late, &id),
            Err(Ok(Error::OperationExpired))
        );
    }

    #[test]
    fn save_tracks_progress_and_deposit_count() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 200_000);

        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::TotalSaved,
            &50_000i128,
            &10_000i128,
            &(1_000 + DAY),
            &2u32,
        );
        vault.save_challenge(&creator, &id, &20_000i128);
        vault.save_challenge(&creator, &id, &5_000i128);

        let p = vault.get_challenge(&id).participants.get(0).unwrap();
        assert_eq!(p.saved, 25_000);
        assert_eq!(p.deposits, 2);
    }

    #[test]
    fn total_saved_winners_share_prize_and_losers_get_stake_minus_fee() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let loser = Address::generate(&env);
        let winner2 = Address::generate(&env);
        for who in [&creator, &loser, &winner2] {
            mint(&env, &token, who, 200_000);
        }
        vault.set_fee_bps(&1_000u32); // 10%

        let (stake, target) = (10_000i128, 50_000i128);
        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::TotalSaved,
            &target,
            &stake,
            &(1_000 + DAY),
            &2u32,
        );
        vault.join_challenge(&loser, &id);
        vault.join_challenge(&winner2, &id);
        vault.save_challenge(&creator, &id, &target);
        vault.save_challenge(&winner2, &id, &target);
        vault.save_challenge(&loser, &id, &1_000i128);

        advance(&env, DAY + 1);
        // Fee pool: 3 * 10% of 10_000 = 3_000; two winners get 1_500 each.
        let creator_before = balance(&env, &token, &creator);
        let paid = vault.settle_challenge(&creator, &id);
        // Stake minus fee (9_000) + saved (50_000) + share (1_500).
        assert_eq!(paid, 60_500);
        assert_eq!(balance(&env, &token, &creator) - creator_before, 60_500);

        assert_eq!(vault.settle_challenge(&loser, &id), 9_000 + 1_000);
        assert_eq!(
            vault.settle_challenge(&winner2, &id),
            9_000 + 50_000 + 1_500
        );
        assert_eq!(vault.get_challenge(&id).status, ChallengeStatus::Closed);
    }

    #[test]
    fn consistency_counts_deposits_not_amount() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let other = Address::generate(&env);
        mint(&env, &token, &creator, 200_000);
        mint(&env, &token, &other, 200_000);

        // Goal: three separate deposits, whatever their size.
        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::Consistency,
            &3i128,
            &10_000i128,
            &(1_000 + DAY),
            &2u32,
        );
        vault.join_challenge(&other, &id);
        vault.save_challenge(&creator, &id, &1_000i128);
        vault.save_challenge(&creator, &id, &1_000i128);
        vault.save_challenge(&creator, &id, &1_000i128);
        vault.save_challenge(&other, &id, &90_000i128);

        advance(&env, DAY + 1);
        // Creator meets the goal (three deposits); the other participant does not.
        assert_eq!(vault.settle_challenge(&creator, &id), 10_000 + 3_000);
        assert_eq!(vault.settle_challenge(&other, &id), 10_000 + 90_000);
    }

    #[test]
    fn growth_rate_compares_savings_to_stake() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let other = Address::generate(&env);
        mint(&env, &token, &creator, 200_000);
        mint(&env, &token, &other, 200_000);

        // Goal: saved amount is at least 150% of the stake (15_000 bps).
        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::GrowthRate,
            &15_000i128,
            &10_000i128,
            &(1_000 + DAY),
            &2u32,
        );
        vault.join_challenge(&other, &id);
        vault.save_challenge(&creator, &id, &5_000i128); // 50% growth: fails
        vault.save_challenge(&other, &id, &5_000i128);
        vault.save_challenge(&other, &id, &10_000i128); // 150% growth: passes

        advance(&env, DAY + 1);
        let winner_paid = vault.settle_challenge(&other, &id);
        let loser_paid = vault.settle_challenge(&creator, &id);
        // No fee is set, so the loser gets stake + saved back and the winner
        // gets the same back (there is no prize pool when fee_bps is zero).
        assert_eq!(loser_paid, 10_000 + 5_000);
        assert_eq!(winner_paid, 10_000 + 15_000);
    }

    #[test]
    fn no_winner_refunds_everyone_in_full() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let other = Address::generate(&env);
        mint(&env, &token, &creator, 200_000);
        mint(&env, &token, &other, 200_000);
        vault.set_fee_bps(&1_000u32);

        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::TotalSaved,
            &50_000i128,
            &10_000i128,
            &(1_000 + DAY),
            &2u32,
        );
        vault.join_challenge(&other, &id);
        vault.save_challenge(&creator, &id, &1_000i128);

        advance(&env, DAY + 1);
        assert_eq!(vault.settle_challenge(&creator, &id), 10_000 + 1_000);
        assert_eq!(vault.settle_challenge(&other, &id), 10_000);
    }

    #[test]
    fn min_participants_not_met_refunds_in_full() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 200_000);
        vault.set_fee_bps(&1_000u32);

        // Three required, but only the creator joins.
        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::TotalSaved,
            &50_000i128,
            &10_000i128,
            &(1_000 + DAY),
            &3u32,
        );
        vault.save_challenge(&creator, &id, &50_000i128);

        advance(&env, DAY + 1);
        assert_eq!(vault.settle_challenge(&creator, &id), 10_000 + 50_000);
    }

    #[test]
    fn settle_before_deadline_and_twice_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let other = Address::generate(&env);
        mint(&env, &token, &creator, 200_000);
        mint(&env, &token, &other, 200_000);

        let id = vault.create_challenge(
            &creator,
            &ChallengeKind::TotalSaved,
            &50_000i128,
            &10_000i128,
            &(1_000 + DAY),
            &2u32,
        );
        vault.join_challenge(&other, &id);

        assert_eq!(
            vault.try_settle_challenge(&creator, &id),
            Err(Ok(Error::TimeWindowNotOpen))
        );

        advance(&env, DAY + 1);
        vault.settle_challenge(&creator, &id);
        assert_eq!(
            vault.try_settle_challenge(&creator, &id),
            Err(Ok(Error::GroupClosed))
        );
        assert_eq!(vault.get_challenge(&id).status, ChallengeStatus::Open);
    }
}
