//! Conditional withdrawals (#639).

use soroban_sdk::{
    contract, contractimpl, symbol_short, testutils::Address as _, token::Client as TokenClient,
    Address, Env, TryFromVal,
};

use super::{mint, set_ledger_time, setup_with_token_and_id, test_events};
use crate::error::Error;
use crate::types::{ConditionalWithdrawalRule, WithdrawalCondition};
use crate::SavingsVaultClient;

const DEPOSIT: i128 = 1_000_000;
const WITHDRAW: i128 = 400_000;

/// Mock oracle: returns whatever price the test last set.
#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_price(env: Env, price: i128) {
        env.storage()
            .instance()
            .set(&symbol_short!("price"), &price);
    }

    pub fn price(env: Env, _asset: Address) -> i128 {
        env.storage()
            .instance()
            .get(&symbol_short!("price"))
            .unwrap_or(0)
    }
}

/// Vault + an owner with a funded flexible account.
fn setup(env: &Env) -> (SavingsVaultClient<'_>, Address, Address, Address, Address) {
    env.mock_all_auths();
    let (client, admin, token, vault) = setup_with_token_and_id(env);
    let owner = Address::generate(env);
    set_ledger_time(env, 1_000, 1);
    mint(env, &token, &admin, &owner, DEPOSIT);
    client.deposit(&owner, &DEPOSIT);
    (client, admin, token, vault, owner)
}

fn setup_oracle<'a>(
    env: &'a Env,
    client: &SavingsVaultClient,
    admin: &Address,
) -> MockOracleClient<'a> {
    let oracle_id = env.register(MockOracle, ());
    let oracle = MockOracleClient::new(env, &oracle_id);
    client.set_price_oracle(admin, &oracle_id);
    oracle
}

#[test]
fn conditions_stored_correctly() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner) = setup(&env);

    let condition = WithdrawalCondition::AfterDate(5_000);
    client.set_withdrawal_condition(&owner, &condition, &WITHDRAW);

    assert_eq!(
        client.withdrawal_condition(&owner),
        Some(ConditionalWithdrawalRule {
            owner: owner.clone(),
            condition,
            amount: WITHDRAW,
            created_at: 1_000,
        })
    );

    client.cancel_withdrawal_condition(&owner);
    assert_eq!(client.withdrawal_condition(&owner), None);
}

#[test]
fn invalid_conditions_rejected() {
    let env = Env::default();
    let (client, admin, _token, _vault, owner) = setup(&env);
    let asset = Address::generate(&env);

    assert_eq!(
        client.try_set_withdrawal_condition(
            &owner,
            &WithdrawalCondition::AfterDate(1_000),
            &WITHDRAW
        ),
        Err(Ok(Error::InvalidCondition))
    );
    assert_eq!(
        client.try_set_withdrawal_condition(
            &owner,
            &WithdrawalCondition::BalanceAbove(-1),
            &WITHDRAW
        ),
        Err(Ok(Error::InvalidCondition))
    );
    assert_eq!(
        client.try_set_withdrawal_condition(&owner, &WithdrawalCondition::AfterDate(5_000), &0),
        Err(Ok(Error::InvalidAmount))
    );
    // Price conditions need an oracle.
    assert_eq!(
        client.try_set_withdrawal_condition(
            &owner,
            &WithdrawalCondition::PriceAbove(asset.clone(), 100),
            &WITHDRAW
        ),
        Err(Ok(Error::OracleUnavailable))
    );
    setup_oracle(&env, &client, &admin);
    assert_eq!(
        client.try_set_withdrawal_condition(
            &owner,
            &WithdrawalCondition::PriceAbove(asset, 0),
            &WITHDRAW
        ),
        Err(Ok(Error::InvalidCondition))
    );
}

#[test]
fn price_condition_validated_via_oracle() {
    let env = Env::default();
    let (client, admin, token, _vault, owner) = setup(&env);
    let oracle = setup_oracle(&env, &client, &admin);
    let asset = Address::generate(&env);

    client.set_withdrawal_condition(
        &owner,
        &WithdrawalCondition::PriceAbove(asset, 2_000),
        &WITHDRAW,
    );

    oracle.set_price(&2_000); // equal is not "above"
    assert_eq!(
        client.try_execute_conditional_withdrawal(&owner),
        Err(Ok(Error::ConditionNotMet))
    );

    oracle.set_price(&2_001);
    assert_eq!(client.execute_conditional_withdrawal(&owner), WITHDRAW);
    assert_eq!(TokenClient::new(&env, &token).balance(&owner), WITHDRAW);
    assert_eq!(client.get_account(&owner).balance, DEPOSIT - WITHDRAW);
}

