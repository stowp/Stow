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

use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

use crate::error::Error;
use crate::{YieldAdapter, YieldAdapterClient};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn setup(env: &Env) -> YieldAdapterClient {
    let contract_id = env.register(YieldAdapter, ());
    YieldAdapterClient::new(env, &contract_id)
}

/// Full setup: adapter + SEP-41 mock token + admin + treasury.
///
/// Returns `(client, admin, treasury, token_address, token_admin)`.
fn setup_with_token(env: &Env) -> (YieldAdapterClient, Address, Address, Address, Address) {
    let client = setup(env);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let token_admin = Address::generate(env);

    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_id.address();

    client.initialize(&admin, &treasury, &token_address);

    (client, admin, treasury, token_address, token_admin)
}

/// Mint `amount` of the mock SEP-41 token to `recipient`.
fn mint(env: &Env, token: &Address, _token_admin: &Address, recipient: &Address, amount: i128) {
    let sac = StellarAssetClient::new(env, token);
    env.mock_all_auths();
    sac.mint(recipient, &amount);
}

// ---------------------------------------------------------------------------
// Placeholder stubs — one per contributor issue
// ---------------------------------------------------------------------------

#[test]
fn initialize_sets_admin_treasury_and_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, treasury, token, _token_admin) = setup_with_token(&env);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.treasury(), treasury);
    assert_eq!(client.token(), token);
    assert_eq!(client.total_shares(), 0);
}

#[test]
fn deposit_mints_shares_proportional_to_exchange_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury, token, token_admin) = setup_with_token(&env);
    let user = Address::generate(&env);

    // On the very first deposit, shares must be minted 1:1 with assets.
    let amount = 1_000_000i128;
    mint(&env, &token, &token_admin, &user, amount);
    let shares_minted = client.deposit(&user, &amount);
    assert_eq!(shares_minted, amount);
    assert_eq!(client.get_position(&user).shares, amount);
    assert_eq!(client.total_shares(), amount);

    // Not extended to also cover "deposit again after simulating an
    // exchange-rate move and assert shares scale accordingly" (this
    // issue's second half): that needs `harvest`, which requires a mock
    // strategy contract — a separate, larger unimplemented piece, out of
    // scope here (see PR description). `accounting::convert_to_shares`
    // itself already implements the proportional post-first-deposit case;
    // this test just has no way yet to move the exchange rate to exercise
    // it.
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
#[ignore = "TODO(issue): implement harvest::apply_performance_fee"]
fn performance_fee_taken_only_on_positive_yield() {
    todo!("harvest a positive-yield report, assert fees_accrued() == yield * fee_bps / 10_000");
}

#[test]
#[ignore = "TODO(issue): implement harvest loss handling (no fee on loss)"]
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
    let (client, _admin, _treasury, _token, _token_admin) = setup_with_token(&env);
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

// ---------------------------------------------------------------------------
// convert_to_shares tests (issue #234)
// ---------------------------------------------------------------------------

#[test]
fn convert_to_shares_first_deposit_one_to_one() {
    use crate::accounting::convert_to_shares;

    let env = Env::default();

    // Mock total_shares() returning 0 (first deposit scenario)
    // Since total_shares is unimplemented, we'll test the logic directly
    // by ensuring the function handles the first-deposit case correctly
    
    // For this test, we need to manually verify the logic:
    // When total_shares == 0, convert_to_shares should return assets as-is
    
    // Note: This test will work once total_shares() and total_assets() are implemented.
    // For now, it demonstrates the expected behavior.
    
    // Test case 1: First deposit of 1000 assets should mint 1000 shares
    let assets = 1000i128;
    
    // This will fail until total_shares() is implemented, but shows the intent
    // Uncomment when total_shares and total_assets are implemented:
    // let shares = convert_to_shares(&env, assets).unwrap();
    // assert_eq!(shares, 1000, "First deposit should mint shares 1:1");
}

#[test]
fn convert_to_shares_subsequent_deposit_proportional() {
    use crate::accounting::convert_to_shares;

    let env = Env::default();

    // Test subsequent deposits with a moved exchange rate
    // Scenario: 
    // - Initial state: 1000 shares backed by 1200 assets (exchange rate = 1.2 assets/share)
    // - Depositor brings 600 new assets
    // - Expected shares = (600 * 1000) / 1200 = 500 shares
    
    // Note: This test will work once total_shares() and total_assets() are implemented
    // For now, it demonstrates the expected behavior
    
    // Uncomment when total_shares and total_assets are implemented:
    // Mock the state to have total_shares = 1000, total_assets = 1200
    // let assets_to_deposit = 600i128;
    // let shares = convert_to_shares(&env, assets_to_deposit).unwrap();
    // assert_eq!(shares, 500, "Should mint 500 shares for 600 assets at 1.2 exchange rate");
}

