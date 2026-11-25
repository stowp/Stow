//! Insurance pool contract tests (#631).

extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env,
};

use crate::{
    premium_for, ClaimStatus, Error, IncidentStatus, InsurancePool, InsurancePoolClient,
    PolicyStatus, YEAR_SECONDS,
};

/// Mock incident oracle: returns whatever status the test last set.
#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_status(env: Env, incident_id: BytesN<32>, status: IncidentStatus) {
        env.storage().instance().set(&incident_id, &status);
    }

    pub fn incident_status(env: Env, incident_id: BytesN<32>) -> IncidentStatus {
        env.storage()
            .instance()
            .get(&incident_id)
            .unwrap_or(IncidentStatus::Unknown)
    }
}

/// 2% a year.
const RATE_BPS: u32 = 200;
/// Pool must hold at least 50% of active coverage.
const MIN_RATIO_BPS: u32 = 5_000;
const CAPITAL: i128 = 500_000;
const COVERAGE: i128 = 1_000_000;

struct Setup<'a> {
    env: Env,
    pool: InsurancePoolClient<'a>,
    oracle: MockOracleClient<'a>,
    token: TokenClient<'a>,
    admin: Address,
    holder: Address,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_000);

    let admin = Address::generate(&env);
    let holder = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let sac = StellarAssetClient::new(&env, &token_id);
    sac.mint(&admin, &10_000_000);
    sac.mint(&holder, &10_000_000);

    let oracle_id = env.register(MockOracle, ());
    let pool_id = env.register(InsurancePool, ());
    let pool = InsurancePoolClient::new(&env, &pool_id);
    pool.initialize(&admin, &token_id, &oracle_id, &RATE_BPS, &MIN_RATIO_BPS);

    Setup {
        oracle: MockOracleClient::new(&env, &oracle_id),
        token: TokenClient::new(&env, &token_id),
        pool,
        admin,
        holder,
        env,
    }
}

fn incident(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn advance(env: &Env, seconds: u64) {
    env.ledger().with_mut(|l| l.timestamp += seconds);
}

// --- premiums ----------------------------------------------------------------

#[test]
fn premium_calculation_matches_coverage() {
    let s = setup();
    // 2% of 1_000_000 for a full year.
    assert_eq!(s.pool.quote_premium(&COVERAGE, &YEAR_SECONDS), 20_000);
    // Half a year costs half.
    assert_eq!(s.pool.quote_premium(&COVERAGE, &(YEAR_SECONDS / 2)), 10_000);
    // Double coverage costs double.
    assert_eq!(s.pool.quote_premium(&(2 * COVERAGE), &YEAR_SECONDS), 40_000);
    // Rounds up and never quotes zero.
    assert_eq!(premium_for(1, 1, RATE_BPS), Ok(1));
    assert_eq!(premium_for(COVERAGE, 1, RATE_BPS), Ok(1));
    assert_eq!(
        s.pool.try_quote_premium(&0, &YEAR_SECONDS),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        s.pool.try_quote_premium(&COVERAGE, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn pool_collects_premiums() {
    let s = setup();
    s.pool.deposit_capital(&s.admin, &CAPITAL);

    let before = s.token.balance(&s.holder);
    let id = s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);
    let policy = s.pool.policy(&id);

    assert_eq!(policy.premium, 20_000);
    assert_eq!(policy.coverage, COVERAGE);
    assert_eq!(policy.status, PolicyStatus::Active);
    assert_eq!(policy.end, policy.start + YEAR_SECONDS);
    assert_eq!(s.token.balance(&s.holder), before - 20_000);
    assert_eq!(s.token.balance(&s.pool.address), CAPITAL + 20_000);

    let stats = s.pool.stats();
    assert_eq!(stats.total_premiums, 20_000);
    assert_eq!(stats.total_capital, CAPITAL);
    assert_eq!(stats.balance, CAPITAL + 20_000);
    assert_eq!(stats.active_coverage, COVERAGE);
    assert_eq!(stats.policy_count, 1);
}

// --- solvency ------------------------------------------------------------------

#[test]
fn solvency_tracked_correctly() {
    let s = setup();
    assert_eq!(s.pool.coverage_ratio_bps(), None);
    assert!(s.pool.is_solvent());

    s.pool.deposit_capital(&s.admin, &CAPITAL);
    s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);
    // (500_000 + 20_000) / 1_000_000 = 52%.
    assert_eq!(s.pool.coverage_ratio_bps(), Some(5_200));
    assert!(s.pool.is_solvent());

    // Raising the floor above the current ratio flags insolvency.
    s.pool.set_min_coverage_ratio(&s.admin, &6_000);
    assert!(!s.pool.is_solvent());
}

#[test]
fn coverage_ratio_enforced_on_new_policies() {
    let s = setup();
    s.pool.deposit_capital(&s.admin, &CAPITAL);
    s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);

    // Another 1_000_000 of cover would drop the ratio to ~27%.
    assert_eq!(
        s.pool.try_buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS),
        Err(Ok(Error::CoverageRatioBreached))
    );
    // A smaller policy that keeps the ratio above 50% is fine.
    s.pool.buy_policy(&s.holder, &30_000, &YEAR_SECONDS);
    assert_eq!(s.pool.stats().active_coverage, COVERAGE + 30_000);
}

