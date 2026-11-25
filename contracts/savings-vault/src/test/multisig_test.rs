use soroban_sdk::TryFromVal as _;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::Client as TokenClient,
    Address, Env, String,
};

use crate::error::Error;
use crate::events::{TOPIC_GROUP_WITHDRAWAL_EXECUTED, TOPIC_GROUP_WITHDRAWAL_REQUESTED};
use crate::test::{mint, set_ledger_time};
use crate::types::GroupWithdrawalRequest;
use crate::SavingsVaultClient;

const DAY: u64 = 86_400;

fn setup_funded_group(
    env: &Env,
    amount: i128,
) -> (SavingsVaultClient, Address, Address, Address, Address, u64) {
    let (client, _, token, vault) = super::setup_with_token_and_id(env);
    let token_admin = Address::generate(env);
    let member_a = Address::generate(env);
    let member_b = Address::generate(env);

    mint(env, &token, &token_admin, &member_a, amount);
    mint(env, &token, &token_admin, &member_b, amount);

    let group_id = client.group_create(&member_a, &String::from_str(env, "shared"));
    client.group_join(&member_b, &group_id);
    client.group_contribute(&member_a, &group_id, &amount);
    client.group_contribute(&member_b, &group_id, &amount);
    client.group_close(&member_a, &group_id);

    (client, token, vault, member_a, member_b, group_id)
}

#[test]
fn request_is_stored_with_the_requested_withdrawal_and_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, member_a, _, group_id) = setup_funded_group(&env, 100_000);
    let recipient = Address::generate(&env);
    let expires_at = env.ledger().timestamp() + DAY;

    let request_id =
        client.request_withdrawal(&member_a, &group_id, &recipient, &75_000, &2, &expires_at);
    let events = env.events().all();
    assert_eq!(
        client.withdrawal_request(&request_id),
        GroupWithdrawalRequest {
            id: request_id,
            group_id,
            requester: member_a.clone(),
            recipient,
            amount: 75_000,
            threshold: 2,
            approvers: soroban_sdk::Vec::new(&env),
            expires_at,
            rejected: false,
            executed: false,
        }
    );
    assert!(events.iter().any(|event| {
        event
            .1
            .get(0)
            .and_then(|topic| soroban_sdk::Symbol::try_from_val(&env, &topic).ok())
            .map(|symbol| {
                symbol == soroban_sdk::Symbol::new(&env, TOPIC_GROUP_WITHDRAWAL_REQUESTED)
            })
            .unwrap_or(false)
    }));
}

#[test]
fn approvals_accumulate_and_withdrawal_executes_at_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, member_a, member_b, group_id) = setup_funded_group(&env, 100_000);
    let recipient = Address::generate(&env);
    let expires_at = env.ledger().timestamp() + DAY;
    let request_id =
        client.request_withdrawal(&member_a, &group_id, &recipient, &75_000, &2, &expires_at);
    let token_client = TokenClient::new(&env, &token);

    client.approve_withdrawal(&member_a, &request_id);
    assert_eq!(client.withdrawal_request(&request_id).approvers.len(), 1);
    assert_eq!(token_client.balance(&recipient), 0);

    client.approve_withdrawal(&member_b, &request_id);
    let events = env.events().all();

    let request = client.withdrawal_request(&request_id);
    assert_eq!(request.approvers.len(), 2);
    assert!(request.executed);
    assert_eq!(token_client.balance(&recipient), 75_000);
    assert_eq!(client.group(&group_id).balance, 125_000);

    assert!(events.iter().any(|event| {
        event
            .1
            .get(0)
            .and_then(|topic| soroban_sdk::Symbol::try_from_val(&env, &topic).ok())
            .map(|symbol| symbol == soroban_sdk::Symbol::new(&env, TOPIC_GROUP_WITHDRAWAL_EXECUTED))
            .unwrap_or(false)
    }));
}

#[test]
fn non_member_cannot_approve_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, member_a, _, group_id) = setup_funded_group(&env, 100_000);
    let recipient = Address::generate(&env);
    let outsider = Address::generate(&env);
    let request_id = client.request_withdrawal(
        &member_a,
        &group_id,
        &recipient,
        &50_000,
        &1,
        &(env.ledger().timestamp() + DAY),
    );

    assert_eq!(
        client.try_approve_withdrawal(&outsider, &request_id),
        Err(Ok(Error::Unauthorized))
    );
    assert!(client.withdrawal_request(&request_id).approvers.is_empty());
}

#[test]
fn rejected_withdrawal_cannot_be_approved() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, member_a, member_b, group_id) = setup_funded_group(&env, 100_000);
    let recipient = Address::generate(&env);
    let request_id = client.request_withdrawal(
        &member_a,
        &group_id,
        &recipient,
        &50_000,
        &2,
        &(env.ledger().timestamp() + DAY),
    );

    client.reject_withdrawal(&member_b, &request_id);

    assert_eq!(
        client.try_approve_withdrawal(&member_a, &request_id),
        Err(Ok(Error::WithdrawalRequestClosed))
    );
    assert!(client.withdrawal_request(&request_id).rejected);
}

#[test]
fn expired_withdrawal_cannot_be_approved_or_execute() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, _, member_a, member_b, group_id) = setup_funded_group(&env, 100_000);
    let recipient = Address::generate(&env);
    let now = env.ledger().timestamp();
    let request_id =
        client.request_withdrawal(&member_a, &group_id, &recipient, &50_000, &1, &(now + 10));
    set_ledger_time(&env, now + 10, env.ledger().sequence() + 1);

    assert_eq!(
        client.try_approve_withdrawal(&member_b, &request_id),
        Err(Ok(Error::OperationExpired))
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 0);
    assert!(!client.withdrawal_request(&request_id).executed);
}

#[test]
fn withdrawal_request_rejects_an_invalid_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, member_a, _, group_id) = setup_funded_group(&env, 100_000);

    assert_eq!(
        client.try_request_withdrawal(
            &member_a,
            &group_id,
            &Address::generate(&env),
            &10_000,
            &3,
            &(env.ledger().timestamp() + DAY),
        ),
        Err(Ok(Error::InvalidParameters))
    );
}
