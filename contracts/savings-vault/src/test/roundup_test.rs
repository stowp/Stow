//! Automatic savings round-ups (#622).

extern crate std;

use soroban_sdk::testutils::Events as _;
use soroban_sdk::{token, Address, Env, String, TryFromVal, Val, Vec};

use crate::error::Error;
use crate::events::{TOPIC_ROUNDUP_DEPOSIT, TOPIC_ROUNDUP_SKIPPED};
use crate::roundup::roundup_difference;
use crate::test::register_vault;
use crate::types::RoundupLevel;
use crate::SavingsVaultClient;

fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token).mint(to, &amount);
}

fn token_balance(env: &Env, token: &Address, who: &Address) -> i128 {
    token::Client::new(env, token).balance(who)
}

/// Data of every event published by `vault` whose first topic is `topic`.
fn events_with_topic(env: &Env, vault: &SavingsVaultClient, topic: &str) -> std::vec::Vec<Val> {
    let expected = String::from_str(env, topic);
    env.events()
        .all()
        .iter()
        .filter(|(contract, topics, _)| {
            *contract == vault.address
                && topics
                    .get(0)
                    .and_then(|v| String::try_from_val(env, &v).ok())
                    == Some(expected.clone())
        })
        .map(|(_, _, data)| data)
        .collect()
}

#[test]
fn difference_is_calculated_for_various_amounts_and_levels() {
    // (amount, level, expected difference)
    let cases = [
        (123, RoundupLevel::Nearest1, 0),
        (123, RoundupLevel::Nearest5, 2),
        (123, RoundupLevel::Nearest10, 7),
        (120, RoundupLevel::Nearest10, 0),
        (121, RoundupLevel::Nearest5, 4),
        (125, RoundupLevel::Nearest5, 0),
        (4, RoundupLevel::Nearest5, 1),
        (1, RoundupLevel::Nearest10, 9),
        (9_999, RoundupLevel::Nearest10, 1),
    ];
    for (amount, level, expected) in cases {
        assert_eq!(
            roundup_difference(amount, level).unwrap(),
            expected,
            "amount {amount} at {level:?}"
        );
    }
}

#[test]
fn transaction_deposits_difference_into_savings_automatically() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault, token, owner) = register_vault(&env);
    mint(&env, &token, &owner, 1_000);

    vault.enable_roundup(&owner, &RoundupLevel::Nearest10);
    let diff = vault.record_roundup_transaction(&owner, &123);

    assert_eq!(diff, 7);
    assert_eq!(vault.get_account(&owner).balance, 7);
    assert_eq!(token_balance(&env, &token, &owner), 993);
    let config = vault.roundup_config(&owner);
    assert!(config.enabled);
    assert_eq!(config.tracked_total, 123);
    assert_eq!(config.deposited_total, 7);
    assert_eq!(config.skipped_total, 0);

    // A second transaction adds to the same savings balance.
    assert_eq!(vault.record_roundup_transaction(&owner, &58), 2);
    assert_eq!(vault.get_account(&owner).balance, 9);
    let config = vault.roundup_config(&owner);
    assert_eq!(config.tracked_total, 181);
    assert_eq!(config.deposited_total, 9);
}

#[test]
fn each_rounding_level_deposits_its_own_difference() {
    let cases = [
        (RoundupLevel::Nearest1, 0),
        (RoundupLevel::Nearest5, 3),
        (RoundupLevel::Nearest10, 3),
    ];
    for (level, expected) in cases {
        let env = Env::default();
        env.mock_all_auths();
        let (vault, token, owner) = register_vault(&env);
        mint(&env, &token, &owner, 1_000);

        vault.enable_roundup(&owner, &level);
        assert_eq!(vault.record_roundup_transaction(&owner, &17), expected);
        assert_eq!(vault.roundup_config(&owner).deposited_total, expected);
        assert_eq!(token_balance(&env, &token, &owner), 1_000 - expected);
    }
}