#[test]
fn coverage_ratio_enforced_on_capital_withdrawal() {
    let s = setup();
    s.pool.deposit_capital(&s.admin, &CAPITAL);
    s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);

    // Balance 520_000 must stay >= 500_000.
    assert_eq!(
        s.pool.try_withdraw_capital(&s.admin, &s.admin, &30_000),
        Err(Ok(Error::CoverageRatioBreached))
    );
    s.pool.withdraw_capital(&s.admin, &s.admin, &20_000);
    assert_eq!(s.pool.stats().balance, 500_000);

    // Non-admins cannot withdraw.
    assert_eq!(
        s.pool.try_withdraw_capital(&s.holder, &s.holder, &1),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn expired_policies_release_coverage() {
    let s = setup();
    s.pool.deposit_capital(&s.admin, &CAPITAL);
    let id = s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);

    assert_eq!(
        s.pool.try_expire_policy(&id),
        Err(Ok(Error::PolicyStillActive))
    );
    advance(&s.env, YEAR_SECONDS);
    s.pool.expire_policy(&id);

    assert_eq!(s.pool.policy(&id).status, PolicyStatus::Expired);
    assert_eq!(s.pool.stats().active_coverage, 0);
    assert_eq!(s.pool.coverage_ratio_bps(), None);
}

// --- claims --------------------------------------------------------------------

#[test]
fn claims_verified_before_payout() {
    let s = setup();
    s.pool.deposit_capital(&s.admin, &CAPITAL);
    let policy_id = s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);
    let incident_id = incident(&s.env, 1);

    let claim_id = s.pool.file_claim(&s.holder, &policy_id, &300_000, &incident_id);
    let claim = s.pool.claim(&claim_id);
    assert_eq!(claim.status, ClaimStatus::Pending);
    assert_eq!(claim.amount, 300_000);

    // Oracle has not ruled yet: nothing is paid and the claim stays pending.
    let before = s.token.balance(&s.holder);
    assert_eq!(
        s.pool.try_process_claim(&claim_id),
        Err(Ok(Error::ClaimNotVerified))
    );
    assert_eq!(s.token.balance(&s.holder), before);
    assert_eq!(s.pool.claim(&claim_id).status, ClaimStatus::Pending);

    // A second claim on the same policy is refused while one is pending.
    assert_eq!(
        s.pool.try_file_claim(&s.holder, &policy_id, &1, &incident_id),
        Err(Ok(Error::ClaimPending))
    );
}

