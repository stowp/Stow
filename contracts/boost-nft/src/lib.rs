#![no_std]
//! # Stow Boost NFT
//!
//! A small NFT collection that grants savings-interest boosts. The
//! [`savings-vault`](../../savings-vault) contract awards a token to a saver
//! the first time their savings balance crosses a milestone; while an address
//! *holds* a token, the vault adds that token's tier boost to the holder's
//! effective interest rate.
//!
//! ## Roles
//!
//! - `admin` — set at [`initialize`]; may mint directly (manual airdrops) and
//!   rotate the admin via [`set_admin`].
//! - `minter` — the savings-vault contract address. This is the only non-admin
//!   caller permitted to [`mint`]; the vault calls it automatically when a
//!   user crosses a milestone.
//!
//! ## Tiers
//!
//! Each token carries a [`Tier`] whose boost is a fixed number of basis points
//! (1 bp = 0.01%):
//!
//! | Tier    | Boost (bps) |
//! |---------|-------------|
//! | Bronze  | 50          |
//! | Silver  | 150         |
//! | Gold    | 300         |
//!
//! Boosts from every token a holder owns stack; the savings-vault caps the
//! stacked total (see `savings-vault::boost::MAX_BOOST_BPS`).
//!
//! ## Transfers
//!
//! Tokens are freely transferable via [`transfer`]. A transfer moves both the
//! token and the boost it grants to the new owner; the savings-vault always
//! reads the *current* holder from this contract, so a transferred token's
//! boost follows it. The vault's own per-user award record (which tier a user
//! has already earned) is unaffected by transfers — it only prevents awarding
//! the same tier twice.
//!
//! ## Auth
//!
//! Every state-changing entrypoint calls `require_auth()` on the address it
//! acts for. [`mint`] authorizes the caller (`minter` or `admin`), so an
//! arbitrary user cannot mint boost NFTs to themselves.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Vec};

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/// Interest-boost tier carried by a token. Variant order is part of the stable
/// on-wire encoding — append new tiers at the end only.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Tier {
    Bronze,
    Silver,
    Gold,
}

/// Boost granted by a [`Tier::Bronze`] token, in basis points.
pub const BOOST_BPS_BRONZE: u32 = 50;
/// Boost granted by a [`Tier::Silver`] token, in basis points.
pub const BOOST_BPS_SILVER: u32 = 150;
/// Boost granted by a [`Tier::Gold`] token, in basis points.
pub const BOOST_BPS_GOLD: u32 = 300;

impl Tier {
    /// The interest-rate boost this tier grants, in basis points.
    pub fn boost_bps(&self) -> u32 {
        match self {
            Tier::Bronze => BOOST_BPS_BRONZE,
            Tier::Silver => BOOST_BPS_SILVER,
            Tier::Gold => BOOST_BPS_GOLD,
        }
    }
}

// ---------------------------------------------------------------------------
// Token record
// ---------------------------------------------------------------------------

/// Full metadata for a minted boost token.
#[contracttype]
#[derive(Clone)]
pub struct NftData {
    pub token_id: u64,
    pub owner: Address,
    pub tier: Tier,
    /// Savings-milestone threshold (in vault-token stroops) the holder had
    /// crossed when this token was minted. Stored for provenance; the boost
    /// itself depends only on [`tier`](NftData::tier).
    pub milestone: i128,
    pub minted_at: u64,
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Storage keys. Durability + TTL per variant, documented inline. New keys
/// are appended at the end so existing case indices never shift.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address. Instance; TTL bumped with the rest of instance storage.
    Admin,
    /// Authorized minter (the savings-vault contract). Instance.
    Minter,
    /// Monotonic token-id counter. Instance.
    NextTokenId,
    /// Full [`NftData`] by id. Persistent; TTL bumped on every read/write.
    Token(u64),
    /// Token-id list per owner. Persistent; TTL bumped on every read/write.
    OwnerTokens(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was already called.
    AlreadyInitialized = 1,
    /// `initialize` has not been called yet.
    NotInitialized = 2,
    /// The caller is not permitted to perform this action.
    Unauthorized = 3,
    /// The referenced token does not exist.
    NotFound = 4,
    /// A `u64` counter would overflow.
    Overflow = 5,
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

/// Roughly one ledger every 5s on mainnet cadence.
const DAY_IN_LEDGERS: u32 = 17_280;

const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

const PERSISTENT_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = PERSISTENT_BUMP_AMOUNT - DAY_IN_LEDGERS;

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
}

fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

fn get_minter(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Minter)
}

