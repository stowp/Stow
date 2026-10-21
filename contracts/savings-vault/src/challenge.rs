//! Savings challenge contracts — issue #442.
//!
//! A savings challenge is a fixed-duration competition between two or more
//! participants who each commit to saving a target amount by a deadline.
//! The first participant to reach their target may claim the prize pool;
//! if nobody wins by the deadline the entrants' stakes are refunded.
//!
//! # Lifecycle
//!
//! 1. **Create** — [`create`] opens a challenge: caller sets the target
//!    amount, entry fee (both in token stroops), a deadline, and a
//!    minimum number of participants required before any winner can claim.
//! 2. **Join** — Any address calls [`join`] and pays the entry fee.
//!    Joining is open until `deadline`.
//! 3. **Save** — Participants call [`save`] to deposit toward their
//!    personal target.  Progress is tracked per-participant.
//! 4. **Verify & claim** — When a participant's `saved >= target`, they
//!    call [`claim_winner`].  The contract verifies the achievement on-chain
//!    and pays the entire prize pool (sum of all entry fees) to the winner.
//! 5. **Expired refund** — After the deadline, if no winner has claimed,
//!    any participant calls [`refund_expired`] to return all entry fees to
//!    their respective payers.  The prize pool is distributed in separate
//!    transfers, one per participant (pull-based to bound gas).
//!
//! # Storage
//!
//! - Each challenge is stored under [`DataKey::Challenge(id)`] in persistent
//!   storage.
//! - A monotonic `NextChallengeId` counter in instance storage allocates ids.

use soroban_sdk::{symbol_short, Address, Env};

use crate::error::Error;
use crate::storage::{
    extend_instance_ttl, extend_persistent_ttl, transfer_in, transfer_out,
};
use crate::types::{Challenge, ChallengeParticipant, ChallengeStatus, DataKey};

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

// ── Public entrypoints ─────────────────────────────────────────────────────

/// Create a new savings challenge.
///
/// # Arguments
/// * `creator`       — Must authorise; becomes the first participant automatically.
/// * `target_amount` — Stroops each participant must save to win.
/// * `entry_fee`     — Stroops each participant pays to join (forms the prize pool).
/// * `deadline`      — Ledger timestamp after which new joins are blocked and
///                     winners can no longer be claimed (expired state).
/// * `min_participants` — Minimum number of joined participants before a winner
///                        can be declared. Must be ≥ 2.
///
/// Returns the new challenge id.
///
/// # Errors
/// - [`Error::InvalidAmount`]     if `target_amount <= 0` or `entry_fee <= 0`.
/// - [`Error::InvalidTimestamp`]  if `deadline <= now`.
/// - [`Error::InvalidParameters`] if `min_participants < 2`.
pub fn create(
    env: &Env,
    creator: Address,
    target_amount: i128,
    entry_fee: i128,
    deadline: u64,
    min_participants: u32,
) -> Result<u64, Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    creator.require_auth();

    if target_amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if entry_fee <= 0 {
        return Err(Error::InvalidAmount);
    }
    let now = env.ledger().timestamp();
    if deadline <= now {
        return Err(Error::InvalidTimestamp);
    }
    if min_participants < 2 {
        return Err(Error::InvalidParameters);
    }

    // Collect entry fee from creator.
    transfer_in(env, &creator, entry_fee)?;

    let id = crate::storage::next_id(env, DataKey::NextChallengeId);

    let participants = {
        let mut v = soroban_sdk::Vec::new(env);
        v.push_back(ChallengeParticipant {
            address: creator.clone(),
            saved: 0,
            fee_paid: entry_fee,
        });
        v
    };

    let challenge = Challenge {
        id,
        creator: creator.clone(),
        target_amount,
        entry_fee,
        deadline,
        min_participants,
        prize_pool: entry_fee,
        status: ChallengeStatus::Open,
        winner: None,
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

/// Join an existing savings challenge and pay the entry fee.
///
/// # Errors
/// - [`Error::NotFound`]          if the challenge does not exist.
/// - [`Error::GroupClosed`]       if the challenge is not open (won or expired).
/// - [`Error::OperationExpired`]  if the deadline has passed.
/// - [`Error::MemberAlreadyExists`] if the caller is already a participant.
pub fn join(env: &Env, participant: Address, challenge_id: u64) -> Result<(), Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    participant.require_auth();

    let mut challenge = load_challenge(env, challenge_id)?;

    if challenge.status != ChallengeStatus::Open {
        return Err(Error::GroupClosed);
    }
    let now = env.ledger().timestamp();
    if now >= challenge.deadline {
        return Err(Error::OperationExpired);
    }

    // Reject duplicates.
    if find_participant_index(&challenge, &participant).is_some() {
        return Err(Error::MemberAlreadyExists);
    }

    transfer_in(env, &participant, challenge.entry_fee)?;

    challenge.prize_pool = challenge
        .prize_pool
        .checked_add(challenge.entry_fee)
        .ok_or(Error::Overflow)?;
    challenge.participants.push_back(ChallengeParticipant {
        address: participant.clone(),
        saved: 0,
        fee_paid: challenge.entry_fee,
    });

    save_challenge(env, &challenge);

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("joined")),
        (challenge_id, participant),
    );
    Ok(())
}

