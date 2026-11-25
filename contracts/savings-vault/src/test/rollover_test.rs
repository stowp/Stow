//! Locked savings auto-rollover (#638).

use soroban_sdk::{
    testutils::Address as _, token::Client as TokenClient, Address, Env, TryFromVal,
};

use super::{mint, set_ledger_time, setup_with_token_and_id, test_events};
use crate::error::Error;
use crate::SavingsVaultClient;

const YEAR: u64 = 31_536_000;
const PRINCIPAL: i128 = 1_000_000;

/// Vault + funded owner with one locked plan maturing a year from `start`.
fn setup_plan(
    env: &Env,
) -> (
    SavingsVaultClient<'_>,
    Address,
    Address,
    Address,
    Address,
    u64,
    u64,
) {
    env.mock_all_auths();
    let (client, admin, token, vault) = setup_with_token_and_id(env);
    let owner = Address::generate(env);
    let start = 1_000u64;
    set_ledger_time(env, start, 1);
    mint(env, &token, &admin, &owner, PRINCIPAL);
    let plan_id = client.locked_create(&owner, &PRINCIPAL, &(start + YEAR));
    (client, admin, token, vault, owner, plan_id, start)
}

fn fund_rewards(
    env: &Env,
    client: &SavingsVaultClient,
    admin: &Address,
    token: &Address,
    amount: i128,
) {
    mint(env, token, admin, admin, amount);
    client.reward_fund(admin, &amount);
}

#[test]
fn rollover_creates_new_vault_at_maturity() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner, plan_id, start) = setup_plan(&env);

    client.enable_auto_rollover(&owner, &plan_id, &0);
    let config = client.rollover_config(&plan_id).unwrap();
    assert_eq!(config.owner, owner);
    assert_eq!(config.lock_period, 0);

    set_ledger_time(&env, start + YEAR, 2);
    let new_id = client.execute_rollover(&plan_id);

    assert_ne!(new_id, plan_id);
    let new_plan = client.locked_plan(&new_id);
    assert_eq!(new_plan.owner, owner);
    // `0` reuses the original one-year term, starting at maturity.
    assert_eq!(new_plan.created_at, start + YEAR);
    assert_eq!(new_plan.unlock_at, start + 2 * YEAR);
}

#[test]
fn rollover_transfers_balance_completely_and_closes_original() {
    let env = Env::default();
    let (client, _admin, token, vault, owner, plan_id, start) = setup_plan(&env);
    let token_client = TokenClient::new(&env, &token);

    client.enable_auto_rollover(&owner, &plan_id, &0);
    set_ledger_time(&env, start + YEAR, 2);
    let vault_before = token_client.balance(&vault);

    let new_id = client.execute_rollover(&plan_id);

    // No interest configured: the full principal moves, nothing more.
    assert_eq!(client.locked_plan(&new_id).balance, PRINCIPAL);
    // The original plan is closed with nothing left to withdraw.
    assert_eq!(client.locked_plan(&plan_id).balance, 0);
    assert_eq!(
        client.try_locked_withdraw(&owner, &plan_id, &1),
        Err(Ok(Error::InsufficientBalance))
    );
    // Funds never left the vault.
    assert_eq!(token_client.balance(&vault), vault_before);
    assert_eq!(token_client.balance(&owner), 0);
    // The original plan can't be rolled twice.
    assert_eq!(
        client.try_execute_rollover(&plan_id),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn rollover_includes_accrued_interest() {
    let env = Env::default();
    let (client, admin, token, _vault, owner, plan_id, start) = setup_plan(&env);

    client.set_interest_rate(&admin, &1_000); // 10% APR
    fund_rewards(&env, &client, &admin, &token, 500_000);
    client.enable_auto_rollover(&owner, &plan_id, &0);

    set_ledger_time(&env, start + YEAR, 2);
    let new_id = client.execute_rollover(&plan_id);

    let expected_interest = PRINCIPAL / 10;
    assert_eq!(
        client.locked_plan(&new_id).balance,
        PRINCIPAL + expected_interest
    );
    assert_eq!(client.reward_pool_balance(), 500_000 - expected_interest);
}

#[test]
fn rollover_interest_is_capped_by_reward_pool() {
    let env = Env::default();
    let (client, admin, token, _vault, owner, plan_id, start) = setup_plan(&env);

    client.set_interest_rate(&admin, &1_000);
    fund_rewards(&env, &client, &admin, &token, 25_000);
    client.enable_auto_rollover(&owner, &plan_id, &0);

    set_ledger_time(&env, start + YEAR, 2);
    let new_id = client.execute_rollover(&plan_id);

    assert_eq!(client.locked_plan(&new_id).balance, PRINCIPAL + 25_000);
    assert_eq!(client.reward_pool_balance(), 0);
}

#[test]
fn rollover_uses_configured_lock_period() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner, plan_id, start) = setup_plan(&env);
    let custom = 30 * 86_400u64;

    client.enable_auto_rollover(&owner, &plan_id, &custom);
    set_ledger_time(&env, start + YEAR + 10, 2);
    let new_id = client.execute_rollover(&plan_id);

    assert_eq!(
        client.locked_plan(&new_id).unlock_at,
        start + YEAR + 10 + custom
    );
    // The setting carries forward to the new plan.
    assert_eq!(client.rollover_config(&new_id).unwrap().lock_period, custom);
    assert!(client.rollover_config(&plan_id).is_none());
}

