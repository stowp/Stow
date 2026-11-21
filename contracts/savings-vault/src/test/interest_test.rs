//! Tests for tiered interest rates (#619).
//!
//! Covers:
//! - Correct base rate selected per balance tier
//! - Lock-period bonus calculated correctly
//! - Effective rate = base + bonus
//! - Rate updates on balance change that crosses a tier threshold
//! - `InterestRateChanged` event emitted on rate change
//! - `query_interest_rate` view function returns accurate rate
//! - Edge cases: exactly at tier boundary

use soroban_sdk::{testutils::Address as _, testutils::Ledger, testutils::LedgerInfo, token::StellarAssetClient, Address, Env};

use crate::interest_tiers::{
    effective_rate_bps, BALANCE_TIER_HIGH_THRESHOLD, BALANCE_TIER_LOW_THRESHOLD,
    DEFAULT_TIER_HIGH_RATE_BPS, DEFAULT_TIER_LOW_RATE_BPS, DEFAULT_TIER_MID_RATE_BPS,
    DEFAULT_LOCK_3MO_MIN_BONUS_BPS, DEFAULT_LOCK_6MO_BONUS_BPS, DEFAULT_LOCK_12MO_BONUS_BPS,
    LOCK_3_MONTHS_SECS, LOCK_6_MONTHS_SECS, LOCK_12_MONTHS_SECS,
};
use crate::types::TieredRateConfig;
use crate::{SavingsVault, SavingsVaultClient};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    env: Env,
    client: SavingsVaultClient<'a>,
    admin: Address,
    token: Address,
}

fn ctx<'a>(env: &'a Env) -> Ctx<'a> {
    env.mock_all_auths();
    let client = SavingsVaultClient::new(env, &env.register(SavingsVault, ()));
    let admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    client.initialize(&admin, &token);
    Ctx {
        env: env.clone(),
        client,
        admin,
        token,
    }
}

fn mint(env: &Env, token: &Address, recipient: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(recipient, &amount);
}

fn advance_time(env: &Env, seconds: u64) {
    let ts = env.ledger().timestamp() + seconds;
    env.ledger().set(LedgerInfo {
        timestamp: ts,
        protocol_version: 22,
        sequence_number: env.ledger().sequence() + 1,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });
}

fn default_config() -> TieredRateConfig {
    TieredRateConfig {
        tier_low_rate_bps: DEFAULT_TIER_LOW_RATE_BPS,
        tier_mid_rate_bps: DEFAULT_TIER_MID_RATE_BPS,
        tier_high_rate_bps: DEFAULT_TIER_HIGH_RATE_BPS,
        lock_3mo_bonus_bps: DEFAULT_LOCK_3MO_MIN_BONUS_BPS,
        lock_6mo_bonus_bps: DEFAULT_LOCK_6MO_BONUS_BPS,
        lock_12mo_bonus_bps: DEFAULT_LOCK_12MO_BONUS_BPS,
    }
}

// ---------------------------------------------------------------------------
// 1. Correct rate applied for balance tier
// ---------------------------------------------------------------------------

#[test]
fn low_tier_rate_applied_for_small_balance() {
    let env = Env::default();
    // balance < 1_000 → low tier
    let rate = effective_rate_bps(&env, BALANCE_TIER_LOW_THRESHOLD - 1, 0);
    assert_eq!(rate, DEFAULT_TIER_LOW_RATE_BPS);
}

#[test]
fn mid_tier_rate_applied_for_mid_balance() {
    let env = Env::default();
    // 1_000 ≤ balance < 10_000 → mid tier
    let rate = effective_rate_bps(&env, BALANCE_TIER_LOW_THRESHOLD, 0);
    assert_eq!(rate, DEFAULT_TIER_MID_RATE_BPS);
}

