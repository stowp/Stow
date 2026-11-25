extern crate std;
use soroban_sdk::TryFromVal as _;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::Client as TokenClient,
    Address, Env,
};

use super::{mint, set_ledger_time, setup_with_token_and_id};
use crate::error::Error;
use crate::types::{RecurringDeposit, RecurringFrequency};

const DAY: u64 = 86_400;
const WEEK: u64 = 7 * DAY;

#[test]
fn recurring_deposit_can_be_set_up() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, _) = setup_with_token_and_id(&env);
    let owner = Address::generate(&env);
    let now = env.ledger().timestamp();

    let next = client.setup_recurring(&owner, &25_000, &RecurringFrequency::Weekly);

    assert_eq!(next, now + WEEK);
    assert_eq!(
        client.recurring_deposit(&owner),
        Some(RecurringDeposit {
            owner,
            amount: 25_000,
            frequency: RecurringFrequency::Weekly,
            next_execution: next,
        })
    );
}

#[test]
fn recurring_execution_rejects_insufficient_wallet_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, _) = setup_with_token_and_id(&env);
    let owner = Address::generate(&env);

    let due = client.setup_recurring(&owner, &10_000, &RecurringFrequency::Daily);
    set_ledger_time(&env, due, 1);

    assert_eq!(
        client.try_execute_recurring(&owner),
        Err(Ok(Error::InsufficientBalance))
    );
    assert_eq!(
        client.recurring_deposit(&owner).unwrap().next_execution,
        due
    );
}

#[test]
fn recurring_execution_updates_schedule_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, token, vault) = setup_with_token_and_id(&env);
    let owner = Address::generate(&env);
    const AMOUNT: i128 = 30_000;

    let token_admin = Address::generate(&env);
    mint(&env, &token, &token_admin, &owner, AMOUNT);
    let token_client = TokenClient::new(&env, &token);
    let allowance_expiration = env.ledger().sequence() + 100_000;
    token_client.approve(&owner, &vault, &AMOUNT, &allowance_expiration);

    let due = client.setup_recurring(&owner, &AMOUNT, &RecurringFrequency::Daily);
    set_ledger_time(&env, due, 1);
    client.execute_recurring(&owner);

    let schedule = client.recurring_deposit(&owner).unwrap();
    assert_eq!(schedule.next_execution, due + DAY);
    assert_eq!(client.get_account(&owner).balance, AMOUNT);
    assert_eq!(token_client.balance(&owner), 0);

    let events = env.events().all();
    let recurring_events: std::vec::Vec<_> = events
        .iter()
        .filter(|event| {
            event
                .1
                .get(0)
                .and_then(|topic| soroban_sdk::Symbol::try_from_val(&env, &topic).ok())
                .map(|symbol| symbol == soroban_sdk::Symbol::new(&env, "RecurringDepositExecuted"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(recurring_events.len(), 1);
    assert_eq!(
        recurring_events[0]
            .1
            .get(1)
            .and_then(|topic| Address::try_from_val(&env, &topic).ok()),
        Some(owner)
    );
}

#[test]
fn recurring_execution_is_not_available_before_due_time() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, _) = setup_with_token_and_id(&env);
    let owner = Address::generate(&env);

    client.setup_recurring(&owner, &10_000, &RecurringFrequency::Daily);

    assert_eq!(
        client.try_execute_recurring(&owner),
        Err(Ok(Error::TimeWindowNotOpen))
    );
}

#[test]
fn recurring_schedule_cannot_be_cancelled_by_another_address() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, _) = setup_with_token_and_id(&env);
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.setup_recurring(&owner, &10_000, &RecurringFrequency::Monthly);

    assert_eq!(
        client.try_cancel_recurring(&attacker),
        Err(Ok(Error::NotFound))
    );
    assert!(client.recurring_deposit(&owner).is_some());

    client.cancel_recurring(&owner);
    assert!(client.recurring_deposit(&owner).is_none());
}

#[test]
fn recurring_setup_rejects_non_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, _) = setup_with_token_and_id(&env);
    let owner = Address::generate(&env);

    assert_eq!(
        client.try_setup_recurring(&owner, &0, &RecurringFrequency::Daily),
        Err(Ok(Error::InvalidAmount))
    );
    assert!(client.recurring_deposit(&owner).is_none());
}
