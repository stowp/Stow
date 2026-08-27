//! Storage helpers and TTL management.
//!
//! Centralize all `env.storage()` access here so the persistence strategy
//! (instance vs. persistent, TTL bumping) lives in one place.
//!
//! # Storage model
//!
//! Soroban gives contracts three storage durabilities; this crate uses two
//! of them, chosen per [`DataKey`] variant as documented on each variant:
//!
//! - **Instance storage** — attached to the contract instance itself. Used
//!   for small, hot, singleton values that are read on nearly every call:
//!   `Token`, `Admin`, `DepositCap`, `Config`, and the `Next*Id` counters.
//!   Cheapest option for this shape of data, and its TTL is bumped as a
//!   single unit by [`extend_instance_ttl`], called at the top of every
//!   state-changing entrypoint — so as long as the contract sees any
//!   mutating traffic within the bump window, none of these values expire.
//! - **Persistent storage** — one entry per record, for unbounded
//!   collections keyed by user or id: `Flexible(Address)`, `Locked(u64)`,
//!   `Goal(u64)`, `Group(u64)`. These do **not** share a TTL with the
//!   instance; each entry's TTL is refreshed only when that specific entry
//!   is written. A record that is never touched again (e.g. a flexible
//!   account drained to zero and abandoned) will eventually hit its
//!   minimum persistent TTL and become eligible for archival by the
//!   network; reading an archived entry then requires a `restore` before
//!   the next `get`. This crate does not currently call
//!   `extend_ttl`/`restore` on individual persistent entries — tracked as
//!   follow-up work, not part of this documentation pass.
//!
//! ## TTL policy
//!
//! [`INSTANCE_BUMP_AMOUNT`] / [`INSTANCE_LIFETIME_THRESHOLD`] control the
//! instance TTL only (see constants below). Persistent entries have no
//! per-key policy configured here; they inherit the ledger's default
//! minimum persistent TTL and are refreshed implicitly by rewrites.
//!
//! ## Storage cost for large groups
//!
//! `Group` (see [`DataKey::Group`]) stores its full `members` vector and
//! `shares_bps` map inline in a single persistent entry. Every `join`,
//! `contribute`, `set_shares`, or `settle` call reads and rewrites that
//! entire entry, so per-call cost — and the rent required to keep the
//! entry's TTL alive — scales linearly with membership size. There is no
//! enforced cap on group size; a very large group is progressively more
//! expensive to mutate and to keep from expiring than a small one.

use soroban_sdk::{Address, Env};

use crate::types::DataKey;

// --- TTL constants (ledgers) --------------------------------------------
// TODO(issue): tune these for mainnet. Roughly: 1 ledger ~= 5s.
pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

/// Bump the instance TTL. Call at the top of every state-changing entrypoint.
pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// The token (e.g. USDC) this vault custodies, or `None` before `initialize`.
pub fn get_token(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Token)
}

/// Persist `DataKey::Token`.
pub fn set_token(env: &Env, token: &Address) {
    extend_instance_ttl(env);
    env.storage().instance().set(&DataKey::Token, token);
}

/// The contract admin, or `None` before `initialize`.
pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

/// Allocate and persist the next id for the given counter key.
///
/// Ids start at `1` (the counter reads `0` when absent, so the first
/// allocation returns `1`).
pub fn next_id(env: &Env, key: DataKey) -> u64 {
    let current: u64 = env.storage().instance().get(&key).unwrap_or(0);
    let next = current + 1;
    env.storage().instance().set(&key, &next);
    next
}
