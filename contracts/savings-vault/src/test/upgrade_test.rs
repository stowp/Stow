//! Savings-vault upgrade mechanism tests (#618).
//!
//! Tests cover the full upgrade lifecycle and all acceptance criteria:
//!   - Only admin can initiate an upgrade
//!   - User balances are unchanged after an upgrade
//!   - Version number increments correctly
//!   - The `upgraded` event carries old and new version numbers
//!   - Rollback restores the previous version
//!   - Unauthorized upgrade attempts fail

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger, LedgerInfo},
    token::StellarAssetClient,
    Address, BytesN, Env, IntoVal,
};

use crate::error::Error;
use crate::events::{TOPIC_UPGRADE_CANCELLED, TOPIC_UPGRADE_PROPOSED, TOPIC_UPGRADED, TOPIC_UPGRADE_ROLLED_BACK};
use crate::{SavingsVault, SavingsVaultClient};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNIT: i128 = 10_000_000; // 1 token (7 decimals)

struct Ctx<'a> {
    env: &'a Env,
    client: SavingsVaultClient<'a>,
    admin: Address,
    token: Address,
}

fn ctx(env: &Env) -> Ctx<'_> {
    env.mock_all_auths();
    let client = SavingsVaultClient::new(env, &env.register(SavingsVault, ()));
    let admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    client.initialize(&admin, &token);
    Ctx { env, client, admin, token }
}

/// Mint vault tokens to a recipient.
fn mint(env: &Env, token: &Address, recipient: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(recipient, &amount);
}

/// Advance the ledger clock by `seconds`.
fn advance_time(env: &Env, seconds: u64) {
    env.ledger().set(LedgerInfo {
        timestamp: env.ledger().timestamp() + seconds,
        protocol_version: 22,
        sequence_number: env.ledger().sequence() + 1,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 1,
        min_persistent_entry_ttl: 1,
        max_entry_ttl: 3_110_400,
    });
}

/// A dummy Wasm hash — 32 bytes, non-zero so it's distinguishable.
fn dummy_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

// ---------------------------------------------------------------------------
// 1. Only admin can initiate an upgrade
// ---------------------------------------------------------------------------

#[test]
fn only_admin_can_propose_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    let attacker = Address::generate(&env);
    let result = c.client.try_propose_upgrade(&attacker, &dummy_hash(&env, 1));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));

    // Admin can propose without error.
    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 1));
    assert!(c.client.pending_upgrade().is_some());
}

#[test]
fn only_admin_can_execute_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    // Propose first (admin), then try to execute as a non-admin.
    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 2));

    let attacker = Address::generate(&env);
    let result = c.client.try_execute_upgrade(&attacker);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn only_admin_can_cancel_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 3));

    let attacker = Address::generate(&env);
    let result = c.client.try_cancel_upgrade(&attacker);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn only_admin_can_rollback_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    // Execute an upgrade to create a rollback snapshot.
    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 4));
    c.client.execute_upgrade(&c.admin);

    let attacker = Address::generate(&env);
    let result = c.client.try_rollback_upgrade(&attacker);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

// ---------------------------------------------------------------------------
// 2. User balances unchanged after upgrade
// ---------------------------------------------------------------------------

#[test]
fn user_balances_unchanged_after_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    let user = Address::generate(&env);
    let deposit_amount = 50 * UNIT;
    mint(&env, &c.token, &user, deposit_amount);
    c.client.deposit(&user, &deposit_amount);

    let balance_before = c.client.get_account(&user).unwrap().balance;

    // Perform an upgrade.
    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 5));
    c.client.execute_upgrade(&c.admin);

    // Balance must be byte-for-byte identical after the upgrade.
    let balance_after = c.client.get_account(&user).unwrap().balance;
    assert_eq!(
        balance_after, balance_before,
        "user balance must not change across a contract upgrade"
    );
}

#[test]
fn locked_balances_unchanged_after_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    let user = Address::generate(&env);
    let amount = 30 * UNIT;
    mint(&env, &c.token, &user, amount);

    let unlock_at = env.ledger().timestamp() + 1_000;
    let plan_id = c.client.locked_create(&user, &amount, &unlock_at);

    let plan_before = c.client.locked_plan(&plan_id);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 6));
    c.client.execute_upgrade(&c.admin);

    let plan_after = c.client.locked_plan(&plan_id);
    assert_eq!(
        plan_after.balance, plan_before.balance,
        "locked plan balance must not change across an upgrade"
    );
    assert_eq!(
        plan_after.unlock_at, plan_before.unlock_at,
        "locked plan unlock_at must not change across an upgrade"
    );
}

// ---------------------------------------------------------------------------
// 3. Version increments correctly
// ---------------------------------------------------------------------------

#[test]
fn version_starts_at_one_after_initialize() {
    let env = Env::default();
    let c = ctx(&env);
    assert_eq!(c.client.version(), 1);
}

#[test]
fn version_increments_on_execute_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    assert_eq!(c.client.version(), 1);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 7));
    c.client.execute_upgrade(&c.admin);

    assert_eq!(c.client.version(), 2, "version must be 2 after first upgrade");

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 8));
    c.client.execute_upgrade(&c.admin);

    assert_eq!(c.client.version(), 3, "version must be 3 after second upgrade");
}