#[test]
fn high_tier_rate_applied_for_large_balance() {
    let env = Env::default();
    // balance ≥ 10_000 → high tier
    let rate = effective_rate_bps(&env, BALANCE_TIER_HIGH_THRESHOLD, 0);
    assert_eq!(rate, DEFAULT_TIER_HIGH_RATE_BPS);
}

// ---------------------------------------------------------------------------
// 2. Lock-period bonus calculated correctly
// ---------------------------------------------------------------------------

#[test]
fn no_bonus_for_short_lock_period() {
    let env = Env::default();
    // < 3 months → no bonus
    let rate = effective_rate_bps(&env, BALANCE_TIER_LOW_THRESHOLD, LOCK_3_MONTHS_SECS - 1);
    assert_eq!(rate, DEFAULT_TIER_MID_RATE_BPS); // mid tier, no bonus
}

#[test]
fn three_month_bonus_applied() {
    let env = Env::default();
    let rate = effective_rate_bps(&env, BALANCE_TIER_LOW_THRESHOLD, LOCK_3_MONTHS_SECS);
    assert_eq!(
        rate,
        DEFAULT_TIER_MID_RATE_BPS + DEFAULT_LOCK_3MO_MIN_BONUS_BPS
    );
}

#[test]
fn six_month_bonus_applied() {
    let env = Env::default();
    let rate = effective_rate_bps(&env, BALANCE_TIER_LOW_THRESHOLD, LOCK_6_MONTHS_SECS);
    assert_eq!(
        rate,
        DEFAULT_TIER_MID_RATE_BPS + DEFAULT_LOCK_6MO_BONUS_BPS
    );
}

#[test]
fn twelve_month_bonus_applied() {
    let env = Env::default();
    let rate = effective_rate_bps(&env, BALANCE_TIER_LOW_THRESHOLD, LOCK_12_MONTHS_SECS);
    assert_eq!(
        rate,
        DEFAULT_TIER_MID_RATE_BPS + DEFAULT_LOCK_12MO_BONUS_BPS
    );
}

// ---------------------------------------------------------------------------
// 3. Rate updates when balance crosses threshold
// ---------------------------------------------------------------------------

#[test]
fn rate_updates_on_deposit_crossing_low_to_mid_tier() {
    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);
    let owner = Address::generate(&env);

    // Deposit below threshold → low tier
    let below = BALANCE_TIER_LOW_THRESHOLD - 1;
    mint(&env, &c.token, &owner, below + BALANCE_TIER_LOW_THRESHOLD);
    c.client.interest_deposit(&owner, &below);
    let acc = c.client.interest_account(&owner);
    assert_eq!(acc.rate_bps, DEFAULT_TIER_LOW_RATE_BPS);

    // Top up to cross into mid tier
    c.client.interest_deposit(&owner, &1);
    let acc2 = c.client.interest_account(&owner);
    assert_eq!(acc2.rate_bps, DEFAULT_TIER_MID_RATE_BPS);
}

#[test]
fn rate_updates_on_deposit_crossing_mid_to_high_tier() {
    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);
    let owner = Address::generate(&env);

    // Deposit at mid tier
    let mid_amount = BALANCE_TIER_HIGH_THRESHOLD - 1;
    mint(&env, &c.token, &owner, mid_amount + 1);
    c.client.interest_deposit(&owner, &mid_amount);
    let acc = c.client.interest_account(&owner);
    assert_eq!(acc.rate_bps, DEFAULT_TIER_MID_RATE_BPS);

    // Top up to cross into high tier
    c.client.interest_deposit(&owner, &1);
    let acc2 = c.client.interest_account(&owner);
    assert_eq!(acc2.rate_bps, DEFAULT_TIER_HIGH_RATE_BPS);
}

