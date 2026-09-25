#![cfg(test)]
//! Test skeleton. Each `#[ignore]`d test is a placeholder for a contributor.
//!
//! Pattern: register the contract, register a SEP-41 mock token
//! (`StellarAssetClient` from `soroban_sdk::testutils`), initialize, then
//! exercise the entrypoint. Mirrors `savings-vault::test`'s harness shape —
//! see that module if a helper here needs a fuller reference example.
//!
//! Tests that exercise a strategy (`harvest`, `migrate_strategy`, ...) will
//! additionally need a minimal mock strategy contract implementing the
//! interface documented in `README.md` under "Strategy interface"; building
//! that mock is issue-worthy on its own (see the module doc below) and does
//! not exist yet, so those tests cannot be un-ignored until it does.

use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, Env,
};

use crate::error::Error;
use crate::types::DataKey;
use crate::{YieldAdapter, YieldAdapterClient};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn setup(env: &Env) -> YieldAdapterClient<'_> {
    let contract_id = env.register(YieldAdapter, ());
    YieldAdapterClient::new(env, &contract_id)
}

/// Full setup: adapter + SEP-41 mock token + admin + treasury.
///
/// Returns `(client, admin, treasury, token_address)`.
fn setup_with_token(env: &Env) -> (YieldAdapterClient<'_>, Address, Address, Address) {
    let client = setup(env);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let token_admin = Address::generate(env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_id.address();

    client.initialize(&admin, &treasury, &token_address);

    (client, admin, treasury, token_address)
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests — no `Env`/contract needed
// ---------------------------------------------------------------------------

#[test]
fn validate_fee_bps_boundary() {
    assert!(crate::fees::validate_fee_bps(crate::fees::MAX_PERFORMANCE_FEE_BPS).is_ok());
    assert_eq!(
        crate::fees::validate_fee_bps(crate::fees::MAX_PERFORMANCE_FEE_BPS + 1),
        Err(Error::FeeTooHigh),
    );
}

// ---------------------------------------------------------------------------
// Direct unit tests — `harvest::apply_performance_fee` and
// `harvest::check_harvest_interval` exercised directly (not through the
// `harvest` entrypoint).
//
// `harvest` itself, and thus the end-to-end
// `performance_fee_taken_only_on_positive_yield` /
// `loss_reduces_exchange_rate_without_charging_fee` acceptance tests below,
// need a mock strategy contract that doesn't exist yet (see the module doc
// above) and are covered by a separate, unassigned issue. These tests give
// `apply_performance_fee` and `check_harvest_interval` real coverage in the
// meantime using `env.as_contract` to reach contract storage without going
// through `harvest`.
// ---------------------------------------------------------------------------

#[test]
fn apply_performance_fee_credits_fees_accrued_and_returns_remainder() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::PerformanceFeeBps, &1_000u32); // 10%

        let remainder = crate::harvest::apply_performance_fee(&env, 1_000).unwrap();

        assert_eq!(remainder, 900);
        let fees_accrued: i128 = env.storage().instance().get(&DataKey::FeesAccrued).unwrap();
        assert_eq!(fees_accrued, 100);
    });
}

#[test]
fn apply_performance_fee_accumulates_across_calls() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::PerformanceFeeBps, &500u32); // 5%

        crate::harvest::apply_performance_fee(&env, 2_000).unwrap();
        crate::harvest::apply_performance_fee(&env, 4_000).unwrap();

        let fees_accrued: i128 = env.storage().instance().get(&DataKey::FeesAccrued).unwrap();
        // 2_000 * 500 / 10_000 = 100; 4_000 * 500 / 10_000 = 200.
        assert_eq!(fees_accrued, 300);
    });
}

#[test]
fn apply_performance_fee_zero_bps_credits_nothing() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    env.as_contract(&contract_id, || {
        // `PerformanceFeeBps` left unset — defaults to 0 per `admin::performance_fee_bps`.
        let remainder = crate::harvest::apply_performance_fee(&env, 5_000).unwrap();

        assert_eq!(remainder, 5_000);
        let fees_accrued: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeesAccrued)
            .unwrap_or(0);
        assert_eq!(fees_accrued, 0);
    });
}

