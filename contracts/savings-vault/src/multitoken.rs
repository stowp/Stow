//! Multi-token support — issue #436.
//!
//! Supports multiple stablecoins via a token whitelist. Users can deposit
//! any whitelisted token; the vault tracks per-token balances.
//!
//! # Design
//!
//! - The admin maintains a whitelist of accepted token addresses.
//! - The original vault token (set at `initialize`) is always whitelisted
//!   automatically.
//! - Each flexible account tracks balances per-token via a `Map<Address, i128>`.
//! - Conversion is handled at the **application layer**: the contract does
//!   not do on-chain swaps. Instead, it provides a `convert_balance` function
//!   that lets the admin set conversion rates between whitelisted tokens
//!   and lets users convert their balance from one token to another at the
//!   configured rate.
//!
//! # Storage
//!
//! - `DataKey::TokenWhitelist` — `Vec<Address>` of accepted tokens (instance).
//! - `DataKey::TokenBalance(owner)` — `Map<Address, i128>` of per-token
//!   balances (persistent).

use soroban_sdk::{token, Address, Env, Map, Vec};

use crate::admin;
use crate::error::Error;
use crate::storage::{self, extend_instance_ttl, extend_persistent_ttl};
use crate::types::DataKey;

// ── Whitelist management ──────────────────────────────────────────────────

/// Return the list of whitelisted token addresses.
pub fn get_whitelist(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::TokenWhitelist)
        .unwrap_or_else(|| {
            // If no whitelist is stored, the primary token (if set) is the
            // only entry.
            let mut v = Vec::new(env);
            if let Some(token) = storage::get_token(env) {
                v.push_back(token);
            }
            v
        })
}

/// Check if `token_addr` is in the whitelist.
pub fn is_whitelisted(env: &Env, token_addr: &Address) -> bool {
    get_whitelist(env).iter().any(|t| t == *token_addr)
}

/// Add a token to the whitelist. Admin-only.
///
/// - Requires `require_auth` from the admin.
/// - No-op if the token is already whitelisted (idempotent).
/// - Errors `NotInitialized` if no admin is set.
pub fn add_token(env: &Env, token_addr: Address) -> Result<(), Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    let mut whitelist = get_whitelist(env);
    if !whitelist.iter().any(|t| t == token_addr) {
        whitelist.push_back(token_addr.clone());
        env.storage()
            .instance()
            .set(&DataKey::TokenWhitelist, &whitelist);
    }

    Ok(())
}

/// Remove a token from the whitelist. Admin-only.
///
/// The primary vault token (set at `initialize`) cannot be removed.
pub fn remove_token(env: &Env, token_addr: Address) -> Result<(), Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    // The primary token cannot be removed.
    if let Some(primary) = storage::get_token(env) {
        if primary == token_addr {
            return Err(Error::InvalidParameters);
        }
    }

    let mut whitelist = get_whitelist(env);
    let mut updated = Vec::new(env);
    let mut found = false;
    for t in whitelist.iter() {
        if t == token_addr {
            found = true;
        } else {
            updated.push_back(t);
        }
    }
    if !found {
        return Err(Error::NotFound);
    }

    env.storage()
        .instance()
        .set(&DataKey::TokenWhitelist, &updated);

    Ok(())
}

// ── Multi-token deposit / withdraw ────────────────────────────────────────

/// Deposit `amount` of `token_addr` into the caller's multi-token balance.
///
/// - `from.require_auth()`.
/// - `token_addr` must be in the whitelist.
/// - Transfers tokens from `from` into the contract.
/// - Updates the per-token balance in `DataKey::TokenBalance(from)`.
pub fn deposit_token(
    env: &Env,
    from: Address,
    token_addr: Address,
    amount: i128,
) -> Result<(), Error> {
    admin::require_not_paused(env)?;
    extend_instance_ttl(env);
    from.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    if !is_whitelisted(env, &token_addr) {
        return Err(Error::InvalidParameters);
    }

    // Transfer tokens into the contract.
    let token_client = token::Client::new(env, &token_addr);
    token_client.transfer(&from, &env.current_contract_address(), &amount);

    // Update per-token balance.
    let key = DataKey::TokenBalance(from.clone());
    let mut balances: Map<Address, i128> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Map::new(env));
    let current = balances.get(token_addr.clone()).unwrap_or(0);
    let new_balance = current.checked_add(amount).ok_or(Error::Overflow)?;
    balances.set(token_addr, new_balance);
    env.storage().persistent().set(&key, &balances);
    extend_persistent_ttl(env, &key);

    Ok(())
}

