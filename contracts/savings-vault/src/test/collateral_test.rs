//! Savings vault loan collateralization — issue #645.
//!
//! Tests cover: enabling/disabling, ratio enforcement on borrows (exact
//! limit and one unit over), withdrawal lock on every path, liquidation at
//! the threshold, event emission, multi-vault loans, lender authorization,
//! and the borrow-after-interest-accrual case.

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, TryFromVal, Val,
};

extern crate std;
use std::string::ToString;

use crate::collateral::{DEFAULT_BORROW_RATIO_BPS, DEFAULT_LIQUIDATION_RATIO_BPS};
use crate::error::Error;
use crate::events::{
    TOPIC_COLLATERAL_ENABLED, TOPIC_COLLATERAL_LIQUIDATED, TOPIC_COLLATERAL_USED,
};
use crate::{SavingsVault, SavingsVaultClient};

const UNIT: i128 = 10_000_000; // 1 token (7 decimals)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    client: SavingsVaultClient<'a>,
    token: Address,
    admin: Address,
}

fn ctx(env: &Env) -> Ctx<'_> {
    env.mock_all_auths();
    let client = SavingsVaultClient::new(env, &env.register(SavingsVault, ()));
    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    client.initialize(&admin, &token);
    Ctx {
        client,
        token,
        admin,
    }
}

fn mint(env: &Env, token: &Address, recipient: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(recipient, &amount);
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

fn fund_flexible(env: &Env, c: &Ctx, owner: &Address, amount: i128) {
    mint(env, &c.token, owner, amount);
    c.client.deposit(owner, &amount);
}

fn setup_vault_and_lender(env: &Env, c: &Ctx, balance: i128) -> (Address, Address) {
    let lender = Address::generate(env);
    let owner = Address::generate(env);
    c.client.register_lender(&c.admin, &lender);
    fund_flexible(env, c, &owner, balance);
    (owner, lender)
}

/// Soroban 22 events are `(Address, Vec<Val>, Val)` tuples.
/// Match the first topic element against a string name.
/// String topics published via `env.events().publish` can be compared via
/// `IntoVal` conversion back through the environment.
fn topic_matches(env: &Env, topics: &soroban_sdk::Vec<Val>, name: &str) -> bool {
    if let Some(first) = topics.get(0) {
        // Try to match as soroban_sdk::String.
        if let Ok(s) = soroban_sdk::String::try_from_val(env, &first) {
            return s.to_string() == name;
        }
        // Also try as Symbol (some older code publishes symbols).
        if let Ok(sym) = soroban_sdk::Symbol::try_from_val(env, &first) {
            return sym.to_string() == name;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

#[test]
fn enable_as_collateral_succeeds() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, _lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    let loan_id = c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    assert!(loan_id > 0, "a new loan id must be allocated");

    let state = c.client.collateral_state(&owner);
    assert_eq!(state.owner, owner);
    assert!(state.enabled);
    assert_eq!(state.loan_id, loan_id);
    assert_eq!(state.borrowed, 0);
    assert_eq!(state.borrow_ratio_bps, DEFAULT_BORROW_RATIO_BPS);
    assert_eq!(state.liquidation_ratio_bps, DEFAULT_LIQUIDATION_RATIO_BPS);
}

#[test]
fn enable_twice_rejected() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, _lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    let result = c.client.try_enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    assert_eq!(result, Err(Ok(Error::CollateralAlreadyEnabled)));
}

#[test]
fn disable_only_works_with_zero_debt() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));

    // Cannot disable while in debt.
    assert_eq!(
        c.client.try_disable_collateral(&owner),
        Err(Ok(Error::CollateralLimitExceeded))
    );

    // Repay, then disable works.
    c.client.collateral_repay(&lender, &owner, &(80 * UNIT));
    c.client.disable_collateral(&owner);

    let state = c.client.collateral_state(&owner);
    assert!(!state.enabled);
    assert_eq!(state.loan_id, 0);
}

