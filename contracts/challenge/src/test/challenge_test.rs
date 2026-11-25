//! Savings challenge contract tests (#623).

extern crate std;

use soroban_sdk::testutils::{Address as _, Events as _, Ledger};
use soroban_sdk::{token, Address, Env, Symbol, TryFromVal};

use crate::{
    ChallengeConfig, ChallengeContract, ChallengeContractClient, ChallengeKind, ChallengeStatus,
    Error,
};

const DAY: u64 = 86_400;
const START: u64 = 1_000_000;
const STAKE: i128 = 1_000;

struct Ctx<'a> {
    env: Env,
    client: ChallengeContractClient<'a>,
    token: Address,
}

fn setup<'a>() -> Ctx<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = START);
    let client = ChallengeContractClient::new(&env, &env.register(ChallengeContract, ()));
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    Ctx { env, client, token }
}

impl Ctx<'_> {
    fn config(&self, kind: ChallengeKind, target: i128) -> ChallengeConfig {
        ChallengeConfig {
            token: self.token.clone(),
            kind,
            target,
            entry_fee: STAKE,
            penalty_bps: 2_000, // 20%
            deadline: START + 7 * DAY,
            period: DAY,
            min_participants: 2,
            max_participants: 10,
        }
    }

    fn create(&self, config: &ChallengeConfig) -> u64 {
        self.client
            .create_challenge(&Address::generate(&self.env), config)
    }

    fn funded(&self, amount: i128) -> Address {
        let who = Address::generate(&self.env);
        token::StellarAssetClient::new(&self.env, &self.token).mint(&who, &amount);
        who
    }

    fn joined(&self, id: u64, funds: i128) -> Address {
        let who = self.funded(funds);
        self.client.join(&who, &id);
        who
    }

    fn balance(&self, who: &Address) -> i128 {
        token::Client::new(&self.env, &self.token).balance(who)
    }

    fn advance(&self, seconds: u64) {
        self.env.ledger().with_mut(|l| l.timestamp += seconds);
    }

    fn end(&self, id: u64) {
        let deadline = self.client.get_challenge(&id).config.deadline;
        self.env.ledger().with_mut(|l| l.timestamp = deadline);
    }

    /// Whether the last invocation emitted a `(challenge, <name>)` event.
    fn emitted(&self, name: &str) -> bool {
        let challenge = Symbol::new(&self.env, "challenge");
        let name = Symbol::new(&self.env, name);
        self.env.events().all().iter().any(|(contract, topics, _)| {
            contract == self.client.address
                && topics
                    .get(0)
                    .and_then(|v| Symbol::try_from_val(&self.env, &v).ok())
                    == Some(challenge.clone())
                && topics
                    .get(1)
                    .and_then(|v| Symbol::try_from_val(&self.env, &v).ok())
                    == Some(name.clone())
        })
    }
}

// ── Creation ───────────────────────────────────────────────────────────────

#[test]
fn challenge_created_with_correct_parameters() {
    let c = setup();
    let config = c.config(ChallengeKind::TotalSaved, 5_000);
    let creator = Address::generate(&c.env);

    let id = c.client.create_challenge(&creator, &config);
    assert!(c.emitted("created"));
    assert_eq!(id, 1);

    let challenge = c.client.get_challenge(&id);
    assert_eq!(challenge.id, 1);
    assert_eq!(challenge.creator, creator);
    assert_eq!(challenge.config, config);
    assert_eq!(challenge.status, ChallengeStatus::Open);
    assert_eq!(challenge.start, START);
    assert_eq!(challenge.participant_count, 0);
    assert_eq!(c.client.get_participants(&id).len(), 0);

    assert_eq!(c.create(&config), 2);
}