#[test]
fn date_condition_checks_timestamp() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner) = setup(&env);

    client.set_withdrawal_condition(&owner, &WithdrawalCondition::AfterDate(5_000), &WITHDRAW);

    set_ledger_time(&env, 4_999, 2);
    assert_eq!(
        client.try_execute_conditional_withdrawal(&owner),
        Err(Ok(Error::ConditionNotMet))
    );

    set_ledger_time(&env, 5_000, 3);
    assert_eq!(client.execute_conditional_withdrawal(&owner), WITHDRAW);
}

#[test]
fn balance_condition_checks_amount() {
    let env = Env::default();
    let (client, admin, token, _vault, owner) = setup(&env);

    client.set_withdrawal_condition(
        &owner,
        &WithdrawalCondition::BalanceAbove(DEPOSIT),
        &WITHDRAW,
    );
    assert_eq!(
        client.try_execute_conditional_withdrawal(&owner),
        Err(Ok(Error::ConditionNotMet))
    );

    mint(&env, &token, &admin, &owner, 1);
    client.deposit(&owner, &1);
    assert_eq!(client.execute_conditional_withdrawal(&owner), WITHDRAW);
    assert_eq!(client.get_account(&owner).balance, DEPOSIT + 1 - WITHDRAW);
}

#[test]
fn withdrawals_blocked_until_condition_met_and_are_one_shot() {
    let env = Env::default();
    let (client, _admin, token, _vault, owner) = setup(&env);
    let token_client = TokenClient::new(&env, &token);

    client.set_withdrawal_condition(&owner, &WithdrawalCondition::AfterDate(5_000), &WITHDRAW);
    assert_eq!(
        client.try_execute_conditional_withdrawal(&owner),
        Err(Ok(Error::ConditionNotMet))
    );
    assert_eq!(token_client.balance(&owner), 0);
    assert_eq!(client.get_account(&owner).balance, DEPOSIT);

    set_ledger_time(&env, 5_000, 2);
    client.execute_conditional_withdrawal(&owner);
    // The rule is consumed: a second execution has nothing to run.
    assert_eq!(client.withdrawal_condition(&owner), None);
    assert_eq!(
        client.try_execute_conditional_withdrawal(&owner),
        Err(Ok(Error::NotFound))
    );
    assert_eq!(token_client.balance(&owner), WITHDRAW);
}

#[test]
fn conditional_withdrawal_requires_sufficient_balance() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner) = setup(&env);

    client.set_withdrawal_condition(&owner, &WithdrawalCondition::AfterDate(5_000), &WITHDRAW);
    client.withdraw(&owner, &(DEPOSIT - 1));

    set_ledger_time(&env, 5_000, 2);
    assert_eq!(
        client.try_execute_conditional_withdrawal(&owner),
        Err(Ok(Error::InsufficientBalance))
    );
}

#[test]
fn only_admin_sets_oracle() {
    let env = Env::default();
    let (client, _admin, _token, _vault, _owner) = setup(&env);
    let stranger = Address::generate(&env);
    let oracle = Address::generate(&env);

    assert_eq!(
        client.try_set_price_oracle(&stranger, &oracle),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.price_oracle(), None);
}

#[test]
fn event_includes_condition_details() {
    let env = Env::default();
    let (client, admin, _token, vault, owner) = setup(&env);
    let oracle = setup_oracle(&env, &client, &admin);
    let asset = Address::generate(&env);
    let condition = WithdrawalCondition::PriceAbove(asset, 2_000);

    client.set_withdrawal_condition(&owner, &condition, &WITHDRAW);
    oracle.set_price(&2_500);
    client.execute_conditional_withdrawal(&owner);

    let event = test_events(&env)
        .into_iter()
        .rev()
        .find(|e| {
            e.contract == vault
                && e.topics.get(0).and_then(|t| t.as_symbol()).as_deref()
                    == Some("ConditionalWithdrawal")
        })
        .expect("ConditionalWithdrawal event emitted");
    assert_eq!(
        event.topics.get(1).and_then(|t| t.as_address()),
        Some(owner.clone())
    );

    let (_, _, data) = event.into_parts();
    let (emitted_owner, amount, emitted_condition, observed, new_balance, _now) =
        <(Address, i128, WithdrawalCondition, i128, i128, u64)>::try_from_val(&env, &data).unwrap();
    assert_eq!(emitted_owner, owner);
    assert_eq!(amount, WITHDRAW);
    assert_eq!(emitted_condition, condition);
    assert_eq!(observed, 2_500);
    assert_eq!(new_balance, DEPOSIT - WITHDRAW);
}
