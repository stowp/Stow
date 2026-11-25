//! Savings vault profit sharing — issue #642.
//!
//! Covers: configuration storage, the 100% share invariant (and other
//! malformed share lists), accurate interest splitting with rounding dust
//! carried forward, distribution frequency, updates applying from the next
//! period, per-stakeholder distributed totals, and the `ProfitDistributed`
//! event payload.

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, TryFromVal, Val, Vec,
};

extern crate std;
use std::string::ToString;

use crate::error::Error;
use crate::events::TOPIC_PROFIT_DISTRIBUTED;
use crate::types::{CompoundFrequency, DistributionFrequency};
use crate::{SavingsVault, SavingsVaultClient};

const UNIT: i128 = 10_000_000; // 1 token (7 decimals)
const DAY: u64 = 86_400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    client: SavingsVaultClient<'a>,
    token: Address,
}

/// A vault with daily compounding, a funded reserve to pay interest from,
/// and an owner holding `principal` in an interest account.
fn setup(env: &Env, principal: i128) -> (Ctx<'_>, Address) {
    env.mock_all_auths();
    set_ledger(env, 1_000_000);
    let client = SavingsVaultClient::new(env, &env.register(SavingsVault, ()));
    let admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    client.initialize(&admin, &token);
    client.set_interest_frequency(&admin, &CompoundFrequency::Daily);

    // Reserve backing interest payouts.
    StellarAssetClient::new(env, &token).mint(&client.address, &(1_000_000 * UNIT));

    let owner = Address::generate(env);
    StellarAssetClient::new(env, &token).mint(&owner, &principal);
    client.interest_deposit(&owner, &principal);

    (Ctx { client, token }, owner)
}

fn set_ledger(env: &Env, timestamp: u64) {
    env.ledger().set(LedgerInfo {
        timestamp,
        protocol_version: 22,
        sequence_number: env.ledger().sequence() + 1,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });
}

fn advance(env: &Env, seconds: u64) {
    set_ledger(env, env.ledger().timestamp() + seconds);
}

fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    TokenClient::new(env, token).balance(who)
}

fn topic_matches(env: &Env, topics: &Vec<Val>, name: &str) -> bool {
    if let Some(first) = topics.get(0) {
        if let Ok(s) = soroban_sdk::String::try_from_val(env, &first) {
            return s.to_string() == name;
        }
        if let Ok(sym) = soroban_sdk::Symbol::try_from_val(env, &first) {
            return sym.to_string() == name;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[test]
fn configure_stores_stakeholders() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000 * UNIT);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    c.client.configure_profit_sharing(
        &owner,
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 7_000u32, 3_000u32],
        &DistributionFrequency::Weekly,
    );

    let config = c.client.profit_share_config(&owner).unwrap();
    assert_eq!(config.owner, owner);
    assert_eq!(config.stakeholders, vec![&env, a, b]);
    assert_eq!(config.shares_bps, vec![&env, 7_000u32, 3_000u32]);
    assert_eq!(config.frequency, DistributionFrequency::Weekly);
    assert_eq!(config.last_distributed_at, env.ledger().timestamp());
    assert_eq!(config.undistributed, 0);
    assert_eq!(config.distribution_count, 0);
    assert!(config.pending.is_none());
}

#[test]
fn shares_must_sum_to_100_percent() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000 * UNIT);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    for shares in [
        vec![&env, 5_000u32, 4_999u32],
        vec![&env, 5_000u32, 5_001u32],
    ] {
        let result = c.client.try_configure_profit_sharing(
            &owner,
            &vec![&env, a.clone(), b.clone()],
            &shares,
            &DistributionFrequency::Daily,
        );
        assert_eq!(result, Err(Ok(Error::InvalidProfitShares)));
    }
    assert!(c.client.profit_share_config(&owner).is_none());
}