#[test]
fn rate_drops_on_withdraw_crossing_tier_down() {
    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);
    let owner = Address::generate(&env);

    // Deposit into high tier
    mint(&env, &c.token, &owner, BALANCE_TIER_HIGH_THRESHOLD);
    c.client.interest_deposit(&owner, &BALANCE_TIER_HIGH_THRESHOLD);
    let acc = c.client.interest_account(&owner);
    assert_eq!(acc.rate_bps, DEFAULT_TIER_HIGH_RATE_BPS);

    // Withdraw enough to drop below the high tier
    c.client.interest_withdraw(&owner, &1);
    let acc2 = c.client.interest_account(&owner);
    assert_eq!(acc2.rate_bps, DEFAULT_TIER_MID_RATE_BPS);
}

// ---------------------------------------------------------------------------
// 4. InterestRateChanged event emitted on rate change
// ---------------------------------------------------------------------------

#[test]
fn interest_rate_changed_event_emitted_on_tier_change() {
    use soroban_sdk::testutils::Events;

    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);
    let owner = Address::generate(&env);

    // First deposit in low tier (no prior rate so no "change" event yet).
    let below = BALANCE_TIER_LOW_THRESHOLD - 1;
    mint(&env, &c.token, &owner, below + 1);
    c.client.interest_deposit(&owner, &below);

    env.events().all(); // consume existing events

    // This deposit crosses into mid tier → should emit InterestRateChanged.
    c.client.interest_deposit(&owner, &1);

    let events = env.events().all();
    let has_rate_changed = events.iter().any(|(_, topics, _)| {
        topics
            .to_array()
            .first()
            .map(|t| *t == soroban_sdk::Symbol::new(&env, "interest_rate_changed").into())
            .unwrap_or(false)
    });
    assert!(has_rate_changed, "expected interest_rate_changed event");
}

#[test]
fn interest_rate_changed_event_emitted_by_set_tiered_rate_config() {
    use soroban_sdk::testutils::Events;

    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);

    c.client.set_tiered_rate_config(&c.admin, &default_config());

    let events = env.events().all();
    let has_rate_changed = events.iter().any(|(_, topics, _)| {
        topics
            .to_array()
            .first()
            .map(|t| *t == soroban_sdk::Symbol::new(&env, "interest_rate_changed").into())
            .unwrap_or(false)
    });
    assert!(has_rate_changed, "expected interest_rate_changed event from set_tiered_rate_config");
}

// ---------------------------------------------------------------------------
// 5. View function returns accurate rate
// ---------------------------------------------------------------------------

#[test]
fn query_interest_rate_returns_correct_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);

    // No config set yet → defaults apply.
    // Low balance, no lock.
    let rate = c.client.query_interest_rate(&(BALANCE_TIER_LOW_THRESHOLD - 1), &0u64);
    assert_eq!(rate, DEFAULT_TIER_LOW_RATE_BPS);

    // Mid balance, 6-month lock.
    let rate = c
        .client
        .query_interest_rate(&BALANCE_TIER_LOW_THRESHOLD, &LOCK_6_MONTHS_SECS);
    assert_eq!(
        rate,
        DEFAULT_TIER_MID_RATE_BPS + DEFAULT_LOCK_6MO_BONUS_BPS
    );

    // High balance, 12-month lock.
    let rate = c
        .client
        .query_interest_rate(&BALANCE_TIER_HIGH_THRESHOLD, &LOCK_12_MONTHS_SECS);
    assert_eq!(
        rate,
        DEFAULT_TIER_HIGH_RATE_BPS + DEFAULT_LOCK_12MO_BONUS_BPS
    );
}

#[test]
fn query_interest_rate_reflects_custom_config() {
    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);

    let custom = TieredRateConfig {
        tier_low_rate_bps: 100,
        tier_mid_rate_bps: 200,
        tier_high_rate_bps: 400,
        lock_3mo_bonus_bps: 50,
        lock_6mo_bonus_bps: 100,
        lock_12mo_bonus_bps: 200,
    };
    c.client.set_tiered_rate_config(&c.admin, &custom);

    let rate = c
        .client
        .query_interest_rate(&BALANCE_TIER_LOW_THRESHOLD, &LOCK_3_MONTHS_SECS);
    assert_eq!(rate, 200 + 50); // mid tier + 3mo bonus

    let rate = c
        .client
        .query_interest_rate(&BALANCE_TIER_HIGH_THRESHOLD, &LOCK_12_MONTHS_SECS);
    assert_eq!(rate, 400 + 200); // high tier + 12mo bonus
}