#[test]
fn enable_on_vault_with_no_balance_rejected() {
    let env = Env::default();
    let c = ctx(&env);
    let owner = Address::generate(&env);

    let result = c.client.try_enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    assert_eq!(result, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn invalid_ratios_rejected() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, _lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    // borrow_ratio == 0
    assert_eq!(
        c.client
            .try_enable_as_collateral(&owner, &0, &0, &DEFAULT_LIQUIDATION_RATIO_BPS),
        Err(Ok(Error::InvalidParameters))
    );
    // liquidation_ratio <= borrow_ratio
    assert_eq!(
        c.client
            .try_enable_as_collateral(&owner, &0, &9_000, &9_000),
        Err(Ok(Error::InvalidParameters))
    );
    // borrow_ratio too high (> 9_500)
    assert_eq!(
        c.client
            .try_enable_as_collateral(&owner, &0, &9_501, &9_600),
        Err(Ok(Error::InvalidParameters))
    );
}

// ---------------------------------------------------------------------------
// Ratio enforcement on borrows
// ---------------------------------------------------------------------------

#[test]
fn borrow_at_exact_limit_succeeds() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    // max_borrow = 100 * 8_000 / 10_000 = 80 UNIT exactly.
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));
    assert_eq!(c.client.collateral_state(&owner).borrowed, 80 * UNIT);
}

#[test]
fn borrow_one_unit_over_limit_rejected() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    // 80 * UNIT + 1 exceeds max_borrow of 80 * UNIT.
    let result = c
        .client
        .try_collateral_borrow(&lender, &owner, &(80 * UNIT + 1));
    assert_eq!(result, Err(Ok(Error::CollateralLimitExceeded)));
    assert_eq!(c.client.collateral_state(&owner).borrowed, 0);
}

#[test]
fn borrow_accumulates_to_limit() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(30 * UNIT));
    c.client.collateral_borrow(&lender, &owner, &(50 * UNIT));
    assert_eq!(c.client.collateral_state(&owner).borrowed, 80 * UNIT);

    // One more stroop exceeds the limit.
    assert_eq!(
        c.client.try_collateral_borrow(&lender, &owner, &1),
        Err(Ok(Error::CollateralLimitExceeded))
    );
}

// ---------------------------------------------------------------------------
// Withdrawal lock — flexible path
// ---------------------------------------------------------------------------

#[test]
fn withdrawal_blocked_by_collateral() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    // Borrow 80 UNIT → min_locked = ceil(80 * 10_000 / 8_000) = 100 UNIT.
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));

    // Any withdrawal leaves balance < 100 → blocked.
    assert_eq!(
        c.client.try_withdraw(&owner, &UNIT),
        Err(Ok(Error::CollateralWithdrawalBlocked))
    );

    // Repay 10 → min_locked = ceil(70 * UNIT * 10_000 / 8_000) = 875_000_000 stroops (87.5 UNIT).
    // Balance 100 UNIT = 1_000_000_000 stroops; free = 1_000_000_000 - 875_000_000 = 125_000_000 (12.5 UNIT).
    // Withdraw exactly 12.5 UNIT → leaves 87.5 UNIT = min_locked → OK.
    c.client.collateral_repay(&lender, &owner, &(10 * UNIT));
    let min_locked: i128 = 875_000_000; // ceil(70 * UNIT * 10_000 / 8_000)
    let free = 100 * UNIT - min_locked; // 125_000_000 (12.5 UNIT)
    c.client.withdraw(&owner, &free);
    assert_eq!(c.client.get_account(&owner).balance, min_locked);

    // One stroop more would leave min_locked - 1 < min_locked → blocked.
    assert_eq!(
        c.client.try_withdraw(&owner, &1),
        Err(Ok(Error::CollateralWithdrawalBlocked))
    );
}

#[test]
fn withdrawal_free_when_no_collateral() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, _lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);
    // No collateral → full withdrawal allowed.
    c.client.withdraw(&owner, &(100 * UNIT));
    assert_eq!(c.client.get_account(&owner).balance, 0);
}

#[test]
fn withdrawal_works_again_after_full_repay() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    // Borrow 50 → min_locked = ceil(50 * 10_000 / 8_000) = 63 UNIT.
    c.client.collateral_borrow(&lender, &owner, &(50 * UNIT));
    // Withdraw 37 (100 − 37 = 63 = min_locked) → OK.
    c.client.withdraw(&owner, &(37 * UNIT));
    assert_eq!(c.client.get_account(&owner).balance, 63 * UNIT);

    // Fully repay → no lock.
    c.client.collateral_repay(&lender, &owner, &(50 * UNIT));
    c.client.withdraw(&owner, &(63 * UNIT));
    assert_eq!(c.client.get_account(&owner).balance, 0);
}

// ---------------------------------------------------------------------------
// Liquidation
// ---------------------------------------------------------------------------

