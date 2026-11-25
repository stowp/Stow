//! Savings vault inheritance planning (#635).

use soroban_sdk::{
    testutils::Address as _, token::Client as TokenClient, Address, BytesN, Env, Map,
};

use super::{mint, set_ledger_time, setup_with_token_and_id, test_events};
use crate::error::Error;
use crate::SavingsVaultClient;

const DEPOSIT: i128 = 1_000_000;
const START: u64 = 1_000;
const PERIOD: u64 = 30 * 24 * 60 * 60;

/// Vault + an owner with a funded flexible account.
fn setup(env: &Env) -> (SavingsVaultClient<'_>, Address, Address, Address) {
    env.mock_all_auths();
    let (client, admin, token, vault) = setup_with_token_and_id(env);
    let owner = Address::generate(env);
    set_ledger_time(env, START, 1);
    mint(env, &token, &admin, &owner, DEPOSIT);
    client.deposit(&owner, &DEPOSIT);
    (client, token, vault, owner)
}

fn shares(env: &Env, entries: &[(&Address, u32)]) -> Map<Address, u32> {
    let mut map = Map::new(env);
    for (address, bps) in entries {
        map.set((*address).clone(), *bps);
    }
    map
}

fn proof(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

/// Name of the most recent event emitted by the vault itself.
fn last_vault_event(env: &Env, vault: &Address) -> Option<std::string::String> {
    test_events(env)
        .into_iter()
        .rev()
        .find(|e| e.contract == *vault)
        .and_then(|e| e.topics.get(0).and_then(|t| t.as_symbol()))
}

#[test]
fn setup_stores_beneficiaries() {
    let env = Env::default();
    let (client, _token, _vault, owner) = setup(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let verifier = Address::generate(&env);

    client.setup_inheritance(
        &owner,
        &shares(&env, &[(&alice, 7_000), (&bob, 3_000)]),
        &PERIOD,
        &2_500,
        &Some(verifier.clone()),
    );

    let plan = client.inheritance_plan(&owner).expect("plan stored");
    assert_eq!(plan.owner, owner);
    assert_eq!(plan.beneficiaries.len(), 2);
    assert_eq!(plan.inactivity_period, PERIOD);
    assert_eq!(plan.partial_access_bps, 2_500);
    assert_eq!(plan.verifier, Some(verifier));
    assert_eq!(plan.last_active_at, START);
    let alice_entry = plan.beneficiaries.iter().find(|b| b.address == alice).unwrap();
    let bob_entry = plan.beneficiaries.iter().find(|b| b.address == bob).unwrap();
    assert_eq!(alice_entry.share_bps, 7_000);
    assert_eq!(bob_entry.share_bps, 3_000);
    assert_eq!(alice_entry.claimed, 0);
}

#[test]
fn setup_rejects_invalid_configuration() {
    let env = Env::default();
    let (client, _token, _vault, owner) = setup(&env);
    let alice = Address::generate(&env);

    // Shares must sum to 10 000.
    assert_eq!(
        client.try_setup_inheritance(&owner, &shares(&env, &[(&alice, 9_000)]), &PERIOD, &0, &None),
        Err(Ok(Error::InvalidShares))
    );
    // No beneficiaries.
    assert_eq!(
        client.try_setup_inheritance(&owner, &Map::new(&env), &PERIOD, &0, &None),
        Err(Ok(Error::InvalidParameters))
    );
    // Zero inactivity period.
    assert_eq!(
        client.try_setup_inheritance(&owner, &shares(&env, &[(&alice, 10_000)]), &0, &0, &None),
        Err(Ok(Error::InvalidParameters))
    );
    // Owner cannot inherit from themselves.
    assert_eq!(
        client.try_setup_inheritance(&owner, &shares(&env, &[(&owner, 10_000)]), &PERIOD, &0, &None),
        Err(Ok(Error::InvalidParameters))
    );
    // Owner cannot verify their own death.
    assert_eq!(
        client.try_setup_inheritance(
            &owner,
            &shares(&env, &[(&alice, 10_000)]),
            &PERIOD,
            &0,
            &Some(owner.clone())
        ),
        Err(Ok(Error::InvalidAddress))
    );
}

#[test]
fn time_lock_prevents_premature_access() {
    let env = Env::default();
    let (client, _token, _vault, owner) = setup(&env);
    let alice = Address::generate(&env);
    client.setup_inheritance(&owner, &shares(&env, &[(&alice, 10_000)]), &PERIOD, &0, &None);

    set_ledger_time(&env, START + PERIOD - 1, 2);
    assert_eq!(client.inheritance_claimable(&owner, &alice), 0);
    assert_eq!(
        client.try_claim_inheritance(&alice, &owner),
        Err(Ok(Error::StillLocked))
    );

    set_ledger_time(&env, START + PERIOD, 3);
    assert_eq!(client.inheritance_claimable(&owner, &alice), DEPOSIT);
    assert_eq!(client.claim_inheritance(&alice, &owner), DEPOSIT);
}

#[test]
fn owner_activity_resets_the_inactivity_clock() {
    let env = Env::default();
    let (client, _token, _vault, owner) = setup(&env);
    let alice = Address::generate(&env);
    client.setup_inheritance(&owner, &shares(&env, &[(&alice, 10_000)]), &PERIOD, &0, &None);

    // Owner withdraws shortly before the period elapses.
    set_ledger_time(&env, START + PERIOD - 10, 2);
    client.withdraw(&owner, &1);

    set_ledger_time(&env, START + PERIOD + 10, 3);
    assert_eq!(
        client.try_claim_inheritance(&alice, &owner),
        Err(Ok(Error::StillLocked))
    );

    // An explicit check-in also counts as activity.
    set_ledger_time(&env, START + 2 * PERIOD - 20, 4);
    client.inheritance_check_in(&owner);
    set_ledger_time(&env, START + 2 * PERIOD, 5);
    assert_eq!(
        client.try_claim_inheritance(&alice, &owner),
        Err(Ok(Error::StillLocked))
    );
}

#[test]
fn proof_requirement_enforced() {
    let env = Env::default();
    let (client, _token, _vault, owner) = setup(&env);
    let alice = Address::generate(&env);
    let verifier = Address::generate(&env);
    let impostor = Address::generate(&env);
    // No partial access: everything waits for the proof.
    client.setup_inheritance(
        &owner,
        &shares(&env, &[(&alice, 10_000)]),
        &PERIOD,
        &0,
        &Some(verifier.clone()),
    );

    // Proof cannot be attested while the owner is still considered active.
    assert_eq!(
        client.try_verify_death_proof(&verifier, &owner, &proof(&env)),
        Err(Ok(Error::StillLocked))
    );

    set_ledger_time(&env, START + PERIOD, 2);
    // Inactivity alone is not enough when proof is required.
    assert_eq!(
        client.try_claim_inheritance(&alice, &owner),
        Err(Ok(Error::StillLocked))
    );
    // Only the configured verifier can attest.
    assert_eq!(
        client.try_verify_death_proof(&impostor, &owner, &proof(&env)),
        Err(Ok(Error::Unauthorized))
    );

    client.verify_death_proof(&verifier, &owner, &proof(&env));
    let plan = client.inheritance_plan(&owner).unwrap();
    assert_eq!(plan.proof_hash, Some(proof(&env)));
    assert_eq!(plan.proof_verified_at, Some(START + PERIOD));
    assert_eq!(
        client.try_verify_death_proof(&verifier, &owner, &proof(&env)),
        Err(Ok(Error::ConflictingState))
    );

    assert_eq!(client.claim_inheritance(&alice, &owner), DEPOSIT);
}

#[test]
fn partial_access_before_full_transfer() {
    let env = Env::default();
    let (client, token, _vault, owner) = setup(&env);
    let token_client = TokenClient::new(&env, &token);
    let alice = Address::generate(&env);
    let verifier = Address::generate(&env);
    client.setup_inheritance(
        &owner,
        &shares(&env, &[(&alice, 10_000)]),
        &PERIOD,
        &2_000,
        &Some(verifier.clone()),
    );

    set_ledger_time(&env, START + PERIOD, 2);
    // 20% unlocks on inactivity alone.
    assert_eq!(client.claim_inheritance(&alice, &owner), 200_000);
    assert_eq!(token_client.balance(&alice), 200_000);
    assert_eq!(client.get_account(&owner).balance, 800_000);
    // Nothing more until the proof arrives.
    assert_eq!(
        client.try_claim_inheritance(&alice, &owner),
        Err(Ok(Error::InsufficientBalance))
    );

    client.verify_death_proof(&verifier, &owner, &proof(&env));
    assert_eq!(client.inheritance_claimable(&owner, &alice), 800_000);
    assert_eq!(client.claim_inheritance(&alice, &owner), 800_000);
    assert_eq!(token_client.balance(&alice), DEPOSIT);
    assert_eq!(client.get_account(&owner).balance, 0);
    // Fully paid plans are removed.
    assert!(client.inheritance_plan(&owner).is_none());
}

#[test]
fn multiple_beneficiaries_split_accurately() {
    let env = Env::default();
    let (client, token, _vault, owner) = setup(&env);
    let token_client = TokenClient::new(&env, &token);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    let verifier = Address::generate(&env);
    client.setup_inheritance(
        &owner,
        &shares(&env, &[(&alice, 5_000), (&bob, 3_000), (&carol, 2_000)]),
        &PERIOD,
        &1_000,
        &Some(verifier.clone()),
    );

    set_ledger_time(&env, START + PERIOD, 2);
    // Partial phase: 10% of each share, against the same snapshot.
    assert_eq!(client.claim_inheritance(&bob, &owner), 30_000);
    assert_eq!(client.claim_inheritance(&alice, &owner), 50_000);

    client.verify_death_proof(&verifier, &owner, &proof(&env));
    // Claim order does not change anyone's total.
    assert_eq!(client.claim_inheritance(&carol, &owner), 200_000);
    assert_eq!(client.claim_inheritance(&alice, &owner), 450_000);
    assert_eq!(client.claim_inheritance(&bob, &owner), 270_000);

    assert_eq!(token_client.balance(&alice), 500_000);
    assert_eq!(token_client.balance(&bob), 300_000);
    assert_eq!(token_client.balance(&carol), 200_000);
    assert_eq!(client.get_account(&owner).balance, 0);
}

#[test]
fn non_beneficiary_cannot_claim() {
    let env = Env::default();
    let (client, _token, _vault, owner) = setup(&env);
    let alice = Address::generate(&env);
    let stranger = Address::generate(&env);
    client.setup_inheritance(&owner, &shares(&env, &[(&alice, 10_000)]), &PERIOD, &0, &None);

    set_ledger_time(&env, START + PERIOD, 2);
    assert_eq!(
        client.try_claim_inheritance(&stranger, &owner),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn events_emitted_at_each_stage() {
    let env = Env::default();
    let (client, _token, vault, owner) = setup(&env);
    let alice = Address::generate(&env);
    let verifier = Address::generate(&env);

    client.setup_inheritance(
        &owner,
        &shares(&env, &[(&alice, 10_000)]),
        &PERIOD,
        &5_000,
        &Some(verifier.clone()),
    );
    assert_eq!(last_vault_event(&env, &vault).as_deref(), Some("InheritanceSetup"));

    set_ledger_time(&env, START + PERIOD, 2);
    client.claim_inheritance(&alice, &owner);
    assert_eq!(last_vault_event(&env, &vault).as_deref(), Some("InheritanceClaimed"));

    client.verify_death_proof(&verifier, &owner, &proof(&env));
    assert_eq!(
        last_vault_event(&env, &vault).as_deref(),
        Some("InheritanceProofVerified")
    );

    client.claim_inheritance(&alice, &owner);
    assert_eq!(last_vault_event(&env, &vault).as_deref(), Some("InheritanceClaimed"));
}

#[test]
fn cancel_removes_plan() {
    let env = Env::default();
    let (client, _token, _vault, owner) = setup(&env);
    let alice = Address::generate(&env);
    client.setup_inheritance(&owner, &shares(&env, &[(&alice, 10_000)]), &PERIOD, &0, &None);

    client.cancel_inheritance(&owner);
    assert!(client.inheritance_plan(&owner).is_none());
    set_ledger_time(&env, START + PERIOD, 2);
    assert_eq!(
        client.try_claim_inheritance(&alice, &owner),
        Err(Ok(Error::NotFound))
    );
}