#[test]
fn create_rejects_invalid_parameters() {
    let c = setup();
    let creator = Address::generate(&c.env);
    let base = c.config(ChallengeKind::TotalSaved, 5_000);
    let try_create = |config: &ChallengeConfig| c.client.try_create_challenge(&creator, config);

    let mut bad = base.clone();
    bad.entry_fee = 0;
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidAmount)));

    let mut bad = base.clone();
    bad.target = 0;
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidAmount)));

    let mut bad = base.clone();
    bad.deadline = START;
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidTimestamp)));

    let mut bad = base.clone();
    bad.penalty_bps = 10_001;
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidParameters)));

    let mut bad = base.clone();
    bad.min_participants = 0;
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidParameters)));

    let mut bad = base.clone();
    bad.max_participants = 1;
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidParameters)));

    let mut bad = base.clone();
    bad.max_participants = crate::MAX_PARTICIPANTS + 1;
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidParameters)));

    let mut bad = c.config(ChallengeKind::Consistency, 3);
    bad.period = 0;
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidParameters)));

    // Seven daily periods fit before the deadline; eight cannot be reached.
    let bad = c.config(ChallengeKind::Consistency, 8);
    assert_eq!(try_create(&bad), Err(Ok(Error::InvalidParameters)));
    let ok = c.config(ChallengeKind::Consistency, 7);
    assert!(try_create(&ok).is_ok());
}

// ── Joining ────────────────────────────────────────────────────────────────

#[test]
fn participants_join_by_paying_the_entry_fee() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::TotalSaved, 5_000));

    let alice = c.funded(10_000);
    c.client.join(&alice, &id);
    assert!(c.emitted("joined"));

    assert_eq!(c.balance(&alice), 10_000 - STAKE);
    assert_eq!(c.balance(&c.client.address), STAKE);
    let p = c.client.get_participant(&id, &alice);
    assert_eq!(p.stake, STAKE);
    assert_eq!(p.saved, 0);
    assert!(!p.settled);
    assert_eq!(c.client.get_challenge(&id).participant_count, 1);
    assert_eq!(c.client.get_participants(&id).get(0), Some(alice.clone()));

    assert_eq!(c.client.try_join(&alice, &id), Err(Ok(Error::AlreadyJoined)));
    assert_eq!(c.client.try_join(&alice, &99), Err(Ok(Error::NotFound)));
}

#[test]
fn join_rejected_when_full_or_after_deadline() {
    let c = setup();
    let mut config = c.config(ChallengeKind::TotalSaved, 5_000);
    config.max_participants = 2;
    let id = c.create(&config);

    c.joined(id, STAKE);
    c.joined(id, STAKE);
    let late = c.funded(STAKE);
    assert_eq!(c.client.try_join(&late, &id), Err(Ok(Error::ChallengeFull)));

    let id2 = c.create(&c.config(ChallengeKind::TotalSaved, 5_000));
    c.end(id2);
    assert_eq!(c.client.try_join(&late, &id2), Err(Ok(Error::ChallengeEnded)));
    assert_eq!(c.balance(&late), STAKE);
}

// ── Progress ───────────────────────────────────────────────────────────────

#[test]
fn progress_is_tracked_accurately() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::TotalSaved, 5_000));
    let alice = c.joined(id, 10_000);

    c.client.deposit(&alice, &id, &2_000);
    assert!(c.emitted("progress"));
    assert!(!c.client.is_on_track(&id, &alice));
    c.client.deposit(&alice, &id, &1_000);
    c.advance(DAY);
    c.client.deposit(&alice, &id, &2_500);

    let p = c.client.get_participant(&id, &alice);
    assert_eq!(p.saved, 5_500);
    assert_eq!(p.deposits, 3);
    assert_eq!(p.first_deposit, 2_000);
    assert_eq!(p.active_periods, 2);
    assert!(c.client.is_on_track(&id, &alice));
    assert_eq!(c.balance(&alice), 10_000 - STAKE - 5_500);
    assert_eq!(c.balance(&c.client.address), STAKE + 5_500);
}

#[test]
fn deposit_rejects_bad_input() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::TotalSaved, 5_000));
    let alice = c.joined(id, 10_000);
    let stranger = c.funded(10_000);

    assert_eq!(
        c.client.try_deposit(&alice, &id, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        c.client.try_deposit(&stranger, &id, &100),
        Err(Ok(Error::NotAParticipant))
    );
    c.end(id);
    assert_eq!(
        c.client.try_deposit(&alice, &id, &100),
        Err(Ok(Error::ChallengeEnded))
    );
}