#[test]
fn liquidation_healthy_position_rejected() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    // 80 UNIT borrowed; threshold = 90 UNIT → still healthy.
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));
    assert_eq!(
        c.client.try_liquidate(&owner),
        Err(Ok(Error::PositionHealthy))
    );
}

#[test]
fn liquidation_triggers_past_threshold() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    let loan_id = c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));

    // 80% borrowed / 100% balance < 90% liquidation threshold → healthy.
    assert_eq!(
        c.client.try_liquidate(&owner),
        Err(Ok(Error::PositionHealthy))
    );

    // Simulate collateral balance drop below liquidation threshold:
    // e.g. balance drops to 85 UNIT.
    // 80 UNIT borrowed * 10_000 = 800_000 > 85 UNIT balance * 9_000 = 765_000.
    env.as_contract(&c.client.address, || {
        let key = crate::types::DataKey::Flexible(owner.clone());
        let mut acc: crate::types::FlexibleAccount = env.storage().persistent().get(&key).unwrap();
        acc.balance = 85 * UNIT;
        env.storage().persistent().set(&key, &acc);
    });

    // Liquidation now triggers and succeeds.
    c.client.liquidate(&owner);

    // Position debt is cleared and vault balance is debited.
    let state = c.client.collateral_state(&owner);
    assert_eq!(state.borrowed, 0);

    let loan = c.client.loan_record(&loan_id);
    assert_eq!(loan.total_borrowed, 0);

    // Balance was debited by seized amount (min(85 UNIT, min_locked 100 UNIT) = 85 UNIT).
    assert_eq!(c.client.get_account(&owner).balance, 0);
}

#[test]
fn liquidation_seizes_min_of_balance_and_locked() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    let _loan_id = c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));

    // Verify healthy position cannot be liquidated.
    assert_eq!(
        c.client.try_liquidate(&owner),
        Err(Ok(Error::PositionHealthy))
    );

    // Simulate balance reduction to 85 UNIT (below 90% threshold for 80 UNIT debt).
    env.as_contract(&c.client.address, || {
        let key = crate::types::DataKey::Flexible(owner.clone());
        let mut acc: crate::types::FlexibleAccount = env.storage().persistent().get(&key).unwrap();
        acc.balance = 85 * UNIT;
        env.storage().persistent().set(&key, &acc);
    });

    let token_client = TokenClient::new(&env, &c.token);
    let lender_bal_before = token_client.balance(&lender);

    // Liquidate. min(balance = 85 UNIT, min_locked = 100 UNIT) -> 85 UNIT seized and sent to lender.
    c.client.liquidate(&owner);

    let lender_bal_after = token_client.balance(&lender);
    assert_eq!(lender_bal_after - lender_bal_before, 85 * UNIT);
    assert_eq!(c.client.get_account(&owner).balance, 0);
}

#[test]
fn collateral_enabled_event_emitted() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, _lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );

    let events = env.events().all();
    let found = events
        .iter()
        .any(|(_contract, topics, _data)| topic_matches(&env, &topics, TOPIC_COLLATERAL_ENABLED));
    assert!(found, "collateral_enabled event must be emitted");
}

#[test]
fn collateral_used_event_emitted() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(40 * UNIT));

    let events = env.events().all();
    let found = events
        .iter()
        .any(|(_contract, topics, _data)| topic_matches(&env, &topics, TOPIC_COLLATERAL_USED));
    assert!(found, "collateral_used event must be emitted");
}

#[test]
fn collateral_liquidated_event_emitted() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    let _loan_id = c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));

    // Drop balance so it crosses liquidation threshold.
    env.as_contract(&c.client.address, || {
        let key = crate::types::DataKey::Flexible(owner.clone());
        let mut acc: crate::types::FlexibleAccount = env.storage().persistent().get(&key).unwrap();
        acc.balance = 85 * UNIT;
        env.storage().persistent().set(&key, &acc);
    });

    c.client.liquidate(&owner);

    let events = env.events().all();
    let found = events
        .iter()
        .any(|(_contract, topics, _data)| topic_matches(&env, &topics, TOPIC_COLLATERAL_LIQUIDATED));
    assert!(found, "collateral_liquidated event must be emitted");
}

#[test]
fn collateral_repaid_event_emitted() {
    use crate::events::TOPIC_COLLATERAL_REPAID;
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));
    c.client.collateral_repay(&lender, &owner, &(80 * UNIT));

    let events = env.events().all();
    let found = events
        .iter()
        .any(|(_c, topics, _d)| topic_matches(&env, &topics, TOPIC_COLLATERAL_REPAID));
    assert!(found, "collateral_repaid event must be emitted");
}

