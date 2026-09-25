//! Event topic registry.
//!
//! The off-chain indexer decodes contract events by topic. This module is
//! the canonical, compile-checked registry of topic name strings; the full
//! schema — data fields, types, encoding, and stability guarantees — is
//! documented in `README.md` under "Event schema". Keep the two in sync:
//! any change here (new topic, renamed topic) must be reflected there.
//!
//! Schema version: [`EVENT_SCHEMA_VERSION`]. Bump it whenever a change is
//! breaking for a decoder built against the previous version — see the
//! README's "Stability guarantees" for the exact rules.
//!
//! # Typed publishers
//!
//! Entrypoints never call `env.events().publish` directly; they call the
//! `publish_*` function for their topic below. Each publisher fixes the
//! topic tuple and the positional data tuple in one place, so the payload
//! an indexer decodes cannot drift between call sites, and every payload
//! documented in `README.md` maps 1:1 to exactly one function here.
//!
//! Every topic tuple starts with the topic name as a `Symbol` (built with
//! `Symbol::new`, since most names exceed `symbol_short!`'s 9-char limit).
//! Events about a specific depositor add that `Address` as the second topic,
//! and events about a specific withdraw request add its `u64` id as the
//! third, so an indexer can filter server-side without decoding data.

use soroban_sdk::{Address, BytesN, Env, String, Symbol};

/// Schema version for the event topics defined below, documented in
/// `README.md` ("Event schema"). A decoder should read this from the
/// `init` event's data payload to confirm it matches what it was built
/// against before trusting subsequent events on a given contract instance.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

// --- lifecycle -------------------------------------------------------------
/// Emitted once, at the end of a successful `initialize` call.
pub const TOPIC_INIT: &str = "init";
/// Emitted at the end of a successful `set_admin` call.
pub const TOPIC_ADMIN_SET: &str = "admin_set";
/// Emitted at the end of a successful `set_paused` call.
pub const TOPIC_PAUSED_CHANGED: &str = "paused_changed";
/// Emitted at the end of a successful `upgrade` call.
pub const TOPIC_UPGRADED: &str = "upgraded";

// --- deposit / withdraw ------------------------------------------------------
/// Emitted at the end of a successful `deposit` call.
pub const TOPIC_DEPOSITED: &str = "deposited";
/// Emitted at the end of a successful `request_withdraw` call.
pub const TOPIC_WITHDRAW_REQUESTED: &str = "withdraw_requested";
/// Emitted at the end of a successful `claim_withdraw` call.
pub const TOPIC_WITHDRAW_CLAIMED: &str = "withdraw_claimed";
/// Emitted at the end of a successful `cancel_withdraw` call.
pub const TOPIC_WITHDRAW_CANCELLED: &str = "withdraw_cancelled";

// --- strategy ----------------------------------------------------------------
/// Emitted at the end of a successful `register_strategy` call.
pub const TOPIC_STRATEGY_REGISTERED: &str = "strategy_registered";
/// Emitted at the end of a successful `deregister_strategy` call.
pub const TOPIC_STRATEGY_DEREGISTERED: &str = "strategy_deregistered";
/// Emitted at the end of a successful `set_active_strategy` or
/// `migrate_strategy` call.
pub const TOPIC_STRATEGY_CHANGED: &str = "strategy_changed";

// --- harvest / fees ------------------------------------------------------------
/// Emitted at the end of a successful `harvest` call.
pub const TOPIC_HARVESTED: &str = "harvested";
/// Emitted at the end of a successful `withdraw_fees` call.
pub const TOPIC_FEE_COLLECTED: &str = "fee_collected";

// --- typed publishers: lifecycle ---------------------------------------------

/// `init` — topics `(init,)`, data
/// `(admin, treasury, token, schema_version: u32, timestamp: u64)`.
pub fn publish_init(env: &Env, admin: &Address, treasury: &Address, token: &Address) {
    env.events().publish(
        (Symbol::new(env, TOPIC_INIT),),
        (
            admin.clone(),
            treasury.clone(),
            token.clone(),
            EVENT_SCHEMA_VERSION,
            env.ledger().timestamp(),
        ),
    );
}

/// `admin_set` — topics `(admin_set,)`, data
/// `(previous_admin, new_admin, timestamp: u64)`.
pub fn publish_admin_set(env: &Env, previous_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (Symbol::new(env, TOPIC_ADMIN_SET),),
        (
            previous_admin.clone(),
            new_admin.clone(),
            env.ledger().timestamp(),
        ),
    );
}