// ---------------------------------------------------------------------------
// 4. Event includes old and new version numbers
// ---------------------------------------------------------------------------

#[test]
fn upgraded_event_carries_old_and_new_version() {
    use soroban_sdk::testutils::Events as _;

    let env = Env::default();
    let c = ctx(&env);

    let hash = dummy_hash(&env, 9);
    c.client.propose_upgrade(&c.admin, &hash);
    c.client.execute_upgrade(&c.admin);

    let all_events = env.events().all();

    // Find the `upgraded` event.
    let upgraded_events: Vec<_> = all_events
        .iter()
        .filter(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| t == TOPIC_UPGRADED.into_val(&env))
                .unwrap_or(false)
        })
        .collect();

    assert_eq!(
        upgraded_events.len(),
        1,
        "exactly one upgraded event should be emitted per execute_upgrade"
    );

    // Data layout: (caller, new_wasm_hash, old_version, new_version, timestamp)
    let (_, _, data) = &upgraded_events[0];
    let (_, _, old_ver, new_ver, _): (Address, BytesN<32>, u32, u32, u64) =
        data.clone().try_into().unwrap_or_else(|_| {
            panic!("upgraded event data must be (Address, BytesN<32>, u32, u32, u64)")
        });

    assert_eq!(old_ver, 1u32, "old version must be 1");
    assert_eq!(new_ver, 2u32, "new version must be 2");
}

// ---------------------------------------------------------------------------
// 5. Rollback restores the previous version
// ---------------------------------------------------------------------------

#[test]
fn rollback_restores_previous_version() {
    let env = Env::default();
    let c = ctx(&env);

    assert_eq!(c.client.version(), 1);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 10));
    c.client.execute_upgrade(&c.admin);

    assert_eq!(c.client.version(), 2);
    assert!(
        c.client.rollback_available(),
        "rollback must be available immediately after execute_upgrade"
    );

    c.client.rollback_upgrade(&c.admin);

    assert_eq!(
        c.client.version(),
        1,
        "version must revert to 1 after rollback"
    );
    assert!(
        !c.client.rollback_available(),
        "rollback snapshot must be cleared after rollback_upgrade"
    );
}

#[test]
fn rollback_emits_rolled_back_event() {
    use soroban_sdk::testutils::Events as _;

    let env = Env::default();
    let c = ctx(&env);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 11));
    c.client.execute_upgrade(&c.admin);
    c.client.rollback_upgrade(&c.admin);

    let all_events = env.events().all();
    let rollback_events: Vec<_> = all_events
        .iter()
        .filter(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| t == TOPIC_UPGRADE_ROLLED_BACK.into_val(&env))
                .unwrap_or(false)
        })
        .collect();

    assert_eq!(
        rollback_events.len(),
        1,
        "exactly one upgrade_rolled_back event must be emitted"
    );

    // Data: (caller, restored_version, timestamp)
    let (_, _, data) = &rollback_events[0];
    let (_, restored_ver, _): (Address, u32, u64) =
        data.clone().try_into().unwrap_or_else(|_| {
            panic!("rollback event data must be (Address, u32, u64)")
        });

    assert_eq!(restored_ver, 1u32, "event must record the restored version");
}

#[test]
fn rollback_unavailable_before_first_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    assert!(
        !c.client.rollback_available(),
        "rollback must not be available on a freshly initialized contract"
    );

    let result = c.client.try_rollback_upgrade(&c.admin);
    assert_eq!(
        result,
        Err(Ok(Error::NoRollbackAvailable)),
        "rollback must return NoRollbackAvailable before any upgrade"
    );
}

#[test]
fn rollback_unavailable_after_it_has_been_used() {
    let env = Env::default();
    let c = ctx(&env);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 12));
    c.client.execute_upgrade(&c.admin);
    c.client.rollback_upgrade(&c.admin);

    // A second rollback must fail — snapshot was consumed.
    let result = c.client.try_rollback_upgrade(&c.admin);
    assert_eq!(result, Err(Ok(Error::NoRollbackAvailable)));
}

// ---------------------------------------------------------------------------
// 6. Unauthorized upgrade attempts fail
// ---------------------------------------------------------------------------

#[test]
fn non_admin_cannot_propose_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    let non_admin = Address::generate(&env);
    let result = c.client.try_propose_upgrade(&non_admin, &dummy_hash(&env, 20));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn non_admin_cannot_set_upgrade_delay() {
    let env = Env::default();
    let c = ctx(&env);

    let non_admin = Address::generate(&env);
    let result = c.client.try_set_upgrade_delay(&non_admin, &3600u64);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

// ---------------------------------------------------------------------------
// 7. Duplicate proposal rejected
// ---------------------------------------------------------------------------

#[test]
fn second_propose_while_pending_returns_conflicting_state() {
    let env = Env::default();
    let c = ctx(&env);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 21));

    let result = c.client.try_propose_upgrade(&c.admin, &dummy_hash(&env, 22));
    assert_eq!(
        result,
        Err(Ok(Error::ConflictingState)),
        "proposing while a proposal is already pending must return ConflictingState"
    );
}