/// Withdraw `amount` of `token_addr` from the caller's multi-token balance.
pub fn withdraw_token(
    env: &Env,
    owner: Address,
    token_addr: Address,
    amount: i128,
) -> Result<(), Error> {
    admin::require_not_paused(env)?;
    extend_instance_ttl(env);
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let key = DataKey::TokenBalance(owner.clone());
    let mut balances: Map<Address, i128> = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &key);

    let current = balances.get(token_addr.clone()).unwrap_or(0);
    if amount > current {
        return Err(Error::InsufficientBalance);
    }

    // Transfer tokens out.
    let token_client = token::Client::new(env, &token_addr);
    token_client.transfer(&env.current_contract_address(), &owner, &amount);

    let new_balance = current.checked_sub(amount).ok_or(Error::Overflow)?;
    if new_balance == 0 {
        balances.remove(token_addr.clone());
    } else {
        balances.set(token_addr, new_balance);
    }

    if balances.len() == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &balances);
        extend_persistent_ttl(env, &key);
    }

    Ok(())
}

/// Get the caller's per-token balances.
pub fn get_token_balances(env: &Env, owner: Address) -> Map<Address, i128> {
    let key = DataKey::TokenBalance(owner);
    let balances = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Map::new(env));
    if env.storage().persistent().has(&key) {
        extend_persistent_ttl(env, &key);
    }
    balances
}

// ── Conversion logic ──────────────────────────────────────────────────────

/// Conversion rate between two tokens, stored as `rate * 1_000_000` (6 dp).
///
/// `rate(from, to) = amount_of_to / amount_of_from * 1_000_000`
///
/// Stored under `DataKey::ConversionRate(from, to)` in instance storage.
pub fn get_conversion_rate(env: &Env, from: &Address, to: &Address) -> Result<u64, Error> {
    let key = DataKey::ConversionRate(from.clone(), to.clone());
    env.storage()
        .instance()
        .get(&key)
        .ok_or(Error::NotFound)
}

/// Set the conversion rate between two tokens. Admin-only.
///
/// `rate` is in units of `1/1_000_000` (i.e. 1_000_000 = 1:1 parity).
/// The reverse rate is NOT automatically set — call separately.
pub fn set_conversion_rate(
    env: &Env,
    from: Address,
    to: Address,
    rate: u64,
) -> Result<(), Error> {
    extend_instance_ttl(env);

    let admin = storage::get_admin(env).ok_or(Error::NotInitialized)?;
    admin.require_auth();

    if from == to {
        return Err(Error::InvalidParameters);
    }

    if !is_whitelisted(env, &from) || !is_whitelisted(env, &to) {
        return Err(Error::InvalidParameters);
    }

    let key = DataKey::ConversionRate(from.clone(), to.clone());
    env.storage().instance().set(&key, &rate);

    Ok(())
}