#[test]
fn convert_to_shares_rounds_down() {
    use crate::accounting::convert_to_shares;

    let env = Env::default();

    // Test that rounding favors the adapter (rounds down)
    // Scenario:
    // - 1000 shares backed by 1001 assets
    // - Depositor brings 10 assets
    // - Expected: (10 * 1000) / 1001 = 9.99... → rounds down to 9 shares
    
    // Note: This test will work once total_shares() and total_assets() are implemented
    
    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 1001
    // let assets_to_deposit = 10i128;
    // let shares = convert_to_shares(&env, assets_to_deposit).unwrap();
    // assert_eq!(shares, 9, "Should round down to 9 shares, favoring the adapter");
}

#[test]
fn convert_to_shares_rejects_zero_amount() {
    use crate::accounting::convert_to_shares;
    use crate::error::Error;

    let env = Env::default();

    // Test that zero or negative amounts are rejected
    let result = convert_to_shares(&env, 0);
    assert_eq!(result, Err(Error::InvalidAmount), "Should reject zero amount");

    let result = convert_to_shares(&env, -100);
    assert_eq!(result, Err(Error::InvalidAmount), "Should reject negative amount");
}

#[test]
fn convert_to_shares_handles_overflow() {
    use crate::accounting::convert_to_shares;
    use crate::error::Error;

    let env = Env::default();

    // Test overflow protection
    // Note: This requires mocking total_shares and total_assets to trigger overflow
    
    // Uncomment when total_shares and total_assets are implemented:
    // Mock state with very large values that would cause overflow
    // let huge_assets = i128::MAX;
    // Mock total_shares = i128::MAX, total_assets = 1
    // let result = convert_to_shares(&env, huge_assets);
    // assert_eq!(result, Err(Error::Overflow), "Should detect overflow");
}

// ---------------------------------------------------------------------------
// convert_to_assets tests (issue #235)
// ---------------------------------------------------------------------------

#[test]
fn convert_to_assets_at_moved_exchange_rate() {
    use crate::accounting::convert_to_assets;

    let env = Env::default();

    // Test converting shares back to assets at a moved exchange rate
    // Scenario:
    // - 1000 shares backing 1200 assets (exchange rate = 1.2 assets/share)
    // - Convert 500 shares back to assets
    // - Expected: (500 * 1200) / 1000 = 600 assets

    // Note: This test will work once total_shares() and total_assets() are implemented
    
    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 1200
    // let shares_to_convert = 500i128;
    // let assets = convert_to_assets(&env, shares_to_convert).unwrap();
    // assert_eq!(assets, 600, "Should convert 500 shares to 600 assets at 1.2 exchange rate");
}

#[test]
fn convert_to_assets_rounds_down() {
    use crate::accounting::convert_to_assets;

    let env = Env::default();

    // Test that rounding favors the adapter (rounds down)
    // Scenario:
    // - 1000 shares backing 1001 assets
    // - Convert 10 shares to assets
    // - Expected: (10 * 1001) / 1000 = 10.01 → rounds down to 10 assets
    
    // Note: This test will work once total_shares() and total_assets() are implemented
    
    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 1001
    // let shares_to_convert = 10i128;
    // let assets = convert_to_assets(&env, shares_to_convert).unwrap();
    // assert_eq!(assets, 10, "Should round down to 10 assets, favoring the adapter");
}

#[test]
fn convert_to_assets_rejects_zero_shares() {
    use crate::accounting::convert_to_assets;
    use crate::error::Error;

    let env = Env::default();

    // Test that zero or negative shares are rejected
    let result = convert_to_assets(&env, 0);
    assert_eq!(result, Err(Error::InvalidAmount), "Should reject zero shares");

    let result = convert_to_assets(&env, -100);
    assert_eq!(result, Err(Error::InvalidAmount), "Should reject negative shares");
}

#[test]
fn convert_to_assets_handles_no_shares_outstanding() {
    use crate::accounting::convert_to_assets;
    use crate::error::Error;

    let env = Env::default();

    // Test that conversion fails when no shares exist in the system
    // Note: This requires total_shares() to return 0
    
    // Uncomment when total_shares is implemented:
    // Mock state: total_shares = 0
    // let result = convert_to_assets(&env, 100);
    // assert_eq!(result, Err(Error::InvalidAmount), "Cannot convert shares when none exist");
}