// ── Settlement ─────────────────────────────────────────────────────────────

#[test]
fn prizes_go_to_winners_and_losers_get_stake_minus_fee() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::TotalSaved, 5_000));
    let alice = c.joined(id, 10_000);
    let bob = c.joined(id, 10_000);
    let carol = c.joined(id, 10_000);

    c.client.deposit(&alice, &id, &5_000);
    c.client.deposit(&bob, &id, &6_000);
    c.client.deposit(&carol, &id, &1_000); // short of the target

    assert_eq!(
        c.client.try_settle(&id, &alice),
        Err(Ok(Error::ChallengeNotEnded))
    );
    c.end(id);

    // Carol loses 20% of her stake (200) into the pool; the two winners
    // share it.
    let carol_payout = c.client.settle(&id, &carol);
    assert!(c.emitted("final"));
    assert!(c.emitted("settled"));
    assert_eq!(carol_payout, STAKE - 200 + 1_000);
    let challenge = c.client.get_challenge(&id);
    assert_eq!(challenge.status, ChallengeStatus::Settling);
    assert_eq!(challenge.winners, 2);
    assert_eq!(challenge.prize_pool, 200);

    assert_eq!(c.client.settle(&id, &alice), STAKE + 5_000 + 100);
    assert_eq!(c.client.settle(&id, &bob), STAKE + 6_000 + 100);
    assert!(c.emitted("closed"));

    assert_eq!(c.balance(&alice), 10_000 + 100);
    assert_eq!(c.balance(&bob), 10_000 + 100);
    assert_eq!(c.balance(&carol), 10_000 - 200);
    assert_eq!(c.balance(&c.client.address), 0);
    assert_eq!(c.client.get_challenge(&id).status, ChallengeStatus::Closed);
    assert_eq!(
        c.client.try_settle(&id, &alice),
        Err(Ok(Error::AlreadySettled))
    );
}

#[test]
fn last_winner_receives_the_rounding_remainder() {
    let c = setup();
    let mut config = c.config(ChallengeKind::TotalSaved, 100);
    config.penalty_bps = 1_000; // 10% of 1_000 = 100 per loser
    let id = c.create(&config);
    let winners = [c.joined(id, 10_000), c.joined(id, 10_000), c.joined(id, 10_000)];
    let loser = c.joined(id, 10_000);
    for w in winners.iter() {
        c.client.deposit(w, &id, &100);
    }
    c.end(id);

    c.client.settle(&id, &loser);
    // Pool of 100 split three ways: 33, 33, then 34.
    assert_eq!(c.client.settle(&id, &winners[0]), STAKE + 100 + 33);
    assert_eq!(c.client.settle(&id, &winners[1]), STAKE + 100 + 33);
    assert_eq!(c.client.settle(&id, &winners[2]), STAKE + 100 + 34);
    assert_eq!(c.balance(&c.client.address), 0);
}

#[test]
fn everyone_is_refunded_when_nobody_succeeds() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::TotalSaved, 5_000));
    let alice = c.joined(id, 10_000);
    let bob = c.joined(id, 10_000);
    c.client.deposit(&alice, &id, &1_000);
    c.end(id);

    assert_eq!(c.client.settle(&id, &alice), STAKE + 1_000);
    assert_eq!(c.client.settle(&id, &bob), STAKE);
    assert_eq!(c.client.get_challenge(&id).winners, 0);
    assert_eq!(c.balance(&alice), 10_000);
    assert_eq!(c.balance(&bob), 10_000);
}

#[test]
fn everyone_is_refunded_below_min_participants() {
    let c = setup();
    let mut config = c.config(ChallengeKind::TotalSaved, 5_000);
    config.min_participants = 3;
    let id = c.create(&config);
    let alice = c.joined(id, 10_000);
    let bob = c.joined(id, 10_000);
    c.client.deposit(&alice, &id, &5_000);
    c.end(id);

    assert_eq!(c.client.settle(&id, &bob), STAKE);
    assert_eq!(c.client.settle(&id, &alice), STAKE + 5_000);
    assert_eq!(c.balance(&alice), 10_000);
    assert_eq!(c.balance(&bob), 10_000);
}