/// Convert `amount` of `from_token` to `to_token` in the caller's balance.
///
/// Uses the admin-configured conversion rate. Removes `amount` of
/// `from_token` from the user's balance and credits the converted amount
/// of `to_token`. No actual token transfer occurs — the conversion is
/// purely an accounting operation since the vault holds both tokens.
pub fn convert_balance(
    env: &Env,
    owner: Address,
    from_token: Address,
    to_token: Address,
    amount: i128,
) -> Result<i128, Error> {
    admin::require_not_paused(env)?;
    extend_instance_ttl(env);
    owner.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    if from_token == to_token {
        return Err(Error::InvalidParameters);
    }

    if !is_whitelisted(env, &from_token) || !is_whitelisted(env, &to_token) {
        return Err(Error::InvalidParameters);
    }

    let rate = get_conversion_rate(env, &from_token, &to_token)?;

    // converted = amount * rate / 1_000_000
    let converted = amount
        .checked_mul(rate as i128)
        .ok_or(Error::Overflow)?
        .checked_div(1_000_000)
        .ok_or(Error::DivisionByZero)?;

    if converted <= 0 {
        return Err(Error::InvalidAmount);
    }

    // Update balances.
    let key = DataKey::TokenBalance(owner.clone());
    let mut balances: Map<Address, i128> = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    extend_persistent_ttl(env, &key);

    // Deduct from_token.
    let from_balance = balances.get(from_token.clone()).unwrap_or(0);
    if amount > from_balance {
        return Err(Error::InsufficientBalance);
    }
    let new_from = from_balance.checked_sub(amount).ok_or(Error::Overflow)?;
    if new_from == 0 {
        balances.remove(from_token.clone());
    } else {
        balances.set(from_token, new_from);
    }

    // Credit to_token.
    let to_balance = balances.get(to_token.clone()).unwrap_or(0);
    let new_to = to_balance.checked_add(converted).ok_or(Error::Overflow)?;
    balances.set(to_token, new_to);

    env.storage().persistent().set(&key, &balances);
    extend_persistent_ttl(env, &key);

    Ok(converted)
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup_env() -> Env {
        let env = Env::default();
        env.mock_all_auths();
        env.storage().instance().set(&DataKey::TokenTransferActive, &false);
        env
    }

    #[test]
    fn whitelist_defaults_to_primary_token() {
        let env = setup_env();
        let token_addr = Address::generate(&env);
        env.storage().instance().set(&DataKey::Token, &token_addr);

        let wl = get_whitelist(&env);
        assert_eq!(wl.len(), 1);
        assert_eq!(wl.get(0).unwrap(), token_addr);
    }

    #[test]
    fn add_token_appends_to_whitelist() {
        let env = setup_env();
        let admin_addr = Address::generate(&env);
        let token1 = Address::generate(&env);
        let token2 = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Token, &token1);

        add_token(&env, token2.clone()).unwrap();

        let wl = get_whitelist(&env);
        assert_eq!(wl.len(), 2);
        assert!(is_whitelisted(&env, &token1));
        assert!(is_whitelisted(&env, &token2));
    }

    #[test]
    fn add_token_is_idempotent() {
        let env = setup_env();
        let admin_addr = Address::generate(&env);
        let token1 = Address::generate(&env);
        let token2 = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Token, &token1);

        add_token(&env, token2.clone()).unwrap();
        add_token(&env, token2.clone()).unwrap(); // no-op

        assert_eq!(get_whitelist(&env).len(), 2);
    }

    #[test]
    fn remove_token_removes_from_whitelist() {
        let env = setup_env();
        let admin_addr = Address::generate(&env);
        let token1 = Address::generate(&env);
        let token2 = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Token, &token1);

        add_token(&env, token2.clone()).unwrap();
        remove_token(&env, token2.clone()).unwrap();

        assert!(!is_whitelisted(&env, &token2));
        assert!(is_whitelisted(&env, &token1));
    }

    #[test]
    fn remove_primary_token_rejected() {
        let env = setup_env();
        let admin_addr = Address::generate(&env);
        let token1 = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Token, &token1);

        assert_eq!(
            remove_token(&env, token1),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn remove_nonexistent_token_rejected() {
        let env = setup_env();
        let admin_addr = Address::generate(&env);
        let token1 = Address::generate(&env);
        let ghost = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Token, &token1);

        assert_eq!(remove_token(&env, ghost), Err(Error::NotFound));
    }

    #[test]
    fn get_token_balances_empty_for_new_user() {
        let env = setup_env();
        let user = Address::generate(&env);
        let balances = get_token_balances(&env, user);
        assert_eq!(balances.len(), 0);
    }

    // ── Conversion rate tests ────────────────────────────────────────────────

    #[test]
    fn set_conversion_rate_stores_value() {
        let env = setup_env();
        let admin_addr = Address::generate(&env);
        let token1 = Address::generate(&env);
        let token2 = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Token, &token1);
        add_token(&env, token2.clone()).unwrap();

        // 1_000_000 = 1:1 parity
        set_conversion_rate(&env, token1.clone(), token2.clone(), 1_000_000).unwrap();
        assert_eq!(get_conversion_rate(&env, &token1, &token2).unwrap(), 1_000_000);
    }

    #[test]
    fn set_conversion_rate_rejects_same_token() {
        let env = setup_env();
        let admin_addr = Address::generate(&env);
        let token1 = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Token, &token1);

        assert_eq!(
            set_conversion_rate(&env, token1.clone(), token1.clone(), 1_000_000),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn set_conversion_rate_rejects_non_whitelisted() {
        let env = setup_env();
        let admin_addr = Address::generate(&env);
        let token1 = Address::generate(&env);
        let unlisted = Address::generate(&env);
        env.storage().instance().set(&DataKey::Admin, &admin_addr);
        env.storage().instance().set(&DataKey::Token, &token1);

        assert_eq!(
            set_conversion_rate(&env, token1.clone(), unlisted, 1_000_000),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn get_conversion_rate_returns_not_found_when_unset() {
        let env = setup_env();
        let token1 = Address::generate(&env);
        let token2 = Address::generate(&env);
        assert_eq!(get_conversion_rate(&env, &token1, &token2), Err(Error::NotFound));
    }
}