#[test]
fn malformed_share_lists_rejected() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000 * UNIT);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    // Empty.
    let r = c.client.try_configure_profit_sharing(
        &owner,
        &Vec::new(&env),
        &Vec::new(&env),
        &DistributionFrequency::Daily,
    );
    assert_eq!(r, Err(Ok(Error::InvalidProfitShares)));

    // Mismatched lengths.
    let r = c.client.try_configure_profit_sharing(
        &owner,
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 10_000u32],
        &DistributionFrequency::Daily,
    );
    assert_eq!(r, Err(Ok(Error::InvalidProfitShares)));

    // Zero share.
    let r = c.client.try_configure_profit_sharing(
        &owner,
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 10_000u32, 0u32],
        &DistributionFrequency::Daily,
    );
    assert_eq!(r, Err(Ok(Error::InvalidProfitShares)));

    // Duplicate stakeholder.
    let r = c.client.try_configure_profit_sharing(
        &owner,
        &vec![&env, a.clone(), a.clone()],
        &vec![&env, 5_000u32, 5_000u32],
        &DistributionFrequency::Daily,
    );
    assert_eq!(r, Err(Ok(Error::InvalidProfitShares)));
}

#[test]
fn configure_requires_interest_account() {
    let env = Env::default();
    let (c, _owner) = setup(&env, 1_000 * UNIT);
    let stranger = Address::generate(&env);
    let r = c.client.try_configure_profit_sharing(
        &stranger,
        &vec![&env, Address::generate(&env)],
        &vec![&env, 10_000u32],
        &DistributionFrequency::Daily,
    );
    assert_eq!(r, Err(Ok(Error::NotFound)));
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

#[test]
fn interest_split_accurately() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000_000 * UNIT);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let d = Address::generate(&env);

    c.client.configure_profit_sharing(
        &owner,
        &vec![&env, a.clone(), b.clone(), d.clone()],
        &vec![&env, 5_000u32, 3_333u32, 1_667u32],
        &DistributionFrequency::Daily,
    );
    let principal_before = c.client.interest_account(&owner).principal;

    advance(&env, DAY);
    let earned = c.client.interest_accrued(&owner);
    assert!(earned > 0);

    let paid = c.client.distribute_profit(&owner);

    let share_a = earned * 5_000 / 10_000;
    let share_b = earned * 3_333 / 10_000;
    let share_d = earned * 1_667 / 10_000;
    assert_eq!(paid, share_a + share_b + share_d);
    assert_eq!(balance(&env, &c.token, &a), share_a);
    assert_eq!(balance(&env, &c.token, &b), share_b);
    assert_eq!(balance(&env, &c.token, &d), share_d);

    assert_eq!(c.client.profit_distributed(&owner, &a), share_a);
    assert_eq!(c.client.profit_distributed(&owner, &b), share_b);
    assert_eq!(c.client.profit_distributed(&owner, &d), share_d);

    // Paid interest leaves the owner's principal; dust stays earmarked.
    let config = c.client.profit_share_config(&owner).unwrap();
    assert_eq!(config.undistributed, earned - paid);
    assert_eq!(config.distribution_count, 1);
    assert_eq!(
        c.client.interest_account(&owner).principal,
        principal_before + earned - paid
    );
}

#[test]
fn interest_settled_by_owner_is_still_shared() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000_000 * UNIT);
    let a = Address::generate(&env);

    c.client.configure_profit_sharing(
        &owner,
        &vec![&env, a.clone()],
        &vec![&env, 10_000u32],
        &DistributionFrequency::Daily,
    );

    advance(&env, DAY);
    let claimed = c.client.interest_claim(&owner);
    assert!(claimed > 0);

    let paid = c.client.distribute_profit(&owner);
    assert_eq!(paid, claimed);
    assert_eq!(balance(&env, &c.token, &a), claimed);
}

#[test]
fn interest_before_configuration_is_not_shared() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000_000 * UNIT);
    let a = Address::generate(&env);

    advance(&env, DAY);
    assert!(c.client.interest_accrued(&owner) > 0);

    c.client.configure_profit_sharing(
        &owner,
        &vec![&env, a.clone()],
        &vec![&env, 10_000u32],
        &DistributionFrequency::Daily,
    );
    assert_eq!(c.client.profit_share_config(&owner).unwrap().undistributed, 0);

    // Only interest accrued after configuration is distributed.
    advance(&env, DAY);
    let earned = c.client.interest_accrued(&owner);
    let paid = c.client.distribute_profit(&owner);
    assert_eq!(paid, earned);
}