/// Allocate and persist the next token id. Ids start at 1.
fn next_token_id(env: &Env) -> Result<u64, Error> {
    let current: u64 = env.storage().instance().get(&DataKey::NextTokenId).unwrap_or(0);
    let next = current.checked_add(1).ok_or(Error::Overflow)?;
    env.storage().instance().set(&DataKey::NextTokenId, &next);
    Ok(next)
}

/// Read an owner's token-id list, defaulting to empty.
fn owner_tokens(env: &Env, owner: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::OwnerTokens(owner.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

fn set_owner_tokens(env: &Env, owner: &Address, list: &Vec<u64>) {
    let key = DataKey::OwnerTokens(owner.clone());
    env.storage().persistent().set(&key, list);
    extend_persistent_ttl(env, &key);
}

/// Return `list` with the first occurrence of `token_id` removed.
fn without_token(env: &Env, list: &Vec<u64>, token_id: u64) -> Vec<u64> {
    let mut out = Vec::new(env);
    let mut removed = false;
    for id in list.iter() {
        if !removed && id == token_id {
            removed = true;
            continue;
        }
        out.push_back(id);
    }
    out
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Emitted once, at the end of a successful `initialize` call.
const TOPIC_INIT: &str = "boost_nft_init";
/// Emitted at the end of a successful `set_admin` call.
const TOPIC_ADMIN_SET: &str = "boost_nft_admin_set";
/// Emitted at the end of a successful `mint` call.
/// Topics: `(Symbol, to: Address, token_id: u64)`
/// Data:   `(token_id, to, tier, milestone, timestamp)`
const TOPIC_MINTED: &str = "boost_nft_minted";
/// Emitted at the end of a successful `transfer` call.
/// Topics: `(Symbol, from: Address, to: Address, token_id: u64)`
/// Data:   `(token_id, from, to, timestamp)`
const TOPIC_TRANSFERRED: &str = "boost_nft_transferred";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct BoostNft;

#[contractimpl]
impl BoostNft {
    /// Initialize the collection. Call once right after deploy.
    ///
    /// - `admin` may mint directly and rotate the admin.
    /// - `minter` is the savings-vault contract address (the only non-admin
    ///   caller allowed to `mint`).
    ///
    /// Errors: `AlreadyInitialized` if called a second time.
    pub fn initialize(env: Env, admin: Address, minter: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        extend_instance_ttl(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Minter, &minter);
        env.storage().instance().set(&DataKey::NextTokenId, &0u64);

        env.events()
            .publish((TOPIC_INIT,), (admin, minter, env.ledger().timestamp()));
        Ok(())
    }

    /// The configured admin address.
    pub fn admin(env: Env) -> Result<Address, Error> {
        get_admin(&env).ok_or(Error::NotInitialized)
    }

    /// The configured minter address (the savings-vault contract).
    pub fn minter(env: Env) -> Result<Address, Error> {
        get_minter(&env).ok_or(Error::NotInitialized)
    }

    /// Rotate the admin. Current-admin only.
    pub fn set_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), Error> {
        extend_instance_ttl(&env);
        let current = get_admin(&env).ok_or(Error::NotInitialized)?;
        caller.require_auth();
        if caller != current {
            return Err(Error::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events()
            .publish((TOPIC_ADMIN_SET,), (current, new_admin, env.ledger().timestamp()));
        Ok(())
    }

    /// Mint a boost token to `to` for the given `tier` and `milestone`.
    ///
    /// Only the configured `minter` (the savings vault) or the `admin` may
    /// call this; `caller` must authorize. Returns the new token id.
    ///
    /// Errors: `NotInitialized`, `Unauthorized` if `caller` is neither the
    /// minter nor the admin, `Overflow` if the id counter is exhausted.
    pub fn mint(
        env: Env,
        caller: Address,
        to: Address,
        tier: Tier,
        milestone: i128,
    ) -> Result<u64, Error> {
        extend_instance_ttl(&env);
        let admin = get_admin(&env).ok_or(Error::NotInitialized)?;
        let minter = get_minter(&env).ok_or(Error::NotInitialized)?;
        caller.require_auth();
        if caller != minter && caller != admin {
            return Err(Error::Unauthorized);
        }

        let token_id = next_token_id(&env)?;
        let now = env.ledger().timestamp();
        let data = NftData {
            token_id,
            owner: to.clone(),
            tier,
            milestone,
            minted_at: now,
        };

        let tkey = DataKey::Token(token_id);
        env.storage().persistent().set(&tkey, &data);
        extend_persistent_ttl(&env, &tkey);

        let mut list = owner_tokens(&env, &to);
        list.push_back(token_id);
        set_owner_tokens(&env, &to, &list);

        env.events().publish(
            (TOPIC_MINTED, to.clone(), token_id),
            (token_id, to, tier, milestone, now),
        );
        Ok(token_id)
    }

    /// Transfer `token_id` from its current owner `from` to `to`. `from` must
    /// authorize and must own the token. The boost the token grants moves to
    /// `to` (the savings vault reads current holders from this contract).
    ///
    /// Errors: `NotFound` if the token does not exist, `Unauthorized` if
    /// `from` does not own it.
    pub fn transfer(env: Env, from: Address, to: Address, token_id: u64) -> Result<(), Error> {
        extend_instance_ttl(&env);
        from.require_auth();

        let tkey = DataKey::Token(token_id);
        let mut data: NftData = env
            .storage()
            .persistent()
            .get(&tkey)
            .ok_or(Error::NotFound)?;
        extend_persistent_ttl(&env, &tkey);
        if data.owner != from {
            return Err(Error::Unauthorized);
        }

        data.owner = to.clone();
        env.storage().persistent().set(&tkey, &data);
        extend_persistent_ttl(&env, &tkey);

        let mut from_list = owner_tokens(&env, &from);
        from_list = without_token(&env, &from_list, token_id);
        set_owner_tokens(&env, &from, &from_list);

        let mut to_list = owner_tokens(&env, &to);
        to_list.push_back(token_id);
        set_owner_tokens(&env, &to, &to_list);

        env.events().publish(
            (TOPIC_TRANSFERRED, from.clone(), to.clone(), token_id),
            (token_id, from, to, env.ledger().timestamp()),
        );
        Ok(())
    }

    /// The current owner of `token_id`.
    ///
    /// Errors: `NotFound` if the token does not exist.
    pub fn owner_of(env: Env, token_id: u64) -> Result<Address, Error> {
        let tkey = DataKey::Token(token_id);
        let data: NftData = env
            .storage()
            .persistent()
            .get(&tkey)
            .ok_or(Error::NotFound)?;
        extend_persistent_ttl(&env, &tkey);
        Ok(data.owner)
    }

    /// The number of tokens currently held by `owner`.
    pub fn balance_of(env: Env, owner: Address) -> u64 {
        let key = DataKey::OwnerTokens(owner);
        let list: Vec<u64> = env.storage().persistent().get(&key).unwrap_or(Vec::new(&env));
        extend_persistent_ttl(&env, &key);
        u64::from(list.len())
    }

    /// The tier carried by `token_id`.
    ///
    /// Errors: `NotFound` if the token does not exist.
    pub fn tier_of(env: Env, token_id: u64) -> Result<Tier, Error> {
        let tkey = DataKey::Token(token_id);
        let data: NftData = env
            .storage()
            .persistent()
            .get(&tkey)
            .ok_or(Error::NotFound)?;
        extend_persistent_ttl(&env, &tkey);
        Ok(data.tier)
    }

    /// Full metadata for `token_id`.
    ///
    /// Errors: `NotFound` if the token does not exist.
    pub fn token(env: Env, token_id: u64) -> Result<NftData, Error> {
        let tkey = DataKey::Token(token_id);
        let data: NftData = env
            .storage()
            .persistent()
            .get(&tkey)
            .ok_or(Error::NotFound)?;
        extend_persistent_ttl(&env, &tkey);
        Ok(data)
    }

    /// The list of token ids currently held by `owner` (empty if none).
    pub fn tokens_of(env: Env, owner: Address) -> Vec<u64> {
        let key = DataKey::OwnerTokens(owner);
        let list: Vec<u64> = env.storage().persistent().get(&key).unwrap_or(Vec::new(&env));
        extend_persistent_ttl(&env, &key);
        list
    }

    /// Total number of tokens minted (the next id minus one).
    pub fn total_supply(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextTokenId).unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
