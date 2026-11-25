# insurance-pool

Soroban contract that protects Stow savings against smart contract failures.

## How it works

1. **Capital** — underwriters call `deposit_capital(provider, amount)`.
2. **Policies** — a saver calls `quote_premium(coverage, duration)` and then
   `buy_policy(holder, coverage, duration)`. The premium is
   `ceil(coverage * premium_rate_bps * duration / (10_000 * YEAR))` and is
   collected into the pool.
3. **Claims** — after a covered failure, the holder calls
   `file_claim(holder, policy_id, amount, incident_id)`. Anyone can then call
   `process_claim(claim_id)`, which asks the incident oracle for a verdict:
   - `Unknown` → `ClaimNotVerified`; the claim stays pending.
   - `Denied` → the claim is rejected; the policy stays active.
   - `Confirmed` → the payout goes to the holder in the same call.
4. **Expiry** — `expire_policy(policy_id)` releases an ended policy's coverage.

## Solvency

`stats()` reports the pool balance, active coverage, premiums, capital and
payouts. `coverage_ratio_bps()` is `balance * 10_000 / active_coverage`
(`None` when nothing is covered), and `is_solvent()` compares it with
`min_coverage_ratio_bps`. `buy_policy` and `withdraw_capital` are refused with
`CoverageRatioBreached` when they would push the ratio below that floor.

## Oracle interface

```rust
fn incident_status(env: Env, incident_id: BytesN<32>) -> IncidentStatus;
// IncidentStatus = Unknown | Confirmed | Denied
```

## Build & test

```sh
cargo test
cargo build --target wasm32-unknown-unknown --release
```