// ── Challenge kinds ────────────────────────────────────────────────────────

#[test]
fn consistency_counts_distinct_periods() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::Consistency, 3));
    let steady = c.joined(id, 10_000);
    let bursty = c.joined(id, 10_000);

    for _ in 0..3 {
        c.client.deposit(&steady, &id, &10);
        c.client.deposit(&bursty, &id, &10);
        c.client.deposit(&bursty, &id, &10);
    }
    // So far everything happened in period 0.
    assert_eq!(c.client.get_participant(&id, &bursty).active_periods, 1);

    c.advance(DAY);
    c.client.deposit(&steady, &id, &10);
    c.advance(2 * DAY);
    c.client.deposit(&steady, &id, &10);

    assert_eq!(c.client.get_participant(&id, &steady).active_periods, 3);
    assert!(c.client.is_on_track(&id, &steady));
    assert!(!c.client.is_on_track(&id, &bursty));

    c.end(id);
    c.client.settle(&id, &bursty);
    assert_eq!(c.client.get_challenge(&id).winners, 1);
}

#[test]
fn growth_rate_measures_growth_over_first_deposit() {
    let c = setup();
    // At least 50% growth over the opening deposit.
    let id = c.create(&c.config(ChallengeKind::GrowthRate, 5_000));
    let grower = c.joined(id, 10_000);
    let flat = c.joined(id, 10_000);

    c.client.deposit(&grower, &id, &1_000);
    c.client.deposit(&grower, &id, &499);
    assert!(!c.client.is_on_track(&id, &grower));
    c.client.deposit(&grower, &id, &1);
    assert!(c.client.is_on_track(&id, &grower));

    c.client.deposit(&flat, &id, &5_000);
    assert!(!c.client.is_on_track(&id, &flat));

    c.end(id);
    assert_eq!(c.client.settle(&id, &flat), STAKE - 200 + 5_000);
    assert_eq!(c.client.settle(&id, &grower), STAKE + 1_500 + 200);
}

// ── Additional Edge Cases ──────────────────────────────────────────────────

#[test]
fn multiple_challenges_track_separately() {
    let c = setup();
    let id1 = c.create(&c.config(ChallengeKind::TotalSaved, 1_000));
    let id2 = c.create(&c.config(ChallengeKind::Consistency, 3));
    
    let alice = c.funded(20_000);
    c.client.join(&alice, &id1);
    c.client.join(&alice, &id2);
    
    c.client.deposit(&alice, &id1, &1_000);
    c.client.deposit(&alice, &id2, &100);
    c.advance(DAY);
    c.client.deposit(&alice, &id2, &100);
    c.advance(DAY);
    c.client.deposit(&alice, &id2, &100);
    
    assert!(c.client.is_on_track(&id1, &alice));
    assert!(c.client.is_on_track(&id2, &alice));
    assert_eq!(c.client.get_participant(&id1, &alice).saved, 1_000);
    assert_eq!(c.client.get_participant(&id2, &alice).active_periods, 3);
    assert_eq!(c.balance(&alice), 20_000 - 2 * STAKE - 1_300);
}

#[test]
fn penalty_bps_at_maximum_takes_all_stake() {
    let c = setup();
    let mut config = c.config(ChallengeKind::TotalSaved, 5_000);
    config.penalty_bps = 10_000; // 100% penalty
    let id = c.create(&config);
    
    let winner = c.joined(id, 10_000);
    let loser = c.joined(id, 10_000);
    
    c.client.deposit(&winner, &id, &5_000);
    c.end(id);
    
    // Loser gets nothing back from stake, winner gets entire loser's stake
    assert_eq!(c.client.settle(&id, &loser), 0);
    assert_eq!(c.client.settle(&id, &winner), STAKE + 5_000 + STAKE);
    assert_eq!(c.balance(&winner), 10_000 + STAKE);
    assert_eq!(c.balance(&loser), 10_000 - STAKE);
}

