//! Storage migration infrastructure (#618).
//!
//! # Purpose
//!
//! When the contract's Wasm is upgraded, the in-storage data schema may
//! need to change: fields added, removed, or retyped. This module provides
//! the versioned migration runner that is called by the `migrate` entrypoint
//! immediately after an upgrade executes.
//!
//! # Pattern
//!
//! Each upgrade from version N → N+1 adds a migration step guarded by a
//! `from_version` check:
//!
//! ```rust,ignore
//! fn migration_v1_to_v2(env: &Env) -> Result<(), Error> {
//!     // read old keys, write new keys, remove stale keys
//!     Ok(())
//! }
//! ```
//!
//! `run_migration` calls only the step matching the version *before* the
//! upgrade (i.e. the version stored when `migrate` is invoked is the new
//! version; the step to run is `new_version - 1 → new_version`).
//!
//! # Idempotency
//!
//! Each migration step is idempotent: running it twice must produce the same
//! result as running it once. This protects against accidental double-calls
//! and simplifies testing.
//!
//! # Balance preservation
//!
//! The only state that migrations may touch is *schema* state — DataKey
//! variants, their shapes, or configuration keys. Balance-holding keys
//! (`DataKey::Flexible`, `DataKey::Locked`, `DataKey::Goal`,
//! `DataKey::Group`, `DataKey::InterestAccount`) must only be rewritten
//! to convert their encoding, never to alter their numeric `balance` or
//! `principal` fields. Any step that would reduce a user's balance is
//! rejected at review time.

use soroban_sdk::Env;

use crate::error::Error;
use crate::storage::extend_instance_ttl;
use crate::upgrade;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run the migration step for the current contract version.
///
/// Intended to be called by `SavingsVault::migrate` immediately after a
/// successful `execute_upgrade`. The function reads the current version,
/// dispatches to the matching step, and returns.
///
/// If no step is registered for the current version the call is a no-op —
/// not all upgrades require a schema migration.
///
/// Admin authorization is enforced by the `migrate` entrypoint in `lib.rs`
/// before this function is reached; `run_migration` itself does not
/// re-check auth.
pub fn run_migration(env: &Env) -> Result<(), Error> {
    extend_instance_ttl(env);

    let current_version = upgrade::version(env);

    match current_version {
        // Version 1 is the genesis state: no migration needed.
        1 => Ok(()),

        // --- Future upgrade steps go here, e.g. ---
        //
        // 2 => migration_v1_to_v2(env),
        // 3 => migration_v2_to_v3(env),
        //
        // Guard each step by its target version so a re-run of the migration
        // after an accidental double-upgrade still picks the right step.

        // No registered migration for this version — no-op.
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------
//
// Add one private `fn migration_vN_to_vM(env: &Env) -> Result<(), Error>`
// per upgrade step and call it from the `match` above. Each step must:
//
//   1. Be idempotent.
//   2. Never reduce any user balance.
//   3. Leave the total token balance held by the contract unchanged.
//
// Example skeleton (not compiled — kept as documentation):
//
// ```rust
// fn migration_v1_to_v2(env: &Env) -> Result<(), Error> {
//     // If a new config key was introduced with version 2 and needs a default:
//     if !env.storage().instance().has(&DataKey::SomeNewKey) {
//         env.storage().instance().set(&DataKey::SomeNewKey, &default_value);
//     }
//     Ok(())
// }
// ```