#[test]
fn check_harvest_interval_default_allows_immediate_harvest() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    env.as_contract(&contract_id, || {
        // No `HarvestInterval` / `LastHarvestAt` set — first-ever harvest must
        // never be blocked.
        assert!(crate::harvest::check_harvest_interval(&env).is_ok());
    });
}

#[test]
fn check_harvest_interval_rejects_too_soon() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    let start: u64 = 1_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: start,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::HarvestInterval, &3_600u64); // 1 hour
        env.storage()
            .instance()
            .set(&DataKey::LastHarvestAt, &start);

        // Not enough time has elapsed yet.
        env.ledger().set(LedgerInfo {
            timestamp: start + 1_800, // 30 minutes later
            protocol_version: 22,
            sequence_number: 200,
            network_id: Default::default(),
            base_reserve: 5_000_000,
            min_temp_entry_ttl: 1,
            min_persistent_entry_ttl: 1,
            max_entry_ttl: 3_110_400,
        });
        assert_eq!(
            crate::harvest::check_harvest_interval(&env),
            Err(Error::HarvestTooSoon),
        );
    });
}

#[test]
fn check_harvest_interval_allows_after_elapsed() {
    let env = Env::default();
    let contract_id = env.register(YieldAdapter, ());

    let start: u64 = 1_000_000;
    env.ledger().set(LedgerInfo {
        timestamp: start,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::HarvestInterval, &3_600u64); // 1 hour
        env.storage()
            .instance()
            .set(&DataKey::LastHarvestAt, &start);

        // A full hour (plus one second) has elapsed.
        env.ledger().set(LedgerInfo {
            timestamp: start + 3_601,
            protocol_version: 22,
            sequence_number: 300,
            network_id: Default::default(),
            base_reserve: 5_000_000,
            min_temp_entry_ttl: 1,
            min_persistent_entry_ttl: 1,
            max_entry_ttl: 3_110_400,
        });
        assert!(crate::harvest::check_harvest_interval(&env).is_ok());
    });
}

#[test]
fn set_and_get_harvest_interval_mirrors_withdraw_cooldown_shape() {
    // `admin::initialize` is unimplemented (a separate, unassigned issue), so
    // this seeds `DataKey::Admin` directly rather than going through
    // `client.initialize(..)`.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(YieldAdapter, ());
    let client = YieldAdapterClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::Admin, &admin);
    });

    assert_eq!(client.harvest_interval(), 0);

    client.set_harvest_interval(&admin, &7_200u64);
    assert_eq!(client.harvest_interval(), 7_200);
}

#[test]
fn set_harvest_interval_rejects_non_admin_caller() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(YieldAdapter, ());
    let client = YieldAdapterClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let impostor = Address::generate(&env);

    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::Admin, &admin);
    });

    let result = client.try_set_harvest_interval(&impostor, &7_200u64);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(client.harvest_interval(), 0);
}

// ---------------------------------------------------------------------------
// Placeholder stubs — one per contributor issue
// ---------------------------------------------------------------------------

#[test]
#[ignore = "TODO(issue): implement admin::initialize"]
fn initialize_sets_admin_treasury_and_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury, token) = setup_with_token(&env);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.treasury(), treasury);
    assert_eq!(client.token(), token);
    assert_eq!(client.total_shares(), 0);
}

#[test]
#[ignore = "TODO(issue): implement deposit::deposit + accounting::convert_to_shares"]
fn deposit_mints_shares_proportional_to_exchange_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let (_client, _admin, _treasury, _token) = setup_with_token(&env);
    let _user = Address::generate(&env);
    // On the very first deposit, shares must be minted 1:1 with assets.
    todo!("deposit `amount`, assert `get_position(user).shares == amount`");
}