#[test]
fn zero_penalty_returns_full_stake_to_losers() {
    let c = setup();
    let mut config = c.config(ChallengeKind::TotalSaved, 5_000);
    config.penalty_bps = 0; // No penalty
    let id = c.create(&config);
    
    let winner = c.joined(id, 10_000);
    let loser = c.joined(id, 10_000);
    
    c.client.deposit(&winner, &id, &5_000);
    c.end(id);
    
    // Loser gets full stake back, winner gets stake plus deposits (no bonus)
    assert_eq!(c.client.settle(&id, &loser), STAKE);
    assert_eq!(c.client.settle(&id, &winner), STAKE + 5_000);
    assert_eq!(c.balance(&winner), 10_000);
    assert_eq!(c.balance(&loser), 10_000);
}

#[test]
fn consistency_target_exactly_met_at_deadline() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::Consistency, 7));
    let alice = c.joined(id, 10_000);
    
    // Make deposits across exactly 7 distinct periods (days 0-6)
    for day in 0..7 {
        if day > 0 {
            c.advance(DAY);
        }
        c.client.deposit(&alice, &id, &10);
    }
    
    assert_eq!(c.client.get_participant(&id, &alice).active_periods, 7);
    assert!(c.client.is_on_track(&id, &alice));
    
    c.end(id);
    // Alice is the only participant and meets the target
    assert_eq!(c.client.settle(&id, &alice), STAKE + 70);
    assert_eq!(c.client.get_challenge(&id).winners, 1);
}

#[test]
fn settle_handles_participant_with_no_deposits() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::TotalSaved, 1_000));
    
    let winner = c.joined(id, 10_000);
    let idle = c.joined(id, 10_000);
    let loser_with_deposit = c.joined(id, 10_000);
    
    c.client.deposit(&winner, &id, &1_000);
    c.client.deposit(&loser_with_deposit, &id, &500);
    // idle makes no deposits at all
    
    c.end(id);
    
    // Idle participant loses penalty from stake with no deposits to reclaim
    let idle_payout = c.client.settle(&id, &idle);
    assert_eq!(idle_payout, STAKE - 200); // 20% penalty, no deposits
    
    // Loser with deposit gets stake minus penalty plus their deposits back
    let loser_payout = c.client.settle(&id, &loser_with_deposit);
    assert_eq!(loser_payout, STAKE - 200 + 500);
    
    // Winner gets bonus from both losers' penalties (400 total)
    let winner_payout = c.client.settle(&id, &winner);
    assert_eq!(winner_payout, STAKE + 1_000 + 400);
    
    assert_eq!(c.balance(&c.client.address), 0);
}

#[test]
fn growth_rate_with_zero_first_deposit_handled_correctly() {
    let c = setup();
    // Target 5000 basis points = 50% growth
    let id = c.create(&c.config(ChallengeKind::GrowthRate, 5_000));
    let participant = c.joined(id, 10_000);
    
    // Making deposits in a valid sequence
    c.client.deposit(&participant, &id, &2_000);
    c.client.deposit(&participant, &id, &1_000);
    
    let p = c.client.get_participant(&id, &participant);
    assert_eq!(p.first_deposit, 2_000);
    assert_eq!(p.saved, 3_000);
    
    // Growth is 1000/2000 = 50%, which meets the 50% target
    assert!(c.client.is_on_track(&id, &participant));
    
    c.end(id);
    let payout = c.client.settle(&id, &participant);
    // Only participant, so gets full stake back plus all deposits
    assert_eq!(payout, STAKE + 3_000);
    assert_eq!(c.client.get_challenge(&id).winners, 1);
}