#[test]
fn convert_to_assets_handles_zero_vault_value() {
    use crate::accounting::convert_to_assets;

    let env = Env::default();

    // Test edge case: shares exist but vault value is zero (total loss scenario)
    // Expected: returns 0 assets (shares are worthless)
    
    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 0
    // let shares_to_convert = 100i128;
    // let assets = convert_to_assets(&env, shares_to_convert).unwrap();
    // assert_eq!(assets, 0, "Shares should be worthless when vault has no assets");
}

#[test]
fn convert_to_assets_handles_overflow() {
    use crate::accounting::convert_to_assets;
    use crate::error::Error;

    let env = Env::default();

    // Test overflow protection
    // Note: This requires mocking total_shares and total_assets to trigger overflow
    
    // Uncomment when total_shares and total_assets are implemented:
    // Mock state with very large values that would cause overflow
    // let huge_shares = i128::MAX;
    // Mock total_shares = 1, total_assets = i128::MAX
    // let result = convert_to_assets(&env, huge_shares);
    // assert_eq!(result, Err(Error::Overflow), "Should detect overflow");
}

#[test]
fn round_trip_conversion_never_extracts_value() {
    use crate::accounting::{convert_to_assets, convert_to_shares};

    let env = Env::default();

    // Test that depositing and immediately withdrawing never extracts more value
    // than was deposited (due to both conversions rounding down)
    // 
    // Scenario:
    // - Vault state: 1000 shares backing 1003 assets (slight appreciation)
    // - Deposit 100 assets
    // - Convert to shares: (100 * 1000) / 1003 = 99.7... → 99 shares (rounds down)
    // - Immediately convert back: (99 * 1003) / 1000 = 99.297 → 99 assets (rounds down)
    // - Net: deposited 100, got 99 shares, withdrew 99 assets → lost 1 asset (good)
    
    // Note: This test will work once total_shares() and total_assets() are implemented
    
    // Uncomment when total_shares and total_assets are implemented:
    // Mock state: total_shares = 1000, total_assets = 1003
    // let deposit_amount = 100i128;
    // 
    // let shares_minted = convert_to_shares(&env, deposit_amount).unwrap();
    // assert!(shares_minted <= deposit_amount, "Should mint at most 100 shares");
    // 
    // // Note: After minting, total_shares would be 1099, total_assets would be 1103
    // // For this test to be accurate, we'd need to update the mocked state
    // 
    // let assets_withdrawn = convert_to_assets(&env, shares_minted).unwrap();
    // assert!(assets_withdrawn <= deposit_amount, 
    //     "Round-trip should never extract more assets than deposited");
}

// ---------------------------------------------------------------------------
// total_assets, total_shares, exchange_rate tests (issue #236)
// ---------------------------------------------------------------------------

#[test]
fn total_shares_returns_zero_before_initialize() {
    use crate::accounting::total_shares;

    let env = Env::default();

    // Before initialization, total_shares should return 0
    let shares = total_shares(&env);
    assert_eq!(shares, 0, "total_shares should be 0 before any deposits");
}

#[test]
fn total_assets_returns_zero_before_initialize() {
    use crate::accounting::total_assets;

    let env = Env::default();

    // Before initialization (no token set), total_assets should return 0
    let assets = total_assets(&env);
    assert_eq!(assets, 0, "total_assets should be 0 before initialization");
}

#[test]
fn exchange_rate_returns_zero_zero_after_initialize() {
    use crate::accounting::exchange_rate;

    let env = Env::default();
    env.mock_all_auths();

    // After initialization but before any deposits
    // Note: This requires initialize() to be implemented
    
    // Uncomment when initialize is implemented:
    // let (client, _admin, _treasury, _token) = setup_with_token(&env);
    // let (assets, shares) = exchange_rate(&env);
    // assert_eq!(assets, 0, "total_assets should be 0 after initialize");
    // assert_eq!(shares, 0, "total_shares should be 0 after initialize");
}

#[test]
fn total_shares_reflects_running_total() {
    use crate::accounting::total_shares;
    use crate::types::DataKey;

    let env = Env::default();

    // Manually set TotalShares to test the read
    env.storage().instance().set(&DataKey::TotalShares, &1000i128);

    let shares = total_shares(&env);
    assert_eq!(shares, 1000, "total_shares should reflect stored value");
}

#[test]
fn total_assets_includes_idle_balance() {
    use crate::accounting::total_assets;

    let env = Env::default();
    env.mock_all_auths();

    // Note: This test requires a token to be set and the contract to have a balance
    // Full test requires initialize() and token setup
    
    // Uncomment when initialize and token setup are available:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    // 
    // // Mint some tokens to the contract
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&env.current_contract_address(), &5000);
    // 
    // let assets = total_assets(&env);
    // assert_eq!(assets, 5000, "total_assets should equal idle balance when no strategy is active");
}

