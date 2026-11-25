//! Savings-vault ↔ boost-NFT integration.
//!
//! When a saver's interest-account principal crosses a milestone, the vault
//! awards them a boost NFT — one per tier per user — by calling the boost-NFT
//! contract's `mint`. While an address holds boost NFTs, the vault adds their
//! stacked boost to that holder's effective interest rate. The boost-NFT
//! contract is the **source of truth for current holders**, so a transferred
//! token's boost moves with it to the new owner.
//!
//! See `lib.rs` for the `set_boost_nft` / `boost_nft` / `boost_total_bps`
//! entrypoints that delegate here, and `interest.rs` for where the boost is
//! applied to accrual.

use soroban_sdk::{Address, Env, Vec};

use boost_nft::{BoostNftClient, Tier};

use crate::error::Error;
use crate::events::TOPIC_BOOST_NFT_AWARDED;
use crate::storage::{self, extend_instance_ttl, extend_persistent_ttl};
use crate::types::{BoostState, DataKey};

/// Maximum stacked boost applied to a single interest account, in basis
/// points (10%). A holder owning many tokens — including ones received via
/// transfer — never gets more than this added to their base rate.
pub const MAX_BOOST_BPS: u32 = 1_000;

/// Savings-milestone thresholds, in vault-token stroops. When an interest
/// account's principal reaches a threshold, the holder earns the matching
/// tier's NFT (once). At the repo's test convention of 1_000_000 stroops per
/// unit these are 10 / 100 / 1_000 units.
pub const MILESTONE_BRONZE: i128 = 10_000_000;
pub const MILESTONE_SILVER: i128 = 100_000_000;
pub const MILESTONE_GOLD: i128 = 1_000_000_000;

/// Tiers in ascending milestone order: `(tier, threshold)`. Iterated in this
/// order when awarding so lower tiers are minted first.
const TIERS: [(Tier, i128); 3] = [
    (Tier::Bronze, MILESTONE_BRONZE),
    (Tier::Silver, MILESTONE_SILVER),
    (Tier::Gold, MILESTONE_GOLD),
];

/// The configured boost-NFT contract address, or `None` if boosts are
/// disabled.
fn boost_nft_address(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::BoostNft)
}

/// Read: the configured boost-NFT contract address, or `None` (boosts off).
pub fn boost_nft(env: &Env) -> Option<Address> {
    boost_nft_address(env)
}

/// Set the boost-NFT contract address. Admin-only.
///
/// Errors: `NotInitialized`, `Unauthorized` if `caller` is not the admin.
pub fn set_boost_nft(env: &Env, caller: Address, boost_nft: Address) -> Result<(), Error> {
    extend_instance_ttl(env);
    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    caller.require_auth();
    if caller != admin {
        return Err(Error::Unauthorized);
    }
    env.storage().instance().set(&DataKey::BoostNft, &boost_nft);
    Ok(())
}

/// Total interest boost, in basis points, that `owner` earns from every boost
/// NFT they currently hold. Read live from the boost-NFT contract (so
/// transferred tokens move the boost to the new holder) and capped at
/// [`MAX_BOOST_BPS`]. Returns `0` when no boost-NFT contract is configured.
///
/// This is a read-only cross-contract call; safe to invoke from reads such as
/// `interest_accrued`.
pub fn total_boost_bps(env: &Env, owner: &Address) -> u32 {
    let Some(address) = boost_nft_address(env) else {
        return 0;
    };
    let client = BoostNftClient::new(env, &address);
    let token_ids = client.tokens_of(owner);
    let mut sum: u32 = 0;
    for id in token_ids {
        // `tier_of` traps only for an unknown id; `tokens_of` only returns
        // existing ids, so this never traps in practice.
        let tier = client.tier_of(&id);
        sum = sum.saturating_add(tier.boost_bps());
    }
    sum.min(MAX_BOOST_BPS)
}

/// Whether `awarded` already contains `tier`.
fn already_awarded(awarded: &Vec<Tier>, tier: Tier) -> bool {
    awarded.iter().any(|t| t == tier)
}

/// Award any newly-crossed milestone NFTs to `owner` given their current
/// interest-account `principal`.
///
/// - Idempotent: each tier is awarded at most once per user (tracked in
///   [`BoostState`]).
/// - No-op when no boost-NFT contract is configured.
/// - Mints by calling the boost-NFT contract as the vault's own address (the
///   vault is the authorized `minter`), then emits `BoostNFTAwarded`.
///
/// A mint failure (e.g. a misconfigured boost-NFT) traps and reverts the
/// enclosing deposit/claim, matching how the vault treats a misconfigured
/// custodial token.
pub fn check_milestones(env: &Env, owner: &Address, principal: i128) -> Result<(), Error> {
    let Some(address) = boost_nft_address(env) else {
        return Ok(());
    };

    let key = DataKey::BoostState(owner.clone());
    let mut state: BoostState = match env.storage().persistent().get(&key) {
        Some(s) => {
            extend_persistent_ttl(env, &key);
            s
        }
        None => BoostState {
            awarded_tiers: Vec::new(env),
            token_ids: Vec::new(env),
        },
    };

    let client = BoostNftClient::new(env, &address);
    let vault = env.current_contract_address();
    let now = env.ledger().timestamp();

    for (tier, threshold) in TIERS {
        if principal >= threshold && !already_awarded(&state.awarded_tiers, tier) {
            let token_id = client.mint(&vault, owner, &tier, &threshold);
            state.awarded_tiers.push_back(tier);
            state.token_ids.push_back(token_id);

            env.events().publish(
                (TOPIC_BOOST_NFT_AWARDED, owner.clone(), token_id),
                (owner.clone(), token_id, tier, threshold, now),
            );
        }
    }

    env.storage().persistent().set(&key, &state);
    extend_persistent_ttl(env, &key);
    Ok(())
}