#[test]
fn deposit_event_includes_roundup_details() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault, token, owner) = register_vault(&env);
    mint(&env, &token, &owner, 1_000);

    vault.enable_roundup(&owner, &RoundupLevel::Nearest10);
    vault.record_roundup_transaction(&owner, &123);

    let events = events_with_topic(&env, &vault, TOPIC_ROUNDUP_DEPOSIT);
    assert_eq!(events.len(), 1, "one RoundupDeposit event must be emitted");
    let data: Vec<i128> = Vec::try_from_val(&env, &events[0]).unwrap();
    // (amount, rounded amount, difference, step, deposited total)
    assert_eq!(data.get(0), Some(123));
    assert_eq!(data.get(1), Some(130));
    assert_eq!(data.get(2), Some(7));
    assert_eq!(data.get(3), Some(10));
    assert_eq!(data.get(4), Some(7));
}

#[test]
fn exact_multiple_saves_nothing_and_emits_no_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault, _token, owner) = register_vault(&env);

    vault.enable_roundup(&owner, &RoundupLevel::Nearest5);
    assert_eq!(vault.record_roundup_transaction(&owner, &40), 0);
    let config = vault.roundup_config(&owner);
    assert_eq!(config.tracked_total, 40);
    assert_eq!(config.deposited_total, 0);
    assert!(events_with_topic(&env, &vault, TOPIC_ROUNDUP_DEPOSIT).is_empty());
}

#[test]
fn feature_can_be_toggled_off_and_on() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault, token, owner) = register_vault(&env);
    mint(&env, &token, &owner, 1_000);

    vault.enable_roundup(&owner, &RoundupLevel::Nearest10);
    assert_eq!(vault.record_roundup_transaction(&owner, &123), 7);

    vault.disable_roundup(&owner);
    assert!(!vault.roundup_config(&owner).enabled);
    // While off, transactions are ignored: nothing tracked, nothing deposited.
    assert_eq!(vault.record_roundup_transaction(&owner, &123), 0);
    let config = vault.roundup_config(&owner);
    assert_eq!(config.tracked_total, 123);
    assert_eq!(config.deposited_total, 7);
    assert_eq!(vault.get_account(&owner).balance, 7);

    // Turning it back on keeps the totals and resumes deposits.
    vault.enable_roundup(&owner, &RoundupLevel::Nearest5);
    let config = vault.roundup_config(&owner);
    assert!(config.enabled);
    assert_eq!(config.level, RoundupLevel::Nearest5);
    assert_eq!(config.deposited_total, 7);
    assert_eq!(vault.record_roundup_transaction(&owner, &123), 2);
    assert_eq!(vault.get_account(&owner).balance, 9);
}

#[test]
fn disable_requires_an_existing_config() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault, _token, owner) = register_vault(&env);

    assert_eq!(vault.try_disable_roundup(&owner), Err(Ok(Error::NotFound)));
}

#[test]
fn insufficient_balance_skips_the_deposit_without_failing() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault, token, owner) = register_vault(&env);
    mint(&env, &token, &owner, 3);

    vault.enable_roundup(&owner, &RoundupLevel::Nearest10);
    // Needs 7, only 3 available: tracked, skipped, no deposit.
    assert_eq!(vault.record_roundup_transaction(&owner, &123), 0);

    let config = vault.roundup_config(&owner);
    assert_eq!(config.tracked_total, 123);
    assert_eq!(config.deposited_total, 0);
    assert_eq!(config.skipped_total, 7);
    assert_eq!(token_balance(&env, &token, &owner), 3);
    assert_eq!(vault.try_get_account(&owner), Err(Ok(Error::NotFound)));
    assert!(events_with_topic(&env, &vault, TOPIC_ROUNDUP_DEPOSIT).is_empty());
    assert_eq!(events_with_topic(&env, &vault, TOPIC_ROUNDUP_SKIPPED).len(), 1);

    // Once the balance covers it, round-ups deposit again.
    assert_eq!(vault.record_roundup_transaction(&owner, &8), 2);
    assert_eq!(vault.get_account(&owner).balance, 2);
}

#[test]
fn requires_enable_and_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (vault, _token, owner) = register_vault(&env);

    assert_eq!(
        vault.try_record_roundup_transaction(&owner, &10),
        Err(Ok(Error::NotFound))
    );
    vault.enable_roundup(&owner, &RoundupLevel::Nearest1);
    assert_eq!(
        vault.try_record_roundup_transaction(&owner, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        vault.try_record_roundup_transaction(&owner, &-5),
        Err(Ok(Error::InvalidAmount))
    );
}