// ---------------------------------------------------------------------------
// 6. Edge cases: exactly at threshold
// ---------------------------------------------------------------------------

#[test]
fn exactly_at_low_threshold_is_mid_tier() {
    let env = Env::default();
    // balance == 1_000 → mid tier (threshold is "at or above 1 000")
    let rate = effective_rate_bps(&env, BALANCE_TIER_LOW_THRESHOLD, 0);
    assert_eq!(rate, DEFAULT_TIER_MID_RATE_BPS);
}

#[test]
fn exactly_at_high_threshold_is_high_tier() {
    let env = Env::default();
    let rate = effective_rate_bps(&env, BALANCE_TIER_HIGH_THRESHOLD, 0);
    assert_eq!(rate, DEFAULT_TIER_HIGH_RATE_BPS);
}

#[test]
fn exactly_at_3mo_lock_gets_3mo_bonus() {
    let env = Env::default();
    let rate = effective_rate_bps(&env, 0, LOCK_3_MONTHS_SECS);
    assert_eq!(rate, DEFAULT_TIER_LOW_RATE_BPS + DEFAULT_LOCK_3MO_MIN_BONUS_BPS);
}

#[test]
fn exactly_at_6mo_lock_gets_6mo_bonus_not_3mo() {
    let env = Env::default();
    let rate = effective_rate_bps(&env, 0, LOCK_6_MONTHS_SECS);
    assert_eq!(rate, DEFAULT_TIER_LOW_RATE_BPS + DEFAULT_LOCK_6MO_BONUS_BPS);
}

#[test]
fn exactly_at_12mo_lock_gets_12mo_bonus() {
    let env = Env::default();
    let rate = effective_rate_bps(&env, 0, LOCK_12_MONTHS_SECS);
    assert_eq!(rate, DEFAULT_TIER_LOW_RATE_BPS + DEFAULT_LOCK_12MO_BONUS_BPS);
}

// ---------------------------------------------------------------------------
// 7. Admin validation
// ---------------------------------------------------------------------------

#[test]
fn set_tiered_rate_config_rejects_decreasing_tiers() {
    use crate::error::Error;
    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);

    let bad = TieredRateConfig {
        tier_low_rate_bps: 500,
        tier_mid_rate_bps: 300, // lower than low → invalid
        tier_high_rate_bps: 800,
        lock_3mo_bonus_bps: 0,
        lock_6mo_bonus_bps: 0,
        lock_12mo_bonus_bps: 0,
    };
    assert_eq!(
        c.client.try_set_tiered_rate_config(&c.admin, &bad),
        Err(Ok(Error::InvalidParameters))
    );
}

#[test]
fn set_tiered_rate_config_rejects_rate_above_max() {
    use crate::error::Error;
    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);

    let bad = TieredRateConfig {
        tier_low_rate_bps: 100,
        tier_mid_rate_bps: 200,
        tier_high_rate_bps: 10_001, // exceeds 100 %
        lock_3mo_bonus_bps: 0,
        lock_6mo_bonus_bps: 0,
        lock_12mo_bonus_bps: 0,
    };
    assert_eq!(
        c.client.try_set_tiered_rate_config(&c.admin, &bad),
        Err(Ok(Error::InvalidParameters))
    );
}

#[test]
fn set_tiered_rate_config_rejects_non_admin() {
    use crate::error::Error;
    let env = Env::default();
    env.mock_all_auths();
    let c = ctx(&env);

    let not_admin = Address::generate(&env);
    assert_eq!(
        c.client.try_set_tiered_rate_config(&not_admin, &default_config()),
        Err(Ok(Error::Unauthorized))
    );
}