#[test]
fn denied_claims_are_rejected_without_payout() {
    let s = setup();
    s.pool.deposit_capital(&s.admin, &CAPITAL);
    let policy_id = s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);
    let incident_id = incident(&s.env, 2);
    let claim_id = s.pool.file_claim(&s.holder, &policy_id, &300_000, &incident_id);

    s.oracle.set_status(&incident_id, &IncidentStatus::Denied);
    let before = s.token.balance(&s.holder);
    assert_eq!(s.pool.process_claim(&claim_id), ClaimStatus::Rejected);
    assert_eq!(s.token.balance(&s.holder), before);
    assert_eq!(s.pool.stats().total_payouts, 0);

    // The policy is still active and can be claimed on again.
    assert_eq!(s.pool.policy(&policy_id).status, PolicyStatus::Active);
    assert_eq!(
        s.pool.try_process_claim(&claim_id),
        Err(Ok(Error::ClaimAlreadyResolved))
    );
}

#[test]
fn payouts_distributed_accurately() {
    let s = setup();
    s.pool.deposit_capital(&s.admin, &CAPITAL);
    let policy_id = s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);
    let incident_id = incident(&s.env, 3);
    let claim_id = s.pool.file_claim(&s.holder, &policy_id, &300_000, &incident_id);

    s.oracle.set_status(&incident_id, &IncidentStatus::Confirmed);
    let holder_before = s.token.balance(&s.holder);
    let pool_before = s.token.balance(&s.pool.address);

    assert_eq!(s.pool.process_claim(&claim_id), ClaimStatus::Paid);
    assert_eq!(s.token.balance(&s.holder), holder_before + 300_000);
    assert_eq!(s.token.balance(&s.pool.address), pool_before - 300_000);

    let claim = s.pool.claim(&claim_id);
    assert_eq!(claim.status, ClaimStatus::Paid);
    assert!(claim.resolved_at.is_some());
    assert_eq!(s.pool.policy(&policy_id).status, PolicyStatus::Claimed);

    let stats = s.pool.stats();
    assert_eq!(stats.total_payouts, 300_000);
    assert_eq!(stats.balance, CAPITAL + 20_000 - 300_000);
    assert_eq!(stats.active_coverage, 0);

    // A claimed policy cannot be claimed again.
    assert_eq!(
        s.pool.try_file_claim(&s.holder, &policy_id, &1, &incident_id),
        Err(Ok(Error::PolicyInactive))
    );
}

#[test]
fn claim_validation() {
    let s = setup();
    s.pool.deposit_capital(&s.admin, &CAPITAL);
    let policy_id = s.pool.buy_policy(&s.holder, &COVERAGE, &YEAR_SECONDS);
    let incident_id = incident(&s.env, 4);
    let stranger = Address::generate(&s.env);

    assert_eq!(
        s.pool.try_file_claim(&s.holder, &policy_id, &(COVERAGE + 1), &incident_id),
        Err(Ok(Error::ClaimExceedsCoverage))
    );
    assert_eq!(
        s.pool.try_file_claim(&s.holder, &policy_id, &0, &incident_id),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        s.pool.try_file_claim(&stranger, &policy_id, &1, &incident_id),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        s.pool.try_file_claim(&s.holder, &99, &1, &incident_id),
        Err(Ok(Error::PolicyNotFound))
    );

    // No claims after the term ends.
    advance(&s.env, YEAR_SECONDS);
    assert_eq!(
        s.pool.try_file_claim(&s.holder, &policy_id, &1, &incident_id),
        Err(Ok(Error::PolicyInactive))
    );
}

#[test]
fn initialize_validates_and_runs_once() {
    let s = setup();
    let other = Address::generate(&s.env);
    assert_eq!(
        s.pool
            .try_initialize(&s.admin, &other, &other, &RATE_BPS, &MIN_RATIO_BPS),
        Err(Ok(Error::AlreadyInitialized))
    );

    let fresh = InsurancePoolClient::new(&s.env, &s.env.register(InsurancePool, ()));
    assert_eq!(
        fresh.try_initialize(&s.admin, &other, &other, &0, &MIN_RATIO_BPS),
        Err(Ok(Error::InvalidParameters))
    );
    assert_eq!(
        fresh.try_initialize(&s.admin, &other, &other, &RATE_BPS, &0),
        Err(Ok(Error::InvalidParameters))
    );
}