// ---------------------------------------------------------------------------
// Multi-vault loans
// ---------------------------------------------------------------------------

#[test]
fn multiple_vaults_backing_same_loan() {
    let env = Env::default();
    let c = ctx(&env);
    let lender = Address::generate(&env);
    c.client.register_lender(&c.admin, &lender);

    let owner_a = Address::generate(&env);
    let owner_b = Address::generate(&env);
    fund_flexible(&env, &c, &owner_a, 100 * UNIT);
    fund_flexible(&env, &c, &owner_b, 200 * UNIT);

    // owner_a creates the loan.
    let loan_id = c.client.enable_as_collateral(
        &owner_a,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    // owner_b joins the existing loan.
    let loan_id_b = c.client.enable_as_collateral(
        &owner_b,
        &loan_id,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    assert_eq!(loan_id, loan_id_b, "both vaults back the same loan");

    // max_borrow A = 80 UNIT, max_borrow B = 160 UNIT.
    c.client.collateral_borrow(&lender, &owner_a, &(80 * UNIT));
    c.client.collateral_borrow(&lender, &owner_b, &(160 * UNIT));

    let loan = c.client.loan_record(&loan_id);
    assert_eq!(loan.total_borrowed, 240 * UNIT);

    let vaults = c.client.loan_vaults(&loan_id);
    assert_eq!(vaults.len(), 2);

    // Repay A fully and verify loan total decreases correctly.
    c.client.collateral_repay(&lender, &owner_a, &(80 * UNIT));
    assert_eq!(c.client.collateral_state(&owner_a).borrowed, 0);
    let loan = c.client.loan_record(&loan_id);
    assert_eq!(loan.total_borrowed, 160 * UNIT);
}

#[test]
fn vault_cannot_be_enabled_twice() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, _lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    assert_eq!(
        c.client.try_enable_as_collateral(
            &owner,
            &0,
            &DEFAULT_BORROW_RATIO_BPS,
            &DEFAULT_LIQUIDATION_RATIO_BPS,
        ),
        Err(Ok(Error::CollateralAlreadyEnabled))
    );
}

// ---------------------------------------------------------------------------
// Authorization negative tests
// ---------------------------------------------------------------------------

#[test]
fn unregistered_lender_cannot_borrow() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, _lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    let fake_lender = Address::generate(&env);
    assert_eq!(
        c.client
            .try_collateral_borrow(&fake_lender, &owner, &(10 * UNIT)),
        Err(Ok(Error::NotRegisteredLender))
    );
}

#[test]
fn unregistered_lender_cannot_repay() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(50 * UNIT));

    let fake_lender = Address::generate(&env);
    assert_eq!(
        c.client
            .try_collateral_repay(&fake_lender, &owner, &(10 * UNIT)),
        Err(Ok(Error::NotRegisteredLender))
    );
}

#[test]
fn borrow_on_disabled_vault_rejected() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);
    // No enable call → NotFound.
    assert_eq!(
        c.client
            .try_collateral_borrow(&lender, &owner, &(10 * UNIT)),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn repay_more_than_borrowed_rejected() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(50 * UNIT));
    assert_eq!(
        c.client.try_collateral_repay(&lender, &owner, &(60 * UNIT)),
        Err(Ok(Error::InsufficientBalance))
    );
}

#[test]
fn non_admin_cannot_register_lender() {
    let env = Env::default();
    let c = ctx(&env);
    let attacker = Address::generate(&env);
    let lender = Address::generate(&env);
    assert_eq!(
        c.client.try_register_lender(&attacker, &lender),
        Err(Ok(Error::Unauthorized))
    );
}

// ---------------------------------------------------------------------------
// Borrow after interest accrual uses fresh balance
// ---------------------------------------------------------------------------