/// `paused_changed` — topics `(paused_changed,)`, data
/// `(caller, paused: bool, timestamp: u64)`.
pub fn publish_paused_changed(env: &Env, caller: &Address, paused: bool) {
    env.events().publish(
        (Symbol::new(env, TOPIC_PAUSED_CHANGED),),
        (caller.clone(), paused, env.ledger().timestamp()),
    );
}

/// `upgraded` — topics `(upgraded,)`, data
/// `(caller, new_wasm_hash: BytesN<32>, timestamp: u64)`.
pub fn publish_upgraded(env: &Env, caller: &Address, new_wasm_hash: &BytesN<32>) {
    env.events().publish(
        (Symbol::new(env, TOPIC_UPGRADED),),
        (
            caller.clone(),
            new_wasm_hash.clone(),
            env.ledger().timestamp(),
        ),
    );
}

// --- typed publishers: deposit / withdraw ---------------------------------------

/// `deposited` — topics `(deposited, owner)`, data
/// `(owner, assets: i128, shares_minted: i128, position_shares: i128,
/// timestamp: u64)`.
pub fn publish_deposited(
    env: &Env,
    owner: &Address,
    assets: i128,
    shares_minted: i128,
    position_shares: i128,
) {
    env.events().publish(
        (Symbol::new(env, TOPIC_DEPOSITED), owner.clone()),
        (
            owner.clone(),
            assets,
            shares_minted,
            position_shares,
            env.ledger().timestamp(),
        ),
    );
}

/// `withdraw_requested` — topics `(withdraw_requested, owner, request_id)`,
/// data `(request_id: u64, owner, shares_burned: i128, assets: i128,
/// claimable_at: u64, timestamp: u64)`.
pub fn publish_withdraw_requested(
    env: &Env,
    request_id: u64,
    owner: &Address,
    shares_burned: i128,
    assets: i128,
    claimable_at: u64,
) {
    env.events().publish(
        (
            Symbol::new(env, TOPIC_WITHDRAW_REQUESTED),
            owner.clone(),
            request_id,
        ),
        (
            request_id,
            owner.clone(),
            shares_burned,
            assets,
            claimable_at,
            env.ledger().timestamp(),
        ),
    );
}

/// `withdraw_claimed` — topics `(withdraw_claimed, owner, request_id)`, data
/// `(request_id: u64, owner, assets: i128, timestamp: u64)`.
pub fn publish_withdraw_claimed(env: &Env, request_id: u64, owner: &Address, assets: i128) {
    env.events().publish(
        (
            Symbol::new(env, TOPIC_WITHDRAW_CLAIMED),
            owner.clone(),
            request_id,
        ),
        (request_id, owner.clone(), assets, env.ledger().timestamp()),
    );
}

/// `withdraw_cancelled` — topics `(withdraw_cancelled, owner, request_id)`,
/// data `(request_id: u64, owner, assets: i128, shares_reminted: i128,
/// timestamp: u64)`.
pub fn publish_withdraw_cancelled(
    env: &Env,
    request_id: u64,
    owner: &Address,
    assets: i128,
    shares_reminted: i128,
) {
    env.events().publish(
        (
            Symbol::new(env, TOPIC_WITHDRAW_CANCELLED),
            owner.clone(),
            request_id,
        ),
        (
            request_id,
            owner.clone(),
            assets,
            shares_reminted,
            env.ledger().timestamp(),
        ),
    );
}

// --- typed publishers: strategy ------------------------------------------------

/// `strategy_registered` — topics `(strategy_registered, strategy_id)`, data
/// `(strategy_id: u64, address, name: String, timestamp: u64)`.
pub fn publish_strategy_registered(env: &Env, strategy_id: u64, address: &Address, name: &String) {
    env.events().publish(
        (Symbol::new(env, TOPIC_STRATEGY_REGISTERED), strategy_id),
        (
            strategy_id,
            address.clone(),
            name.clone(),
            env.ledger().timestamp(),
        ),
    );
}

/// `strategy_changed` — topics `(strategy_changed,)`, data
/// `(from: Option<u64>, to: Option<u64>, assets_moved: i128, timestamp: u64)`.
///
/// `from: None` on first activation (`set_active_strategy`); `to: None` on
/// `circuit_breaker::emergency_withdraw_all`. `assets_moved` is the amount
/// of vault token actually moved as part of the change (`0` when nothing is
/// moved, e.g. on first activation).
pub fn publish_strategy_changed(env: &Env, from: Option<u64>, to: Option<u64>, assets_moved: i128) {
    env.events().publish(
        (Symbol::new(env, TOPIC_STRATEGY_CHANGED),),
        (from, to, assets_moved, env.ledger().timestamp()),
    );
}