// ---------------------------------------------------------------------------
// 8. Timelock is respected
// ---------------------------------------------------------------------------

#[test]
fn execute_before_timelock_elapses_is_rejected() {
    let env = Env::default();
    let c = ctx(&env);

    // Set a 1-hour delay.
    c.client.set_upgrade_delay(&c.admin, &3_600u64);
    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 23));

    // Immediately attempting execute must fail.
    let result = c.client.try_execute_upgrade(&c.admin);
    assert_eq!(
        result,
        Err(Ok(Error::TimeWindowNotOpen)),
        "execute must fail before the timelock elapses"
    );
}

#[test]
fn execute_after_timelock_succeeds() {
    let env = Env::default();
    let c = ctx(&env);

    c.client.set_upgrade_delay(&c.admin, &3_600u64);
    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 24));

    // Advance past the delay.
    advance_time(&env, 3_601);

    // Now execute must succeed.
    c.client.execute_upgrade(&c.admin);
    assert_eq!(c.client.version(), 2);
}

// ---------------------------------------------------------------------------
// 9. Cancel clears the pending proposal
// ---------------------------------------------------------------------------

#[test]
fn cancel_clears_pending_proposal() {
    let env = Env::default();
    let c = ctx(&env);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 25));
    assert!(c.client.pending_upgrade().is_some());

    c.client.cancel_upgrade(&c.admin);
    assert!(
        c.client.pending_upgrade().is_none(),
        "pending proposal must be cleared after cancel"
    );
}

#[test]
fn cancel_emits_upgrade_cancelled_event() {
    use soroban_sdk::testutils::Events as _;

    let env = Env::default();
    let c = ctx(&env);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 26));
    c.client.cancel_upgrade(&c.admin);

    let all_events = env.events().all();
    let cancel_events: Vec<_> = all_events
        .iter()
        .filter(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| t == TOPIC_UPGRADE_CANCELLED.into_val(&env))
                .unwrap_or(false)
        })
        .collect();

    assert_eq!(cancel_events.len(), 1);
}

#[test]
fn cancel_without_pending_proposal_returns_not_found() {
    let env = Env::default();
    let c = ctx(&env);

    let result = c.client.try_cancel_upgrade(&c.admin);
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

// ---------------------------------------------------------------------------
// 10. Execute without a pending proposal returns NotFound
// ---------------------------------------------------------------------------

#[test]
fn execute_without_pending_proposal_returns_not_found() {
    let env = Env::default();
    let c = ctx(&env);

    let result = c.client.try_execute_upgrade(&c.admin);
    assert_eq!(result, Err(Ok(Error::NotFound)));
}

// ---------------------------------------------------------------------------
// 11. Migrate is callable by admin and is a no-op for version 1
// ---------------------------------------------------------------------------

#[test]
fn migrate_is_callable_after_upgrade() {
    let env = Env::default();
    let c = ctx(&env);

    c.client.propose_upgrade(&c.admin, &dummy_hash(&env, 27));
    c.client.execute_upgrade(&c.admin);

    // Migrate must succeed without panicking.
    c.client.migrate(&c.admin);
    assert_eq!(c.client.version(), 2);
}

#[test]
fn migrate_by_non_admin_is_rejected() {
    let env = Env::default();
    let c = ctx(&env);

    let non_admin = Address::generate(&env);
    let result = c.client.try_migrate(&non_admin);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

// ---------------------------------------------------------------------------
// 12. Proposed event carries expected fields
// ---------------------------------------------------------------------------

#[test]
fn propose_upgrade_emits_proposed_event() {
    use soroban_sdk::testutils::Events as _;

    let env = Env::default();
    let c = ctx(&env);

    let hash = dummy_hash(&env, 28);
    c.client.propose_upgrade(&c.admin, &hash);

    let all_events = env.events().all();
    let proposed_events: Vec<_> = all_events
        .iter()
        .filter(|(_, topics, _)| {
            topics
                .get(0)
                .map(|t| t == TOPIC_UPGRADE_PROPOSED.into_val(&env))
                .unwrap_or(false)
        })
        .collect();

    assert_eq!(proposed_events.len(), 1);
}

// ---------------------------------------------------------------------------
// 13. Pending upgrade proposal has correct fields
// ---------------------------------------------------------------------------

#[test]
fn pending_upgrade_stores_correct_fields() {
    let env = Env::default();
    let c = ctx(&env);

    let hash = dummy_hash(&env, 29);
    c.client.set_upgrade_delay(&c.admin, &1_000u64);
    let now = env.ledger().timestamp();

    c.client.propose_upgrade(&c.admin, &hash);

    let proposal = c.client.pending_upgrade().expect("pending proposal should exist");
    assert_eq!(proposal.new_wasm_hash, hash);
    assert_eq!(proposal.proposed_by, c.admin);
    assert_eq!(proposal.proposed_at, now);
    assert_eq!(proposal.execute_after, now + 1_000);
}
