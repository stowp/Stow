# savings-vault

Non-custodial savings vault for **Stow**, on Stellar/Soroban (Rust, `soroban-sdk` 22).

This crate is a **skeleton**. Every entrypoint is stubbed with `unimplemented!()`
and a `TODO(issue)` comment describing intended behavior and acceptance criteria.
Each stub is designed to become one GitHub issue. The reference below documents
the contract's intended, stable interface so integrators (indexer, backend,
frontend) can build against it without reading the stub bodies.

## Contents

- [Module → issue map](#module--issue-map)
- [Layout](#layout)
- [Build & test](#build--test)
- [Wasm size budget & optimization](#wasm-size-budget--optimization)
- [Testnet deployment](#testnet-deployment)
- [Entrypoint reference](#entrypoint-reference)
- [Event schema](#event-schema)

## Module → issue map

| Module | Entrypoints | Suggested issues |
| --- | --- | --- |
| `admin` | `initialize`, `token`, `set_admin`, `set_deposit_cap`, `set_min_deposit`, `upgrade` | init guard, token config, admin rotation, deposit cap, minimum deposit, contract upgrade |
| `storage` | TTL + accessors | storage helpers, TTL tuning, id allocation |
| `flexible` | `deposit`, `withdraw`, `get_account` | one issue each |
| `locked` | `create`, `top_up`, `withdraw`, `plan` | create + time-lock enforcement, top-up, withdraw |
| `goal` | `create`, `contribute`, `claim`, `goal` | create, contribute + milestone, claim |
| `group` | `create`, `join`, `contribute`, `close`, `payout_equal` | one issue each |
| `group_split` | `set_shares`, `settle` | shares validation, weighted settlement |
| `events` | typed publishers | one issue per event topic |
| `test` | integration tests | one issue per `#[ignore]`d test |

## Layout

```text
src/
  lib.rs         # contract + entrypoints (delegates to modules)
  types.rs       # data structures + DataKey storage keys
  storage.rs     # storage/TTL helpers
  admin.rs       # init + admin
  flexible.rs    # flexible savings
  locked.rs      # locked savings
  goal.rs        # goal-based savings
  group.rs       # group pools
  group_split.rs # weighted group settlement
  events.rs      # event topic registry (see "Event schema" below)
  test.rs        # test skeleton
```

## Build & test

```bash
cargo build --target wasm32-unknown-unknown --release
cargo test           # placeholder tests are #[ignore]d until implemented
```

> Note: entrypoints currently `unimplemented!()` — they compile but panic at
> runtime until a contributor implements them. The signatures, auth rules,
> errors, and events below are the contract this crate implements against;
> implementations must not deviate from them without updating this doc.

## Wasm size budget & optimization

CI builds the release wasm, runs `stellar contract optimize` against it, and
fails the build if the **optimized** wasm exceeds a size budget. This catches
size regressions before they reach a deployed contract.

The current budget is `65536` bytes (64 KiB), set via `WASM_SIZE_BUDGET_BYTES`
in the `savings-vault` job's `env:` block in
[`.github/workflows/contract-ci.yml`](../../.github/workflows/contract-ci.yml).
Raise it only alongside a deliberate decision to accept the size increase —
e.g. a new savings mechanism or a larger dependency — not as a routine fix
for a failing build.

To check locally:

```bash
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/savings_vault.wasm \
  --wasm-out target/wasm32-unknown-unknown/release/savings_vault.optimized.wasm
wc -c target/wasm32-unknown-unknown/release/savings_vault.optimized.wasm
```

## Testnet deployment

[`scripts/deploy_testnet.sh`](scripts/deploy_testnet.sh) builds, deploys, and
initializes the vault on Stellar testnet in one command, then prints the
deployed contract id:

```bash
SOURCE_ACCOUNT=alice ./scripts/deploy_testnet.sh
```

`SOURCE_ACCOUNT` must name a funded Stellar CLI identity (create one with
`stellar keys generate --fund --network testnet alice`). By default the
script wraps native XLM as the vault's token, since it's always available on
testnet with no setup. Env vars:

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SOURCE_ACCOUNT` | yes | — | Identity that deploys, pays fees, and becomes admin unless overridden. |
| `ADMIN_ACCOUNT` | no | `SOURCE_ACCOUNT`'s address | Address set as the vault admin. |
| `TOKEN_CONTRACT_ID` | no | — | Use an already-deployed SEP-41 token instead of wrapping an asset. |
| `TEST_ASSET` | no | `native` | Classic asset to wrap as the vault's token, as `CODE:ISSUER`. |
| `STELLAR_NETWORK` | no | `testnet` | Network passed to the Stellar CLI. |

---

## Entrypoint reference

All amounts are `i128` in the vault token's smallest unit (stroops for a
7-decimal SEP-41 token). All timestamps are `u64` ledger timestamps (seconds
since epoch, per `env.ledger().timestamp()`). Every entrypoint that mutates
state calls `require_auth()` on the address noted in **Auth** — the caller
must sign as that address (or hold a valid signature delegation for it).
Every entrypoint returns `Result<T, Error>`; see [`src/error.rs`](src/error.rs)
for the full, stable error enum (`Error` codes are append-only — safe to
match on by numeric discriminant).

Invocation examples use the `stellar` CLI against a deployed instance:

```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source alice \
  --network testnet \
  -- <function> --arg value ...
```

### Lifecycle

#### `initialize(admin: Address, token: Address) -> Result<(), Error>`
- **Auth:** none enforced by the contract; call once, immediately after
  deploy, from your deploy pipeline's identity.
- **Errors:** `AlreadyInitialized` if called a second time.
- **Events:** [`init`](#init).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- initialize \
  --admin GADMIN...ADDRESS \
  --token GTOKEN...ADDRESS
```

#### `token() -> Result<Address, Error>`
- **Auth:** none (read-only).
- **Errors:** `NotInitialized`.
- **Events:** none.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- token
```

#### `set_admin(new_admin: Address) -> Result<(), Error>`
- **Auth:** current admin.
- **Errors:** `NotInitialized`, `Unauthorized` if the caller is not the
  current admin.
- **Events:** [`admin_set`](#admin_set).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- set_admin --new_admin GNEWADMIN...ADDRESS
```

#### `deposit_cap() -> i128`
- **Auth:** none (read-only).
- **Returns:** the current per-account deposit cap, in token stroops. `0`
  means unlimited (the default before `set_deposit_cap` is ever called).
- **Errors:** none.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- deposit_cap
```

#### `set_deposit_cap(cap: i128) -> Result<(), Error>`
- **Auth:** current admin.
- **Errors:** `NotInitialized`, `InvalidAmount` if `cap < 0`.
- Takes effect immediately — the next `deposit` call is checked against the
  new value.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- set_deposit_cap --cap 1000000000
```

#### `min_deposit() -> i128`
- **Auth:** none (read-only).
- **Returns:** the current minimum deposit amount, in token stroops. `0`
  means no minimum (the default before `set_min_deposit` is ever called).
- **Errors:** none.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- min_deposit
```

#### `set_min_deposit(min: i128) -> Result<(), Error>`
- **Auth:** current admin.
- **Errors:** `NotInitialized`, `InvalidAmount` if `min < 0`.
- Takes effect immediately — the next `deposit` call is checked against the
  new value. Guards against dust deposits that waste storage.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- set_min_deposit --min 10000000
```

#### `upgrade(caller: Address, new_wasm_hash: BytesN<32>) -> Result<(), Error>`
- **Auth:** current admin.
- **Errors:** `NotInitialized`, `Unauthorized` if the caller is not the
  current admin.
- `new_wasm_hash` must already be uploaded to the ledger (e.g. via
  `stellar contract upload` or `Deployer::upload_contract_wasm`); this swaps
  the contract's currently-installed code for that Wasm. The swap takes
  effect after this invocation finishes; storage is **not** migrated —
  the new Wasm must stay compatible with existing persisted `DataKey`
  records or migrate them itself on next write.
- **Trust trade-off:** this gives the admin key total, unchecked control
  over the contract's logic, including the rules governing custodied
  funds — there is no on-chain check that a new Wasm preserves any
  invariant the old one had. It is deliberate for now (it lets bugs be
  patched post-deploy without a new contract address), but it means
  depositors trust the admin key's operational security as much as the
  code itself. A timelock and/or a multisig admin are tracked as follow-up
  hardening, not part of this issue.
- **Events:** [`upgraded`](#upgraded).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- upgrade --caller GADMIN...ADDRESS --new_wasm_hash <64-char-hex-hash>
```

### Flexible savings — deposit / withdraw any time

#### `deposit(from: Address, amount: i128) -> Result<(), Error>`
- **Auth:** `from`.
- **Errors:** `InvalidAmount` if `amount <= 0`, `NotInitialized`,
  `DepositCapExceeded` if the admin-configured per-account cap
  (`deposit_cap`, set via `set_deposit_cap`) is non-zero and the resulting
  balance would exceed it, `Overflow` if the resulting balance would not
  fit in `i128`.
- **Events:** [`deposit`](#deposit).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- deposit --from GALICE...ADDRESS --amount 1000000000
```

#### `withdraw(owner: Address, amount: i128) -> Result<(), Error>`
- **Auth:** `owner`.
- **Errors:** `NotFound` if no account exists for `owner`, `InvalidAmount`,
  `InsufficientBalance` if `amount` exceeds the account balance, `Overflow`
  (defensive; unreachable in practice since the balance check runs first).
- **Events:** [`withdraw`](#withdraw).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- withdraw --owner GALICE...ADDRESS --amount 500000000
```

#### `get_account(owner: Address) -> Result<FlexibleAccount, Error>`
- **Auth:** none (read-only).
- **Errors:** `NotFound`.
- **Events:** none.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- get_account --owner GALICE...ADDRESS
```

### Locked savings — deterministic on-chain time locks

#### `locked_create(owner: Address, amount: i128, unlock_at: u64) -> Result<u64, Error>`
- **Auth:** `owner`.
- **Errors:** `InvalidAmount`, `InvalidUnlockTime` if `unlock_at <= now`.
- **Returns:** the new plan id.
- **Events:** [`locked_created`](#locked_created).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- locked_create --owner GALICE...ADDRESS --amount 2000000000 --unlock_at 1798761600
```

#### `locked_top_up(owner: Address, plan_id: u64, amount: i128) -> Result<(), Error>`
- **Auth:** `owner`.
- **Errors:** `NotFound`, `Unauthorized` if `owner` does not own `plan_id`,
  `InvalidAmount`, `Overflow` if the resulting balance would not fit in
  `i128`.
- **Events:** [`locked_top_up`](#locked_top_up).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- locked_top_up --owner GALICE...ADDRESS --plan_id 1 --amount 500000000
```

#### `locked_withdraw(owner: Address, plan_id: u64, amount: i128) -> Result<(), Error>`
- **Auth:** `owner`.
- **Errors:** `NotFound`, `Unauthorized`, `InsufficientBalance` (checked
  before `StillLocked` so callers get the more actionable error when both
  conditions hold), `StillLocked` if `now < unlock_at`, `InvalidAmount`,
  `Overflow` (defensive; unreachable in practice since the balance check
  runs first).
- **Events:** [`locked_withdraw`](#locked_withdraw).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- locked_withdraw --owner GALICE...ADDRESS --plan_id 1 --amount 2500000000
```

#### `locked_plan(plan_id: u64) -> Result<LockedPlan, Error>`
- **Auth:** none (read-only).
- **Errors:** `NotFound`.
- **Events:** none.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- locked_plan --plan_id 1
```

### Goal savings — save toward a target with milestones

#### `goal_create(owner: Address, name: String, target_amount: i128) -> Result<u64, Error>`
- **Auth:** `owner`.
- **Errors:** `InvalidAmount` if `target_amount <= 0`.
- **Returns:** the new goal id.
- **Events:** [`goal_created`](#goal_created).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- goal_create --owner GALICE...ADDRESS --name "New laptop" --target_amount 5000000000
```

#### `goal_contribute(from: Address, goal_id: u64, amount: i128) -> Result<(), Error>`
- **Auth:** `from`.
- **Errors:** `NotFound`, `InvalidAmount`.
- **Events:** [`goal_contribution`](#goal_contribution), plus
  [`goal_reached`](#goal_reached) the call that first crosses `target_amount`.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- goal_contribute --from GALICE...ADDRESS --goal_id 1 --amount 1000000000
```

#### `goal_claim(owner: Address, goal_id: u64) -> Result<(), Error>`
- **Auth:** `owner`.
- **Errors:** `NotFound`, `Unauthorized`, `GoalNotReached` if `reached_at`
  is unset.
- **Events:** [`goal_claimed`](#goal_claimed).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- goal_claim --owner GALICE...ADDRESS --goal_id 1
```

#### `goal(goal_id: u64) -> Result<Goal, Error>`
- **Auth:** none (read-only).
- **Errors:** `NotFound`.
- **Events:** none.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- goal --goal_id 1
```

### Group savings — shared pools, equal payout

#### `group_create(creator: Address, name: String) -> Result<u64, Error>`
- **Auth:** `creator`.
- **Errors:** none beyond generic validation.
- **Returns:** the new group id; `creator` is the first member.
- **Events:** [`group_created`](#group_created).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- group_create --creator GALICE...ADDRESS --name "Vacation fund"
```

#### `group_join(member: Address, group_id: u64) -> Result<(), Error>`
- **Auth:** `member`.
- **Errors:** `NotFound`, `GroupClosed` if the group no longer accepts
  members.
- **Events:** [`group_joined`](#group_joined).
```bash
stellar contract invoke --id $CONTRACT_ID --source bob --network testnet \
  -- group_join --member GBOB...ADDRESS --group_id 1
```

#### `group_contribute(member: Address, group_id: u64, amount: i128) -> Result<(), Error>`
- **Auth:** `member`.
- **Errors:** `NotFound`, `NotAMember` if the caller has not joined,
  `InvalidAmount`.
- **Events:** [`group_contribution`](#group_contribution).
```bash
stellar contract invoke --id $CONTRACT_ID --source bob --network testnet \
  -- group_contribute --member GBOB...ADDRESS --group_id 1 --amount 1000000000
```

#### `group_close(creator: Address, group_id: u64) -> Result<(), Error>`
- **Auth:** `creator`.
- **Errors:** `NotFound`, `Unauthorized` if the caller is not the creator.
- **Events:** [`group_closed`](#group_closed).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- group_close --creator GALICE...ADDRESS --group_id 1
```

#### `group_payout_equal(caller: Address, group_id: u64) -> Result<(), Error>`
- **Auth:** `caller` — permissionless once the group is closed; any account
  can trigger settlement.
- **Errors:** `NotFound`, `GroupClosed` if the group has not been closed yet.
- **Events:** [`group_payout`](#group_payout), once per member.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- group_payout_equal --caller GALICE...ADDRESS --group_id 1
```

#### `group(group_id: u64) -> Result<Group, Error>`
- **Auth:** none (read-only).
- **Errors:** `NotFound`.
- **Events:** none.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- group --group_id 1
```

### Group-split savings — pool settled by agreed shares

Shares are basis points (`u32`, out of `10_000`) keyed by member `Address`;
see `group_split::TOTAL_BPS`.

#### `group_set_shares(creator: Address, group_id: u64, shares_bps: Map<Address, u32>) -> Result<(), Error>`
- **Auth:** `creator`; group must already be closed (`group_close`).
- **Errors:** `NotFound`, `Unauthorized`, `InvalidShares` if the values
  don't sum to exactly `10_000` or a key is not a group member.
- **Events:** [`group_shares_set`](#group_shares_set).
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- group_set_shares --creator GALICE...ADDRESS --group_id 1 \
  --shares_bps '{"GALICE...ADDRESS":6000,"GBOB...ADDRESS":4000}'
```

#### `group_settle(caller: Address, group_id: u64) -> Result<(), Error>`
- **Auth:** `caller` — permissionless once shares are set.
- **Errors:** `NotFound`, `InvalidShares` if shares were never configured,
  `Overflow` if a per-member share computation would not fit in `i128`.
- **Events:** [`group_split_settled`](#group_split_settled), once per member.
```bash
stellar contract invoke --id $CONTRACT_ID --source alice --network testnet \
  -- group_settle --caller GALICE...ADDRESS --group_id 1
```

---

## Event schema

**Version: `1`** (see [`events::EVENT_SCHEMA_VERSION`](src/events.rs)). The
[`init`](#init) event's data payload includes `schema_version` so an indexer
can assert it was built against a compatible schema before decoding
subsequent events from that contract instance.

### Stability guarantees

- **Topic names are stable identifiers.** Once shipped, a topic name is
  never renamed or reused for a different meaning.
- **Additive changes do not bump the version:** a new topic, or a new
  *trailing* field appended to an existing topic's data tuple, is
  backwards-compatible — existing decoders keep working, they just ignore
  the new field.
- **Breaking changes bump `EVENT_SCHEMA_VERSION`** and are called out in
  this section: removing a topic, removing or reordering an existing
  field, or changing a field's type.
- Field order within an event's data tuple is part of the schema — decode
  positionally, not by name.
- All events are best-effort ordering *within* a single contract
  invocation (topic emission order matches the order described below);
  cross-invocation ordering follows ledger close order.

### Encoding

Every event is published as `env.events().publish(topics, data)`:

- **Topics** — a tuple whose first element is always a `Symbol` naming the
  event (the constants in `src/events.rs`, e.g. `"deposit"`). Names longer
  than 9 characters use `Symbol::new`, not `symbol_short!`. Where noted, a
  second topic carries the primary subject `Address` and, for id-addressed
  records (locked plans, goals, groups), a third topic carries the `u64`
  id — both so indexers can filter server-side (`topic1 == owner`) without
  decoding every event's data.
- **Data** — a fixed-order tuple of the remaining fields, typed per the
  tables below. `Address`, `String`, `Map<Address, u32>` etc. decode as
  their standard Soroban XDR `ScVal` representations.

### Topics

#### `init`
Topics: `(Symbol("init"),)`

| Field | Type | Description |
| --- | --- | --- |
| `admin` | `Address` | Initial admin. |
| `token` | `Address` | SEP-41 token this vault custodies. |
| `schema_version` | `u32` | Value of `EVENT_SCHEMA_VERSION` at deploy time. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `admin_set`
Topics: `(Symbol("admin_set"),)`

| Field | Type | Description |
| --- | --- | --- |
| `previous_admin` | `Address` | Admin before rotation. |
| `new_admin` | `Address` | Admin after rotation. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `upgraded`
Topics: `(Symbol("upgraded"),)`

| Field | Type | Description |
| --- | --- | --- |
| `caller` | `Address` | Admin who triggered the upgrade. |
| `new_wasm_hash` | `BytesN<32>` | Hash of the newly-installed Wasm. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `deposit`
Topics: `(Symbol("deposit"), owner: Address)`

| Field | Type | Description |
| --- | --- | --- |
| `owner` | `Address` | Flexible account owner. |
| `amount` | `i128` | Amount deposited. |
| `balance` | `i128` | Resulting account balance. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `withdraw`
Topics: `(Symbol("withdraw"), owner: Address)`

| Field | Type | Description |
| --- | --- | --- |
| `owner` | `Address` | Flexible account owner. |
| `amount` | `i128` | Amount withdrawn. |
| `balance` | `i128` | Resulting account balance. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `locked_created`
Topics: `(Symbol("locked_created"), owner: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | New plan id. |
| `owner` | `Address` | Plan owner. |
| `amount` | `i128` | Initial funded amount. |
| `unlock_at` | `u64` | Ledger timestamp after which withdrawal is allowed. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `locked_top_up`
Topics: `(Symbol("locked_top_up"), owner: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Plan id. |
| `owner` | `Address` | Plan owner. |
| `amount` | `i128` | Amount added. |
| `balance` | `i128` | Resulting plan balance. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `locked_withdraw`
Topics: `(Symbol("locked_withdraw"), owner: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Plan id. |
| `owner` | `Address` | Plan owner. |
| `amount` | `i128` | Amount withdrawn. |
| `balance` | `i128` | Resulting plan balance. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `goal_created`
Topics: `(Symbol("goal_created"), owner: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | New goal id. |
| `owner` | `Address` | Goal owner. |
| `name` | `String` | Goal name. |
| `target_amount` | `i128` | Target to reach. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `goal_contribution`
Topics: `(Symbol("goal_contribution"), from: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Goal id. |
| `from` | `Address` | Contributor. |
| `amount` | `i128` | Amount contributed this call. |
| `saved_amount` | `i128` | Resulting cumulative saved amount. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `goal_reached`
Topics: `(Symbol("goal_reached"), owner: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Goal id. |
| `owner` | `Address` | Goal owner. |
| `saved_amount` | `i128` | Saved amount at the moment the target was crossed. |
| `target_amount` | `i128` | Target that was reached. |
| `timestamp` | `u64` | Ledger timestamp of the call (equals `reached_at`). |

#### `goal_claimed`
Topics: `(Symbol("goal_claimed"), owner: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Goal id. |
| `owner` | `Address` | Goal owner. |
| `amount` | `i128` | Amount transferred out (full saved balance). |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `group_created`
Topics: `(Symbol("group_created"), creator: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | New group id. |
| `creator` | `Address` | Group creator (first member). |
| `name` | `String` | Group name. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `group_joined`
Topics: `(Symbol("group_joined"), member: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Group id. |
| `member` | `Address` | Newly joined member. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `group_contribution`
Topics: `(Symbol("group_contribution"), member: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Group id. |
| `member` | `Address` | Contributor. |
| `amount` | `i128` | Amount contributed this call. |
| `balance` | `i128` | Resulting pool balance. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `group_closed`
Topics: `(Symbol("group_closed"), creator: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Group id. |
| `creator` | `Address` | Group creator. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `group_payout`
Topics: `(Symbol("group_payout"), member: Address, id: u64)`

Emitted once per member during a single `group_payout_equal` call.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Group id. |
| `member` | `Address` | Member paid out. |
| `amount` | `i128` | Amount transferred to this member. |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `group_shares_set`
Topics: `(Symbol("group_shares_set"), creator: Address, id: u64)`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Group id. |
| `creator` | `Address` | Group creator. |
| `shares_bps` | `Map<Address, u32>` | Configured per-member basis-point shares (sums to `10_000`). |
| `timestamp` | `u64` | Ledger timestamp of the call. |

#### `group_split_settled`
Topics: `(Symbol("group_split_settled"), member: Address, id: u64)`

Emitted once per member during a single `group_settle` call.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `u64` | Group id. |
| `member` | `Address` | Member settled. |
| `amount` | `i128` | Amount transferred to this member (rounding remainder goes to the creator's entry). |
| `timestamp` | `u64` | Ledger timestamp of the call. |