#[test]
fn rollover_rejected_before_maturity() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner, plan_id, start) = setup_plan(&env);

    client.enable_auto_rollover(&owner, &plan_id, &0);
    set_ledger_time(&env, start + YEAR - 1, 2);

    assert_eq!(
        client.try_execute_rollover(&plan_id),
        Err(Ok(Error::StillLocked))
    );
}

#[test]
fn opt_out_prevents_rollover() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner, plan_id, start) = setup_plan(&env);

    client.enable_auto_rollover(&owner, &plan_id, &0);
    client.disable_auto_rollover(&owner, &plan_id);
    assert!(client.rollover_config(&plan_id).is_none());

    set_ledger_time(&env, start + YEAR, 2);
    assert_eq!(
        client.try_execute_rollover(&plan_id),
        Err(Ok(Error::NotFound))
    );
    // The owner can withdraw as normal instead.
    client.locked_withdraw(&owner, &plan_id, &PRINCIPAL);
    assert_eq!(client.locked_plan(&plan_id).balance, 0);
}

#[test]
fn opt_out_rejected_after_maturity() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner, plan_id, start) = setup_plan(&env);

    client.enable_auto_rollover(&owner, &plan_id, &0);
    set_ledger_time(&env, start + YEAR, 2);

    assert_eq!(
        client.try_disable_auto_rollover(&owner, &plan_id),
        Err(Ok(Error::OperationExpired))
    );
}

#[test]
fn enable_rollover_rejects_non_owner_and_matured_plan() {
    let env = Env::default();
    let (client, _admin, _token, _vault, owner, plan_id, start) = setup_plan(&env);
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_enable_auto_rollover(&stranger, &plan_id, &0),
        Err(Ok(Error::Unauthorized))
    );

    set_ledger_time(&env, start + YEAR, 2);
    assert_eq!(
        client.try_enable_auto_rollover(&owner, &plan_id, &0),
        Err(Ok(Error::OperationExpired))
    );
}

#[test]
fn rollover_event_includes_new_vault_id() {
    let env = Env::default();
    let (client, admin, token, vault, owner, plan_id, start) = setup_plan(&env);

    client.set_interest_rate(&admin, &1_000);
    fund_rewards(&env, &client, &admin, &token, 500_000);
    client.enable_auto_rollover(&owner, &plan_id, &0);
    set_ledger_time(&env, start + YEAR, 2);
    let new_id = client.execute_rollover(&plan_id);

    let event = test_events(&env)
        .into_iter()
        .rev()
        .find(|e| {
            e.contract == vault
                && e.topics.get(0).and_then(|t| t.as_symbol()).as_deref() == Some("VaultRolledOver")
        })
        .expect("VaultRolledOver event emitted");

    assert_eq!(
        event.topics.get(1).and_then(|t| t.as_address()),
        Some(owner)
    );
    assert_eq!(event.topics.get(2).and_then(|t| t.as_u64()), Some(plan_id));

    let (_, _, data) = event.into_parts();
    let (old_id, emitted_new_id, principal, interest, new_balance, new_unlock_at, _now) =
        <(u64, u64, i128, i128, i128, u64, u64)>::try_from_val(&env, &data).unwrap();
    assert_eq!(old_id, plan_id);
    assert_eq!(emitted_new_id, new_id);
    assert_eq!(principal, PRINCIPAL);
    assert_eq!(interest, PRINCIPAL / 10);
    assert_eq!(new_balance, PRINCIPAL + PRINCIPAL / 10);
    assert_eq!(new_unlock_at, start + 2 * YEAR);
}