/// Deposit savings toward the caller's personal target in a challenge.
///
/// # Errors
/// - [`Error::NotFound`]         if the challenge or the caller's participation does not exist.
/// - [`Error::GroupClosed`]      if the challenge is not open.
/// - [`Error::OperationExpired`] if the deadline has passed.
pub fn save(
    env: &Env,
    participant: Address,
    challenge_id: u64,
    amount: i128,
) -> Result<(), Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    participant.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut challenge = load_challenge(env, challenge_id)?;

    if challenge.status != ChallengeStatus::Open {
        return Err(Error::GroupClosed);
    }
    let now = env.ledger().timestamp();
    if now >= challenge.deadline {
        return Err(Error::OperationExpired);
    }

    let idx = find_participant_index(&challenge, &participant)
        .ok_or(Error::NotAMember)?;

    transfer_in(env, &participant, amount)?;

    let mut p = challenge.participants.get(idx).unwrap();
    p.saved = p.saved.checked_add(amount).ok_or(Error::Overflow)?;
    challenge.participants.set(idx, p);

    save_challenge(env, &challenge);

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("saved")),
        (challenge_id, participant, amount),
    );
    Ok(())
}

/// Verify that the caller has reached the target and pay them the prize pool.
///
/// # Verification logic
/// The contract verifies on-chain that `participant.saved >= challenge.target_amount`
/// and that the minimum number of participants have joined.  If both conditions
/// are met the caller wins the entire prize pool and the challenge is closed.
///
/// # Errors
/// - [`Error::NotFound`]         if the challenge or participation does not exist.
/// - [`Error::GroupClosed`]      if the challenge has already been won or expired.
/// - [`Error::OperationExpired`] if the deadline has passed before claiming.
/// - [`Error::GoalNotReached`]   if the caller has not yet saved `target_amount`.
/// - [`Error::InvalidParameters`] if not enough participants have joined.
pub fn claim_winner(env: &Env, participant: Address, challenge_id: u64) -> Result<(), Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    participant.require_auth();

    let mut challenge = load_challenge(env, challenge_id)?;

    if challenge.status != ChallengeStatus::Open {
        return Err(Error::GroupClosed);
    }
    let now = env.ledger().timestamp();
    if now >= challenge.deadline {
        return Err(Error::OperationExpired);
    }

    // Minimum participants check.
    if challenge.participants.len() < challenge.min_participants {
        return Err(Error::InvalidParameters);
    }

    // Find participant and verify target.
    let idx = find_participant_index(&challenge, &participant)
        .ok_or(Error::NotAMember)?;
    let p = challenge.participants.get(idx).unwrap();
    if p.saved < challenge.target_amount {
        return Err(Error::GoalNotReached);
    }

    // Pay out the prize pool.
    let prize = challenge.prize_pool;
    transfer_out(env, &participant, prize)?;

    challenge.status = ChallengeStatus::Won;
    challenge.winner = Some(participant.clone());
    challenge.prize_pool = 0;
    save_challenge(env, &challenge);

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("won")),
        (challenge_id, participant, prize, now),
    );
    Ok(())
}

