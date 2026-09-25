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
  SEP-41 token from the adapter. The strategy **pulls** the funds itself by
  calling `token.transfer(from, <strategy>, amount)`; the adapter
  pre-authorizes exactly that one transfer (via
  `authorize_as_current_contract`) immediately before calling `deposit`,
  and is the direct invoker, so `from.require_auth()` inside the strategy
  succeeds.
- `withdraw(to: Address, amount: i128)` — transfer `amount` back to `to`
  (the adapter, which is the direct invoker). The adapter measures what
  actually arrived from its own token balance rather than trusting the call.
- `balance(of: Address) -> i128` — report the adapter's current claim,
  **including** any accrued yield (or loss) — this is what `harvest` diffs
  against the adapter's last-known deployed balance to compute yield. A
  negative report is treated as `0`.

`test.rs` contains a minimal mock (`mock_strategy::MockStrategy`)
implementing this interface plus a test-only `set_reported_balance` hook
for simulating yield/loss. A fuller mock for `harvest` / `migrate_strategy`
tests is still tracked as its own issue.

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

**Version: `1`** (see [`events::EVENT_SCHEMA_VERSION`](src/events.rs)). The
[`init`](#init) event's data payload includes `schema_version` so an indexer
can assert it was built against a compatible schema before decoding
subsequent events from that contract instance. Stability rules are the same
as `savings-vault`'s (see its README's "Stability guarantees"): topic names
are never renamed or reused; appending a trailing data field is additive;
removing/reordering fields or changing a type bumps the version.

### Encoding

Every event is emitted through a typed publisher in `src/events.rs`
(`publish_<topic>`), never by calling `env.events().publish` inline, so each
payload below maps to exactly one function.

- **Topics** — a tuple whose first element is always a `Symbol` naming the
  event (built with `Symbol::new`). Events about a specific depositor add
  that `Address` as the second topic; events about a specific withdraw
  request add its `u64` id as the third; `strategy_registered` adds the
  strategy id as the second. Filter server-side on these without decoding
  data.
- **Data** — a fixed-order tuple, typed per the tables below. Decode
  positionally, not by name.
- Events are only emitted by *successful* calls: a call that returns an
  error emits nothing (its state and events are rolled back).
- All amounts are `i128` vault-token stroops; shares are `i128`; all
  timestamps are `u64` ledger timestamps (`env.ledger().timestamp()`).

Topics, grouped by area:

- Lifecycle: [`init`](#init), [`admin_set`](#admin_set),
  [`paused_changed`](#paused_changed), [`upgraded`](#upgraded)
- Deposit/withdraw: [`deposited`](#deposited),
  [`withdraw_requested`](#withdraw_requested),
  [`withdraw_claimed`](#withdraw_claimed),
  [`withdraw_cancelled`](#withdraw_cancelled)
- Strategy: [`strategy_registered`](#strategy_registered),
  `strategy_deregistered`, [`strategy_changed`](#strategy_changed)
- Harvest/fees: `harvested`, `fee_collected`

`strategy_deregistered`, `harvested`, and `fee_collected` payloads will be
documented here alongside the entrypoints that emit them (still
unimplemented).

### Lifecycle

#### `init`
Emitted once, at the end of a successful `initialize`.
Topics: `(Symbol("init"),)`

| Field | Type | Description |
| --- | --- | --- |
| `admin` | `Address` | Initial admin. |
| `treasury` | `Address` | Initial fee treasury. |
| `token` | `Address` | SEP-41 token this adapter routes. |
| `schema_version` | `u32` | Value of `EVENT_SCHEMA_VERSION` at deploy time. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `admin_set`
Emitted at the end of a successful `set_admin`.
Topics: `(Symbol("admin_set"),)`

| Field | Type | Description |
| --- | --- | --- |
| `previous_admin` | `Address` | Admin before rotation. |
| `new_admin` | `Address` | Admin after rotation. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `paused_changed`
Emitted at the end of every successful `set_paused`, including one that
re-sets the current value.
Topics: `(Symbol("paused_changed"),)`

| Field | Type | Description |
| --- | --- | --- |
| `caller` | `Address` | Admin who made the call. |
| `paused` | `bool` | The pause flag after the call. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `upgraded`
To be emitted at the end of a successful `upgrade` (the typed publisher
`events::publish_upgraded` exists and its payload is fixed; the `upgrade`
entrypoint itself is still unimplemented).
Topics: `(Symbol("upgraded"),)`

| Field | Type | Description |
| --- | --- | --- |
| `caller` | `Address` | Admin who triggered the upgrade. |
| `new_wasm_hash` | `BytesN<32>` | Hash of the newly-installed Wasm. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

### Deposit / withdraw

#### `deposited`
Emitted at the end of a successful `deposit`.
Topics: `(Symbol("deposited"), owner: Address)`

| Field | Type | Description |
| --- | --- | --- |
| `owner` | `Address` | Depositor. |
| `assets` | `i128` | Vault-token amount deposited. |
| `shares_minted` | `i128` | Shares minted by this deposit. |
| `position_shares` | `i128` | Owner's total shares after the deposit. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `withdraw_requested`
Emitted at the end of a successful `request_withdraw`.
Topics: `(Symbol("withdraw_requested"), owner: Address, request_id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `request_id` | `u64` | New withdraw request id. |
| `owner` | `Address` | Request owner. |
| `shares_burned` | `i128` | Shares burned from the owner's position. |
| `assets` | `i128` | Payout fixed at request time. |
| `claimable_at` | `u64` | Ledger timestamp from which `claim_withdraw` is allowed. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `withdraw_claimed`
Emitted at the end of a successful `claim_withdraw`.
Topics: `(Symbol("withdraw_claimed"), owner: Address, request_id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `request_id` | `u64` | Withdraw request id. |
| `owner` | `Address` | Request owner (and payout recipient). |
| `assets` | `i128` | Amount transferred out. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `withdraw_cancelled`
Emitted at the end of a successful `cancel_withdraw`.
Topics: `(Symbol("withdraw_cancelled"), owner: Address, request_id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `request_id` | `u64` | Withdraw request id. |
| `owner` | `Address` | Request owner. |
| `assets` | `i128` | The request's fixed asset amount, returned to the pool. |
| `shares_reminted` | `i128` | Shares re-minted to the owner at the current rate (may differ from the shares originally burned). |
| `timestamp` | `u64` | Ledger timestamp of the call. |

### Strategy

#### `strategy_registered`
Emitted at the end of a successful `register_strategy`.
Topics: `(Symbol("strategy_registered"), strategy_id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `strategy_id` | `u64` | New strategy id. |
| `address` | `Address` | Strategy contract address. |
| `name` | `String` | Human-readable name. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `strategy_changed`
Emitted at the end of a successful `set_active_strategy` (`from: None`),
`circuit_breaker::emergency_withdraw_all` (`to: None`), and — once
implemented — `migrate_strategy` (both set).
Topics: `(Symbol("strategy_changed"),)`

| Field | Type | Description |
| --- | --- | --- |
| `from` | `Option<u64>` | Previously active strategy id, or `None`. |
| `to` | `Option<u64>` | Newly active strategy id, or `None` (funds held idle). |
| `assets_moved` | `i128` | Vault token actually moved by the change (`0` on first activation; the amount recovered on an emergency withdraw). |
| `timestamp` | `u64` | Ledger timestamp of the call. |