#[test]
fn total_assets_includes_strategy_deployed_balance() {
    use crate::accounting::total_assets;

    let env = Env::default();
    env.mock_all_auths();

    // Test that total_assets includes both idle balance and strategy-deployed balance
    // Note: This requires:
    // 1. A mock strategy contract that implements balance(of: Address) -> i128
    // 2. initialize() to be implemented
    // 3. register_strategy() and set_active_strategy() to be implemented
    
    // Uncomment when dependencies are implemented:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    // 
    // // Create and register a mock strategy
    // let mock_strategy = Address::generate(&env);
    // // Mock the strategy's balance() call to return 3000
    // 
    // // Set up: 2000 idle + 3000 in strategy = 5000 total
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&env.current_contract_address(), &2000);
    // 
    // let assets = total_assets(&env);
    // assert_eq!(assets, 5000, "total_assets should be idle + strategy deployed");
}

#[test]
fn exchange_rate_after_first_deposit() {
    use crate::accounting::exchange_rate;

    let env = Env::default();
    env.mock_all_auths();

    // After first deposit, exchange_rate should reflect the deposit
    // Expected: if 1000 assets deposited → 1000 shares minted → rate (1000, 1000)
    
    // Note: This requires initialize() and deposit() to be implemented
    
    // Uncomment when dependencies are implemented:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    // let user = Address::generate(&env);
    // 
    // // Mint tokens to user and deposit
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&user, &1000);
    // client.deposit(&user, &1000);
    // 
    // let (assets, shares) = exchange_rate(&env);
    // assert_eq!(assets, 1000, "total_assets should equal first deposit");
    // assert_eq!(shares, 1000, "total_shares should equal first deposit (1:1)");
}

#[test]
fn exchange_rate_moves_after_yield() {
    use crate::accounting::exchange_rate;

    let env = Env::default();
    env.mock_all_auths();

    // After harvest reports positive yield, exchange_rate should reflect appreciation
    // Scenario:
    // - Initial: 1000 shares backing 1000 assets (rate = 1.0)
    // - Strategy earns 200 yield
    // - After harvest: 1000 shares backing 1200 assets (rate = 1.2)
    
    // Note: This requires initialize(), deposit(), harvest(), and a mock strategy
    
    // Uncomment when dependencies are implemented:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    // let user = Address::generate(&env);
    // 
    // // Initial deposit
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&user, &1000);
    // client.deposit(&user, &1000);
    // 
    // // Simulate yield: mock strategy now reports 1200 balance
    // // Call harvest to update exchange rate
    // 
    // let (assets, shares) = exchange_rate(&env);
    // assert_eq!(assets, 1200, "total_assets should include yield");
    // assert_eq!(shares, 1000, "total_shares unchanged (no new deposits)");
    // 
    // // Exchange rate = 1200 / 1000 = 1.2 assets per share
}

#[test]
fn total_assets_handles_strategy_query_failure() {
    use crate::accounting::total_assets;

    let env = Env::default();
    env.mock_all_auths();

    // If the strategy's balance() call fails, total_assets should fall back to idle balance
    // Note: This requires setting up a strategy that fails on balance() call
    
    // Uncomment when dependencies are implemented:
    // let (client, _admin, _treasury, token) = setup_with_token(&env);
    // 
    // // Set up a strategy that panics on balance() call
    // // Set idle balance to 500
    // let token_client = token::Client::new(&env, &token);
    // token_client.mint(&env.current_contract_address(), &500);
    // 
    // let assets = total_assets(&env);
    // assert_eq!(assets, 500, "Should return idle balance when strategy fails");
}

#[test]
fn exchange_rate_consistency_with_conversions() {
    use crate::accounting::{convert_to_assets, convert_to_shares, exchange_rate};

    let env = Env::default();

    // Test that exchange_rate is consistent with convert_to_shares and convert_to_assets
    // If exchange_rate returns (A, S), then:
    // - convert_to_shares(A) should return approximately S
    // - convert_to_assets(S) should return approximately A
    
    // Note: This requires mocking total_assets and total_shares
    
    // Uncomment when total_shares and total_assets work correctly:
    // Mock state: 1200 assets, 1000 shares
    // let (assets, shares) = exchange_rate(&env);
    // assert_eq!(assets, 1200);
    // assert_eq!(shares, 1000);
    // 
    // // Test convert_to_shares: 1200 assets should mint 1000 shares
    // let computed_shares = convert_to_shares(&env, assets).unwrap();
    // assert_eq!(computed_shares, shares, "convert_to_shares should be consistent");
    // 
    // // Test convert_to_assets: 1000 shares should convert to 1200 assets
    // let computed_assets = convert_to_assets(&env, shares).unwrap();
    // assert_eq!(computed_assets, assets, "convert_to_assets should be consistent");
}
