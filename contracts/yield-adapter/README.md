# yield-adapter

Optional, opt-in yield-routing adapter for **Stow**, on Stellar/Soroban (Rust, `soroban-sdk` 22).

`savings-vault` custodies principal with no yield logic (by design — see its
README). This crate is the separate, swappable layer referenced in the root
`README.md`'s "Contract Layout" section as `yield_adapter/`: it accepts
deposits (in the same SEP-41 token as `savings-vault`, e.g. USDC), routes
idle balances into a registered external "strategy" contract, and reports
yield back to depositors via a share-based exchange rate — never by touching
`savings-vault`'s own storage.

This crate is a **skeleton**. Every entrypoint is stubbed with
`unimplemented!()` and a `TODO(issue)` comment describing intended behavior
and acceptance criteria. Each stub is designed to become one GitHub issue.
The reference below documents the contract's intended, stable interface so
integrators (indexer, backend, frontend) can build against it without
reading the stub bodies.

## Contents

- [Module → issue map](#module--issue-map)
- [Layout](#layout)
- [Build & test](#build--test)
- [Wasm size budget & optimization](#wasm-size-budget--optimization)
- [Strategy interface](#strategy-interface)
- [Entrypoint reference](#entrypoint-reference)
- [Event schema](#event-schema)

## Module → issue map

| Module | Entrypoints | Suggested issues |
| --- | --- | --- |
| `admin` | `initialize`, `set_admin`, `set_treasury`, `set_performance_fee_bps`, `set_paused`, `set_withdraw_cooldown`, `upgrade` | one issue each |
| `storage` | TTL + accessors, SEP-41 transfer helpers | storage helpers, TTL policy, transfer helpers |
| `strategy` | `register_strategy`, `deregister_strategy`, `set_active_strategy`, `migrate_strategy`, `set_strategy_deposit_cap`, `get_strategy`, `list_strategies` | one issue each |
| `deposit` | `deposit`, `get_position` | deposit + share minting, position read |
| `withdraw` | `request_withdraw`, `claim_withdraw`, `cancel_withdraw`, `get_withdraw_request` | one issue each |
| `accounting` | `total_assets`, `total_shares`, `convert_to_shares`, `convert_to_assets`, `exchange_rate` | share math + rounding-direction audit |
| `harvest` | `harvest`, `apply_performance_fee`, `check_harvest_interval` | one issue each |
| `fees` | `validate_fee_bps`, `fees_accrued`, `withdraw_fees` | fee cap validation, fee sweep |
| `circuit_breaker` | `emergency_withdraw_all` | one issue |
| `events` | typed publishers | one issue per event topic |
| `test` | integration tests | one issue per `#[ignore]`d test |

## Layout

```text
src/
  lib.rs              # contract + entrypoints (delegates to modules)
  types.rs            # data structures + DataKey storage keys
  storage.rs          # storage/TTL helpers, SEP-41 transfer helpers
  admin.rs            # init + admin/treasury/fee/pause config
  strategy.rs         # strategy registry (register/activate/migrate)
  deposit.rs          # deposit -> mint shares
  withdraw.rs         # cooldown-queued withdrawals
  accounting.rs       # share <-> asset conversion, exchange rate
  harvest.rs          # report strategy yield/loss, performance fee
  fees.rs             # sweep accrued fees to treasury
  circuit_breaker.rs  # emergency pull of funds out of the strategy
  events.rs           # event topic registry (see "Event schema" below)
  test.rs             # test skeleton
```

## Build & test

```bash
cargo build --target wasm32-unknown-unknown --release
cargo test           # placeholder tests are #[ignore]d until implemented
```

> Note: entrypoints currently `unimplemented!()` — they compile but panic at
> runtime until a contributor implements them. The signatures, auth rules,
> and error contracts documented in each module's doc comments and below are
> the stable target to implement against.

## Wasm size budget & optimization

CI builds this crate, runs `stellar contract optimize`, and fails if the
optimized wasm exceeds `WASM_SIZE_BUDGET_BYTES` (see
`.github/workflows/contract-ci.yml`, `yield-adapter` job). Currently set to
the same 64 KiB starting budget as `savings-vault`; revisit once the crate
is implemented and its real size is known.

## Strategy interface

A "strategy" is any external contract registered via `register_strategy`.
This adapter treats it as opaque and reaches it only through
`env.invoke_contract`. At minimum a usable strategy must expose:

- `deposit(from: Address, amount: i128)` — accept `amount` of the shared
  SEP-41 token from the adapter.
- `withdraw(to: Address, amount: i128)` — return `amount` to the adapter.
- `balance(of: Address) -> i128` — report the adapter's current claim,
  **including** any accrued yield (or loss) — this is what `harvest` diffs
  against the adapter's last-known deployed balance to compute yield.

A minimal in-repo mock implementing this interface (for tests) is tracked as
its own issue — see `test.rs`'s module doc.

**Trust boundary**: the adapter does not verify a strategy's solvency or
correctness beyond the `balance` figure it reports. A malicious or buggy
strategy can misreport yield (see `harvest::apply_performance_fee`'s
guard against charging fees on a loss, which limits — but does not
eliminate — the damage a lying strategy can do). Registering a strategy is
an explicit, admin-only trust decision; see `circuit_breaker` for the
emergency exit if that trust turns out to be misplaced.

## Entrypoint reference

See each module's doc comments (`admin.rs`, `strategy.rs`, `deposit.rs`,
`withdraw.rs`, `accounting.rs`, `harvest.rs`, `fees.rs`,
`circuit_breaker.rs`) for the authoritative, per-function contract: auth
requirements, validation order, and errors returned.

## Event schema

See `events.rs` for the canonical topic registry. Schema version:
`EVENT_SCHEMA_VERSION = 1`. Topics, grouped by area:

- Lifecycle: `init`, `admin_set`, `paused_changed`, `upgraded`
- Deposit/withdraw: `deposited`, `withdraw_requested`, `withdraw_claimed`, `withdraw_cancelled`
- Strategy: `strategy_registered`, `strategy_deregistered`, `strategy_changed`
- Harvest/fees: `harvested`, `fee_collected`

Each topic's exact data payload will be finalized alongside the entrypoint
that emits it (see the corresponding module doc comment) — documented here
once implemented, mirroring `savings-vault/README.md`'s "Event schema"
section.

### Topics

#### `init`
Topics: `(Symbol("init"),)`

| Field | Type | Description |
| --- | --- | --- |
| `admin` | `Address` | Initial admin. |
| `treasury` | `Address` | Initial treasury (receives collected performance fees). |
| `token` | `Address` | SEP-41 token this adapter routes. |
| `schema_version` | `u32` | Value of `EVENT_SCHEMA_VERSION` at deploy time. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `strategy_registered`
Topics: `(Symbol("strategy_registered"),)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | The newly allocated strategy id. |
| `address` | `Address` | The registered strategy contract's address. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `strategy_deregistered`
Topics: `(Symbol("strategy_deregistered"),)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | The deregistered strategy's id. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `strategy_changed`
Topics: `(Symbol("strategy_changed"),)`

| Field | Type | Description |
| --- | --- | --- |
| `from` | `Option<u64>` | Previously active strategy id, or `None` on first activation. |
| `to` | `Option<u64>` | Newly active strategy id, or `None` when `circuit_breaker::emergency_withdraw_all` clears the active strategy with nothing set in its place. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

Emitted by `set_active_strategy` (`from: None`), `migrate_strategy` (both
`from` and `to` set), and `circuit_breaker::emergency_withdraw_all`
(`to: None`) — the indexer can distinguish first activation, migration, and
emergency-clear purely from which of `from`/`to` is present.

#### `harvested`
Topics: `(Symbol("harvested"),)`

| Field | Type | Description |
| --- | --- | --- |
| `caller` | `Address` | Whoever called `harvest` (permissionless keeper pattern — attribution only, not an auth check). |
| `delta` | `i128` | Signed change in the strategy's deployed balance since the last harvest: positive is yield, negative is a loss. |
| `fee_taken` | `i128` | Performance fee charged on `delta`. Always `0` when `delta <= 0` — see `harvest::apply_performance_fee`'s doc for why a loss is never fee-charged. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

The indexer can build a full yield history purely from this topic: sum
`delta` for gross performance, sum `fee_taken` for fees generated.

#### `fee_collected`
Topics: `(Symbol("fee_collected"),)`

| Field | Type | Description |
| --- | --- | --- |
| `caller` | `Address` | Whoever called `withdraw_fees` (permissionless — funds only ever move to the fixed `treasury` address). |
| `amount` | `i128` | Amount swept to the treasury. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

Remaining topics (`admin_set`, `paused_changed`, `upgraded`, `deposited`,
`withdraw_requested`, `withdraw_claimed`, `withdraw_cancelled`) are declared
in `events.rs` but their publishers are not yet wired into the corresponding
entrypoints, which are themselves still unimplemented — see each module's
`TODO(issue)` doc comments. Documenting their payloads ahead of the
entrypoints that would emit them would drift out of sync with whatever the
eventual implementation actually needs.
