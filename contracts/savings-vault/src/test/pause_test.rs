//! Pause mechanism tests.

use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{Address, Env};

use crate::error::Error;
use crate::test::{create_token, deploy_contract, TestContext};

#[test]
fn test_only_admin_can_pause() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let token = create_token(&env);

    let contract = deploy_contract(&env, &admin, &token);

    // Non-admin cannot pause
    let result = contract.try_pause(&user);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err, Error::Unauthorized);

    // Admin can pause
    contract.pause(&admin);
    assert!(contract.is_paused());

    // Non-admin cannot unpause
    let result = contract.try_unpause(&user);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err, Error::Unauthorized);

    // Admin can unpause
    contract.unpause(&admin);
    assert!(!contract.is_paused());
}

#[test]
fn test_set_paused() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token = create_token(&env);

    let contract = deploy_contract(&env, &admin, &token);

    // Initially unpaused
    assert!(!contract.is_paused());

    // Admin can set paused
    contract.set_paused(&admin, true);
    assert!(contract.is_paused());

    // Admin can set unpaused
    contract.set_paused(&admin, false);
    assert!(!contract.is_paused());
}

#[test]
fn test_deposits_fail_when_paused() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let token = create_token(&env);

    let contract = deploy_contract(&env, &admin, &token);

    // Pause the contract
    contract.pause(&admin);
    assert!(contract.is_paused());

    // Deposit fails when paused
    let result = contract.try_deposit(&user, &1000);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err, Error::Paused);
}

#[test]
fn test_withdrawals_fail_when_paused() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let token = create_token(&env);

    let contract = deploy_contract(&env, &admin, &token);

    // Make a deposit first
    token.mock_all_sources().mint(&user, &1000);
    contract.deposit(&user, &1000);

    // Pause the contract
    contract.pause(&admin);
    assert!(contract.is_paused());

    // Withdraw fails when paused
    let result = contract.try_withdraw(&user, &500);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err, Error::Paused);
}

#[test]
fn test_emergency_withdraw_works_when_paused() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let token = create_token(&env);

    let contract = deploy_contract(&env, &admin, &token);

    // Create a locked plan
    token.mock_all_sources().mint(&user, &1000);
    let unlock_at = env.ledger().timestamp() + 1000;
    contract.locked_create(&user, &1000, &unlock_at);

    // Pause the contract
    contract.pause(&admin);
    assert!(contract.is_paused());

    // Enable emergency mode
    contract.set_emergency_mode(&admin, true);

    // Emergency withdraw works even when paused
    let result = contract.try_locked_emergency_withdraw(&user, &1u64);
    assert!(result.is_ok());
}

#[test]
fn test_events_emitted_correctly() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token = create_token(&env);

    let contract = deploy_contract(&env, &admin, &token);

    // Record events before pause
    let pause_events_before = env.events().all().len();

    // Pause emits event
    contract.pause(&admin);

    // Check pause event was emitted
    let pause_events_after = env.events().all().len();
    assert_eq!(pause_events_after - pause_events_before, 1);

    // Unpause emits event
    let unpause_events_before = env.events().all().len();
    contract.unpause(&admin);
    let unpause_events_after = env.events().all().len();
    assert_eq!(unpause_events_after - unpause_events_before, 1);
}

#[test]
fn test_non_admin_cannot_pause() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let token = create_token(&env);

    let contract = deploy_contract(&env, &admin, &token);

    // Non-admin cannot pause
    let result = contract.try_pause(&non_admin);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Error::Unauthorized);

    // Contract remains unpaused
    assert!(!contract.is_paused());
}

#[test]
fn test_is_paused_view() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token = create_token(&env);

    let contract = deploy_contract(&env, &admin, &token);

    // Initially unpaused
    assert!(!contract.is_paused());

    // After pause
    contract.pause(&admin);
    assert!(contract.is_paused());

    // After unpause
    contract.unpause(&admin);
    assert!(!contract.is_paused());
}