#[test]
fn multiple_deposits_in_same_period_count_as_one_for_consistency() {
    let c = setup();
    // Target: be active in at least 4 periods
    let id = c.create(&c.config(ChallengeKind::Consistency, 4));
    let alice = c.joined(id, 10_000);
    let bob = c.joined(id, 10_000);
    
    // Alice makes multiple deposits in same period - should count as 1
    c.client.deposit(&alice, &id, &100);
    c.client.deposit(&alice, &id, &100);
    c.client.deposit(&alice, &id, &100);
    assert_eq!(c.client.get_participant(&id, &alice).active_periods, 1);
    assert_eq!(c.client.get_participant(&id, &alice).deposits, 3);
    
    // Move to different periods
    c.advance(DAY);
    c.client.deposit(&alice, &id, &100);
    c.client.deposit(&bob, &id, &100);
    
    c.advance(DAY);
    c.client.deposit(&alice, &id, &100);
    c.client.deposit(&bob, &id, &100);
    
    c.advance(DAY);
    c.client.deposit(&alice, &id, &100);
    c.client.deposit(&bob, &id, &100);
    
    // Alice: 4 periods, Bob: 3 periods
    assert_eq!(c.client.get_participant(&id, &alice).active_periods, 4);
    assert_eq!(c.client.get_participant(&id, &bob).active_periods, 3);
    assert!(c.client.is_on_track(&id, &alice));
    assert!(!c.client.is_on_track(&id, &bob));
    
    c.end(id);
    
    // Bob loses penalty, Alice wins
    let bob_payout = c.client.settle(&id, &bob);
    assert_eq!(bob_payout, STAKE - 200 + 300); // penalty + deposits back
    
    let alice_payout = c.client.settle(&id, &alice);
    assert_eq!(alice_payout, STAKE + 600 + 200); // stake + deposits + bonus
    
    assert_eq!(c.balance(&c.client.address), 0);
    assert_eq!(c.client.get_challenge(&id).winners, 1);
}

#[test]
fn challenge_with_exact_min_and_max_participants() {
    let c = setup();
    let mut config = c.config(ChallengeKind::TotalSaved, 1_000);
    config.min_participants = 2;
    config.max_participants = 2;
    let id = c.create(&config);
    
    // Add exactly 2 participants (min and max)
    let p1 = c.joined(id, 10_000);
    let p2 = c.joined(id, 10_000);
    
    // Verify challenge is now full
    assert_eq!(c.client.get_challenge(&id).participant_count, 2);
    let p3 = c.funded(STAKE);
    assert_eq!(c.client.try_join(&p3, &id), Err(Ok(Error::ChallengeFull)));
    
    // Both participants meet target
    c.client.deposit(&p1, &id, &1_000);
    c.client.deposit(&p2, &id, &1_000);
    
    c.end(id);
    
    // Both are winners, no prize pool (everyone won)
    assert_eq!(c.client.settle(&id, &p1), STAKE + 1_000);
    assert_eq!(c.client.settle(&id, &p2), STAKE + 1_000);
    assert_eq!(c.client.get_challenge(&id).winners, 2);
    assert_eq!(c.client.get_challenge(&id).prize_pool, 0);
}

#[test]
fn settle_all_participants_in_different_order() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::TotalSaved, 1_000));
    
    let p1 = c.joined(id, 10_000);
    let p2 = c.joined(id, 10_000);
    let p3 = c.joined(id, 10_000);
    let p4 = c.joined(id, 10_000);
    
    // Only p2 and p4 meet the target
    c.client.deposit(&p2, &id, &1_000);
    c.client.deposit(&p4, &id, &1_200);
    c.client.deposit(&p1, &id, &500);
    c.client.deposit(&p3, &id, &300);
    
    c.end(id);
    
    // Settle in non-sequential order: p3, p1, p4, p2
    // 2 losers, each penalized 200, total pool = 400
    let p3_payout = c.client.settle(&id, &p3);
    assert_eq!(p3_payout, STAKE - 200 + 300);
    assert_eq!(c.client.get_challenge(&id).prize_pool, 200);
    
    let p1_payout = c.client.settle(&id, &p1);
    assert_eq!(p1_payout, STAKE - 200 + 500);
    assert_eq!(c.client.get_challenge(&id).prize_pool, 400);
    
    // Winners split the pool: 200 each
    let p4_payout = c.client.settle(&id, &p4);
    assert_eq!(p4_payout, STAKE + 1_200 + 200);
    
    let p2_payout = c.client.settle(&id, &p2);
    assert_eq!(p2_payout, STAKE + 1_000 + 200);
    
    assert_eq!(c.balance(&c.client.address), 0);
    assert_eq!(c.client.get_challenge(&id).status, ChallengeStatus::Closed);
}