#[test]
fn borrow_after_interest_accrual_uses_fresh_balance() {
    let env = Env::default();
    let c = ctx(&env);

    // 10% annual interest.
    c.client.set_interest_rate(&c.admin, &1_000);

    let owner = Address::generate(&env);
    let lender = Address::generate(&env);
    c.client.register_lender(&c.admin, &lender);

    // Deposit 100 UNIT into the interest account.
    mint(&env, &c.token, &owner, 100 * UNIT);
    c.client.interest_deposit(&owner, &(100 * UNIT));

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );

    // Advance one year so 10% interest accrues.
    set_ledger(&env, env.ledger().timestamp() + 31_536_000);

    // Claim settles interest into principal → ~110 UNIT.
    c.client.interest_claim(&owner);
    let account = c.client.interest_account(&owner);
    // Principal is at least 109 UNIT (conservative due to rounding).
    assert!(account.principal > 100 * UNIT);

    // max_borrow at ~110 UNIT balance = 110 * 8_000 / 10_000 = 88 UNIT.
    // Borrow up to the new limit should succeed.
    let borrow_amount = account.principal * 8_000 / 10_000;
    c.client.collateral_borrow(&lender, &owner, &borrow_amount);
    assert_eq!(c.client.collateral_state(&owner).borrowed, borrow_amount);

    // One more stroop exceeds the limit.
    assert_eq!(
        c.client.try_collateral_borrow(&lender, &owner, &1),
        Err(Ok(Error::CollateralLimitExceeded))
    );
}

#[test]
fn interest_withdrawal_respects_collateral_lock() {
    let env = Env::default();
    let c = ctx(&env);

    let owner = Address::generate(&env);
    let lender = Address::generate(&env);
    c.client.register_lender(&c.admin, &lender);

    mint(&env, &c.token, &owner, 100 * UNIT);
    c.client.interest_deposit(&owner, &(100 * UNIT));

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    // Borrow 80 UNIT → min_locked = 100 UNIT.
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));

    // Any withdrawal blocked.
    assert_eq!(
        c.client.try_interest_withdraw(&owner, &UNIT),
        Err(Ok(Error::CollateralWithdrawalBlocked))
    );

    // Repay 40 → min_locked = ceil(40 * 10_000 / 8_000) = 50 UNIT.
    c.client.collateral_repay(&lender, &owner, &(40 * UNIT));
    // Withdraw 50 → leaves 50 == min_locked → OK.
    c.client.interest_withdraw(&owner, &(50 * UNIT));
    assert_eq!(c.client.interest_account(&owner).principal, 50 * UNIT);
}

#[test]
fn delegate_withdrawal_respects_collateral_lock() {
    let env = Env::default();
    let c = ctx(&env);
    let (owner, lender) = setup_vault_and_lender(&env, &c, 100 * UNIT);
    let delegate = Address::generate(&env);

    // Grant delegation directly
    env.as_contract(&c.client.address, || {
        crate::delegation::delegate_savings(
            &env,
            owner.clone(),
            delegate.clone(),
            crate::types::PermissionLevel::Full,
            None,
        )
        .unwrap();
    });

    c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    // Borrow 80 UNIT → min_locked = 100 UNIT.
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));

    // Delegate withdrawal is blocked by collateral lock.
    let result = env.as_contract(&c.client.address, || {
        crate::delegation::delegated_withdraw(&env, delegate, owner, UNIT)
    });
    assert_eq!(result, Err(Error::CollateralWithdrawalBlocked));
}

#[test]
fn interest_vault_liquidation() {
    let env = Env::default();
    let c = ctx(&env);

    let owner = Address::generate(&env);
    let lender = Address::generate(&env);
    c.client.register_lender(&c.admin, &lender);

    mint(&env, &c.token, &owner, 100 * UNIT);
    c.client.interest_deposit(&owner, &(100 * UNIT));

    let loan_id = c.client.enable_as_collateral(
        &owner,
        &0,
        &DEFAULT_BORROW_RATIO_BPS,
        &DEFAULT_LIQUIDATION_RATIO_BPS,
    );
    c.client.collateral_borrow(&lender, &owner, &(80 * UNIT));

    // Drop principal in interest account below liquidation threshold.
    env.as_contract(&c.client.address, || {
        let key = crate::types::DataKey::InterestAccount(owner.clone());
        let mut acc: crate::types::InterestAccount = env.storage().persistent().get(&key).unwrap();
        acc.principal = 85 * UNIT;
        env.storage().persistent().set(&key, &acc);
    });

    let token_client = TokenClient::new(&env, &c.token);
    let lender_bal_before = token_client.balance(&lender);

    c.client.liquidate(&owner);

    let lender_bal_after = token_client.balance(&lender);
    assert_eq!(lender_bal_after - lender_bal_before, 85 * UNIT);
    assert_eq!(c.client.interest_account(&owner).principal, 0);
    assert_eq!(c.client.collateral_state(&owner).borrowed, 0);
    assert_eq!(c.client.loan_record(&loan_id).total_borrowed, 0);
}