#[test]
#[ignore = "TODO(issue): implement withdraw::request_withdraw + claim_withdraw"]
fn withdraw_round_trip_returns_correct_assets() {
    todo!("deposit, request_withdraw the full position, advance past cooldown, claim_withdraw, assert payout == deposit");
}

#[test]
#[ignore = "TODO(issue): implement withdraw cooldown enforcement"]
fn claim_before_cooldown_elapsed_rejected() {
    todo!("request_withdraw, immediately try_claim_withdraw, assert Error::CooldownNotElapsed");
}

#[test]
#[ignore = "TODO(issue): implement withdraw::cancel_withdraw"]
fn cancel_withdraw_returns_shares_to_owner() {
    todo!("request_withdraw, cancel_withdraw, assert position shares restored");
}

#[test]
#[ignore = "TODO(issue): implement harvest::harvest — needs a mock strategy contract"]
fn harvest_increases_exchange_rate_for_depositors() {
    todo!("deposit, simulate strategy yield, harvest, assert exchange_rate() increased");
}

#[test]
#[ignore = "TODO(issue): implement harvest::harvest (needs a mock strategy contract, see module doc). \
`apply_performance_fee` itself is implemented and covered directly by \
`apply_performance_fee_credits_fees_accrued_and_returns_remainder` above."]
fn performance_fee_taken_only_on_positive_yield() {
    todo!("harvest a positive-yield report, assert fees_accrued() == yield * fee_bps / 10_000");
}

#[test]
#[ignore = "TODO(issue): implement harvest::harvest + loss handling (needs a mock strategy \
contract, see module doc). Out of scope for `apply_performance_fee`/`check_harvest_interval`; \
tracked as a separate, unassigned issue."]
fn loss_reduces_exchange_rate_without_charging_fee() {
    todo!("harvest a negative-yield report, assert exchange_rate() decreased and fees_accrued() unchanged");
}

#[test]
#[ignore = "TODO(issue): auth review — require_auth on all mutating entrypoints"]
fn unauthorized_access_rejected() {
    todo!("for each mutating entrypoint, call without the required signer's auth and assert rejection");
}

#[test]
#[ignore = "TODO(issue): implement withdraw::request_withdraw NotFound path"]
fn withdraw_more_shares_than_owned_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, _token) = setup_with_token(&env);
    let owner = Address::generate(&env);

    let result = client.try_request_withdraw(&owner, &1i128);
    assert_eq!(
        result,
        Err(Ok(Error::NotFound)),
        "a request_withdraw from an owner with no position must fail with NotFound, not panic",
    );
}

#[test]
#[ignore = "TODO(issue): implement strategy::migrate_strategy — needs two mock strategies"]
fn strategy_migration_preserves_total_assets() {
    todo!(
        "register two mock strategies, deposit, migrate_strategy, assert total_assets() unchanged"
    );
}

#[test]
#[ignore = "TODO(issue): property test — share/asset rounding never allows value extraction"]
fn share_rounding_never_allows_value_extraction() {
    todo!("proptest: for arbitrary sequences of deposit/request_withdraw/claim_withdraw, assert sum of payouts never exceeds sum of deposits plus harvested yield");
}

#[test]
#[ignore = "TODO(issue): implement strategy::register_strategy duplicate-address guard"]
fn register_strategy_rejects_duplicate_address() {
    todo!("register a strategy address, register the same address again, assert Error::StrategyAlreadyRegistered");
}

#[test]
#[ignore = "TODO(issue): implement admin::set_paused narrower blocklist"]
fn paused_blocks_mutations_but_not_claim_withdraw() {
    todo!("pause, assert deposit/request_withdraw/harvest all reject with Error::Paused, then assert an in-flight claim_withdraw still succeeds");
}

#[test]
#[ignore = "TODO(issue): implement admin::initialize guard"]
fn initialize_twice_rejected() {
    todo!("initialize, call initialize again, assert Error::AlreadyInitialized");
}