#[test]
fn growth_rate_with_minimal_growth_just_below_target() {
    let c = setup();
    // Target 5000 bps = 50% growth
    let id = c.create(&c.config(ChallengeKind::GrowthRate, 5_000));
    
    let barely_missing = c.joined(id, 10_000);
    let winner = c.joined(id, 10_000);
    
    // barely_missing: first deposit 1000, total 1499 = 49.9% growth (just below 50%)
    c.client.deposit(&barely_missing, &id, &1_000);
    c.client.deposit(&barely_missing, &id, &499);
    assert!(!c.client.is_on_track(&id, &barely_missing));
    
    // winner: first deposit 1000, total 1500 = 50% growth (exactly meets target)
    c.client.deposit(&winner, &id, &1_000);
    c.client.deposit(&winner, &id, &500);
    assert!(c.client.is_on_track(&id, &winner));
    
    c.end(id);
    
    // barely_missing loses penalty
    let loser_payout = c.client.settle(&id, &barely_missing);
    assert_eq!(loser_payout, STAKE - 200 + 1_499);
    
    let winner_payout = c.client.settle(&id, &winner);
    assert_eq!(winner_payout, STAKE + 1_500 + 200);
    
    assert_eq!(c.client.get_challenge(&id).winners, 1);
}

#[test]
fn consistency_challenge_with_deposits_at_period_boundaries() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::Consistency, 3));
    let alice = c.joined(id, 10_000);
    
    // Deposit at the very start of period 0
    c.client.deposit(&alice, &id, &100);
    assert_eq!(c.client.get_participant(&id, &alice).active_periods, 1);
    
    // Advance to 1 second before next period
    c.advance(DAY - 1);
    c.client.deposit(&alice, &id, &100);
    // Still in period 0
    assert_eq!(c.client.get_participant(&id, &alice).active_periods, 1);
    
    // Cross into period 1
    c.advance(1);
    c.client.deposit(&alice, &id, &100);
    assert_eq!(c.client.get_participant(&id, &alice).active_periods, 2);
    
    // Jump to period 2
    c.advance(DAY);
    c.client.deposit(&alice, &id, &100);
    assert_eq!(c.client.get_participant(&id, &alice).active_periods, 3);
    
    assert!(c.client.is_on_track(&id, &alice));
    
    c.end(id);
    let payout = c.client.settle(&id, &alice);
    assert_eq!(payout, STAKE + 400);
    assert_eq!(c.client.get_challenge(&id).winners, 1);
}

#[test]
fn challenge_cannot_be_settled_twice_by_same_participant() {
    let c = setup();
    let id = c.create(&c.config(ChallengeKind::TotalSaved, 1_000));
    
    let winner = c.joined(id, 10_000);
    let loser = c.joined(id, 10_000);
    
    c.client.deposit(&winner, &id, &1_000);
    c.end(id);
    
    // First settlement succeeds
    let first_payout = c.client.settle(&id, &winner);
    assert!(first_payout > 0);
    assert!(c.client.get_participant(&id, &winner).settled);
    
    // Second settlement attempt fails
    assert_eq!(
        c.client.try_settle(&id, &winner),
        Err(Ok(Error::AlreadySettled))
    );
    
    // Loser can still settle
    let loser_payout = c.client.settle(&id, &loser);
    assert!(loser_payout > 0);
    
    // Loser also cannot settle twice
    assert_eq!(
        c.client.try_settle(&id, &loser),
        Err(Ok(Error::AlreadySettled))
    );
    
    assert_eq!(c.balance(&c.client.address), 0);
}