/// Refund all entry fees after the deadline has passed with no winner.
///
/// Permissionless — any address can trigger the refund after expiry.
/// Each participant's entry fee is returned to them individually.
/// Participants who saved more than their entry fee have their savings
/// held within the contract until they call a withdrawal.
///
/// # Errors
/// - [`Error::NotFound`]          if the challenge does not exist.
/// - [`Error::GroupClosed`]       if already won or already refunded.
/// - [`Error::TimeWindowNotOpen`] if the deadline has not yet passed.
pub fn refund_expired(env: &Env, caller: Address, challenge_id: u64) -> Result<(), Error> {
    crate::admin::ensure_not_paused(env)?;
    extend_instance_ttl(env);
    caller.require_auth();

    let mut challenge = load_challenge(env, challenge_id)?;

    if challenge.status != ChallengeStatus::Open {
        return Err(Error::GroupClosed);
    }
    let now = env.ledger().timestamp();
    if now < challenge.deadline {
        return Err(Error::TimeWindowNotOpen);
    }

    // Return each participant's entry fee + any savings deposited.
    for p in challenge.participants.iter() {
        let total_held = p.fee_paid.checked_add(p.saved).ok_or(Error::Overflow)?;
        if total_held > 0 {
            transfer_out(env, &p.address, total_held)?;
        }
    }

    challenge.status = ChallengeStatus::Expired;
    challenge.prize_pool = 0;
    save_challenge(env, &challenge);

    env.events().publish(
        (symbol_short!("challenge"), symbol_short!("expired")),
        (challenge_id, now),
    );
    Ok(())
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

    fn advance(env: &Env, seconds: u64) {
        env.ledger().with_mut(|l| l.timestamp += seconds);
    }

    fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
        let admin = Address::generate(env);
        token::StellarAssetClient::new(env, token).mint(to, &amount);
    }

    // ── challenge creation ────────────────────────────────────────────────────

    #[test]
    fn create_challenge_returns_id() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 100_000);

        let id = vault
            .create_challenge(&creator, &50_000i128, &10_000i128, &(1_000 + 86_400u64), &2u32)
            .unwrap();
        assert_eq!(id, 1);
    }

    #[test]
    fn create_challenge_invalid_deadline_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 100_000);

        // Deadline in the past.
        assert_eq!(
            vault.try_create_challenge(&creator, &50_000i128, &10_000i128, &999u64, &2u32),
            Err(Ok(Error::InvalidTimestamp))
        );
    }

    #[test]
    fn create_challenge_min_participants_below_2_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 100_000);

        assert_eq!(
            vault.try_create_challenge(&creator, &50_000i128, &10_000i128, &(1_000 + 86_400u64), &1u32),
            Err(Ok(Error::InvalidParameters))
        );
    }

    // ── join ─────────────────────────────────────────────────────────────────

    #[test]
    fn join_adds_participant() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let participant = Address::generate(&env);
        mint(&env, &token, &creator, 100_000);
        mint(&env, &token, &participant, 100_000);

        let id = vault
            .create_challenge(&creator, &50_000i128, &10_000i128, &(1_000 + 86_400u64), &2u32)
            .unwrap();
        vault.join_challenge(&participant, &id).unwrap();

        let c = vault.get_challenge(&id).unwrap();
        assert_eq!(c.participants.len(), 2);
        assert_eq!(c.prize_pool, 20_000);
    }

    #[test]
    fn join_duplicate_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 100_000);

        let id = vault
            .create_challenge(&creator, &50_000i128, &10_000i128, &(1_000 + 86_400u64), &2u32)
            .unwrap();

        // Creator tries to join again.
        assert_eq!(
            vault.try_join_challenge(&creator, &id),
            Err(Ok(Error::MemberAlreadyExists))
        );
    }

    #[test]
    fn join_after_deadline_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let p2 = Address::generate(&env);
        mint(&env, &token, &creator, 100_000);
        mint(&env, &token, &p2, 100_000);

        let deadline = 1_000 + 86_400u64;
        let id = vault
            .create_challenge(&creator, &50_000i128, &10_000i128, &deadline, &2u32)
            .unwrap();

        advance(&env, 86_401);

        assert_eq!(
            vault.try_join_challenge(&p2, &id),
            Err(Ok(Error::OperationExpired))
        );
    }

    // ── save & verify ─────────────────────────────────────────────────────────

    #[test]
    fn save_updates_participant_progress() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 200_000);

        let id = vault
            .create_challenge(&creator, &50_000i128, &10_000i128, &(1_000 + 86_400u64), &2u32)
            .unwrap();
        vault.save_challenge(&creator, &id, &30_000i128).unwrap();

        let c = vault.get_challenge(&id).unwrap();
        let p = c.participants.get(0).unwrap();
        assert_eq!(p.saved, 30_000);
    }

    #[test]
    fn claim_winner_pays_prize_pool() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let p2 = Address::generate(&env);
        mint(&env, &token, &creator, 200_000);
        mint(&env, &token, &p2, 200_000);

        let entry_fee = 10_000i128;
        let target = 50_000i128;
        let deadline = 1_000 + 86_400u64;

        let id = vault
            .create_challenge(&creator, &target, &entry_fee, &deadline, &2u32)
            .unwrap();
        vault.join_challenge(&p2, &id).unwrap();

        // Creator saves the full target.
        vault
            .save_challenge(&creator, &id, &target)
            .unwrap();

        let tok = token::Client::new(&env, &token);
        let before = tok.balance(&creator);
        vault.claim_winner(&creator, &id).unwrap();
        let after = tok.balance(&creator);

        // Won: entry_fee * 2 = 20_000.
        assert_eq!(after - before, 20_000);

        let c = vault.get_challenge(&id).unwrap();
        assert_eq!(c.status, ChallengeStatus::Won);
        assert_eq!(c.winner, Some(creator.clone()));
    }

    #[test]
    fn claim_winner_rejected_when_target_not_met() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let p2 = Address::generate(&env);
        mint(&env, &token, &creator, 200_000);
        mint(&env, &token, &p2, 200_000);

        let id = vault
            .create_challenge(&creator, &50_000i128, &10_000i128, &(1_000 + 86_400u64), &2u32)
            .unwrap();
        vault.join_challenge(&p2, &id).unwrap();

        // Only saved 30_000 of 50_000.
        vault.save_challenge(&creator, &id, &30_000i128).unwrap();

        assert_eq!(
            vault.try_claim_winner(&creator, &id),
            Err(Ok(Error::GoalNotReached))
        );
    }

    #[test]
    fn claim_winner_rejected_before_min_participants() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 200_000);

        // min_participants = 3 but only creator has joined.
        let id = vault
            .create_challenge(&creator, &50_000i128, &10_000i128, &(1_000 + 86_400u64), &3u32)
            .unwrap();
        vault.save_challenge(&creator, &id, &50_000i128).unwrap();

        assert_eq!(
            vault.try_claim_winner(&creator, &id),
            Err(Ok(Error::InvalidParameters))
        );
    }

    // ── expired refund ────────────────────────────────────────────────────────

    #[test]
    fn refund_expired_returns_fees_and_savings() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        let p2 = Address::generate(&env);
        mint(&env, &token, &creator, 200_000);
        mint(&env, &token, &p2, 200_000);

        let entry_fee = 10_000i128;
        let deadline = 1_000 + 86_400u64;

        let id = vault
            .create_challenge(&creator, &50_000i128, &entry_fee, &deadline, &2u32)
            .unwrap();
        vault.join_challenge(&p2, &id).unwrap();
        vault.save_challenge(&creator, &id, &20_000i128).unwrap();

        let tok = token::Client::new(&env, &token);
        let creator_before = tok.balance(&creator);
        let p2_before = tok.balance(&p2);

        // Advance past deadline.
        advance(&env, 86_401);
        vault.refund_expired(&creator, &id).unwrap();

        // Creator gets fee + 20_000 savings back.
        assert_eq!(tok.balance(&creator) - creator_before, entry_fee + 20_000);
        // p2 gets entry fee back.
        assert_eq!(tok.balance(&p2) - p2_before, entry_fee);

        let c = vault.get_challenge(&id).unwrap();
        assert_eq!(c.status, ChallengeStatus::Expired);
    }

    #[test]
    fn refund_before_deadline_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let (vault, token, creator) = register_vault(&env);
        mint(&env, &token, &creator, 100_000);

        let id = vault
            .create_challenge(&creator, &50_000i128, &10_000i128, &(1_000 + 86_400u64), &2u32)
            .unwrap();

        assert_eq!(
            vault.try_refund_expired(&creator, &id),
            Err(Ok(Error::TimeWindowNotOpen))
        );
    }
}