#[test]
fn distribution_frequency_respected() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000_000 * UNIT);
    let a = Address::generate(&env);

    c.client.configure_profit_sharing(
        &owner,
        &vec![&env, a.clone()],
        &vec![&env, 10_000u32],
        &DistributionFrequency::Weekly,
    );

    advance(&env, DAY);
    assert_eq!(
        c.client.try_distribute_profit(&owner),
        Err(Ok(Error::DistributionNotDue))
    );

    advance(&env, 6 * DAY);
    assert!(c.client.distribute_profit(&owner) > 0);

    // Immediately after a distribution the next period has not elapsed.
    assert_eq!(
        c.client.try_distribute_profit(&owner),
        Err(Ok(Error::DistributionNotDue))
    );

    advance(&env, 7 * DAY);
    assert!(c.client.distribute_profit(&owner) > 0);
    assert_eq!(c.client.profit_share_config(&owner).unwrap().distribution_count, 2);
}

#[test]
fn distribute_without_config_fails() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000 * UNIT);
    assert_eq!(
        c.client.try_distribute_profit(&owner),
        Err(Ok(Error::NotFound))
    );
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

#[test]
fn updates_apply_from_next_period() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000_000 * UNIT);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    c.client.configure_profit_sharing(
        &owner,
        &vec![&env, a.clone()],
        &vec![&env, 10_000u32],
        &DistributionFrequency::Daily,
    );

    advance(&env, DAY);
    c.client.configure_profit_sharing(
        &owner,
        &vec![&env, b.clone()],
        &vec![&env, 10_000u32],
        &DistributionFrequency::Weekly,
    );

    // The update is queued, not active.
    let config = c.client.profit_share_config(&owner).unwrap();
    assert_eq!(config.stakeholders, vec![&env, a.clone()]);
    assert_eq!(config.frequency, DistributionFrequency::Daily);
    assert!(config.pending.is_some());

    // The current period is still split under the old shares.
    let first = c.client.distribute_profit(&owner);
    assert!(first > 0);
    assert_eq!(balance(&env, &c.token, &a), first);
    assert_eq!(balance(&env, &c.token, &b), 0);

    // Now the update is active.
    let config = c.client.profit_share_config(&owner).unwrap();
    assert_eq!(config.stakeholders, vec![&env, b.clone()]);
    assert_eq!(config.frequency, DistributionFrequency::Weekly);
    assert!(config.pending.is_none());

    advance(&env, DAY);
    assert_eq!(
        c.client.try_distribute_profit(&owner),
        Err(Ok(Error::DistributionNotDue))
    );

    advance(&env, 6 * DAY);
    let second = c.client.distribute_profit(&owner);
    assert!(second > 0);
    assert_eq!(balance(&env, &c.token, &a), first);
    assert_eq!(balance(&env, &c.token, &b), second);
    assert_eq!(c.client.profit_distributed(&owner, &a), first);
    assert_eq!(c.client.profit_distributed(&owner, &b), second);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn profit_distributed_event_includes_details() {
    let env = Env::default();
    let (c, owner) = setup(&env, 1_000_000 * UNIT);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    c.client.configure_profit_sharing(
        &owner,
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 6_000u32, 4_000u32],
        &DistributionFrequency::Daily,
    );
    advance(&env, DAY);
    let paid = c.client.distribute_profit(&owner);

    let events = env.events().all();
    let (_contract, _topics, data) = events
        .iter()
        .find(|(_c, topics, _d)| topic_matches(&env, topics, TOPIC_PROFIT_DISTRIBUTED))
        .expect("ProfitDistributed event must be emitted");

    let (ev_owner, ev_total, ev_stakeholders, ev_amounts, _carried, ev_count, ev_ts): (
        Address,
        i128,
        Vec<Address>,
        Vec<i128>,
        i128,
        u32,
        u64,
    ) = TryFromVal::try_from_val(&env, &data).unwrap();

    assert_eq!(ev_owner, owner);
    assert_eq!(ev_total, paid);
    assert_eq!(ev_stakeholders, vec![&env, a.clone(), b.clone()]);
    assert_eq!(ev_amounts.len(), 2);
    assert_eq!(
        ev_amounts.get_unchecked(0) + ev_amounts.get_unchecked(1),
        paid
    );
    assert_eq!(ev_amounts.get_unchecked(0), balance(&env, &c.token, &a));
    assert_eq!(ev_amounts.get_unchecked(1), balance(&env, &c.token, &b));
    assert_eq!(ev_count, 1);
    assert_eq!(ev_ts, env.ledger().timestamp());
}
