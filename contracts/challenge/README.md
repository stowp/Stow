# challenge

Savings challenges for **Stow**, on Stellar/Soroban (Rust, `soroban-sdk` 22).

Participants pay an entry stake to join, save toward a goal before a deadline,
and are paid out after it. Successful participants share a prize pool made of
the penalties taken from unsuccessful participants' stakes.

## Layout

- `src/lib.rs` — the `ChallengeContract` entrypoints and payout logic
- `src/types.rs` — `ChallengeConfig`, `Challenge`, `Participant`, `Error`, storage keys
- `src/test/challenge_test.rs` — contract tests

## Build & test

```bash
cargo test
cargo build --target wasm32-unknown-unknown --release
```

## Challenge kinds

| Kind          | `target` means                                                       |
|---------------|----------------------------------------------------------------------|
| `TotalSaved`  | stroops saved                                                        |
| `Consistency` | distinct periods (`period` seconds, from creation) with a deposit    |
| `GrowthRate`  | growth over the first deposit, in basis points (`10_000` = doubled)  |

## Entrypoints

| Entrypoint                                   | Notes                                                    |
|----------------------------------------------|----------------------------------------------------------|
| `create_challenge(creator, config) -> u64`   | Creator auth. The creator does not join automatically.   |
| `join(participant, challenge_id)`            | Participant auth. Transfers `entry_fee` in.              |
| `deposit(participant, challenge_id, amount)` | Participant auth. Before the deadline only.              |
| `settle(challenge_id, participant) -> i128`  | Anyone, after the deadline. Pays the participant.        |
| `get_challenge`, `get_participant`, `get_participants`, `is_on_track` | Reads.          |

## Payouts

- Savings are always returned in full.
- Unsuccessful: stake minus `penalty_bps` of it.
- Successful: full stake plus an equal share of the pool. The last winner to
  settle also receives the rounding remainder, so the pool is paid exactly.
- Nobody succeeded, or fewer than `min_participants` joined: everyone gets
  their stake back, no penalty.

## Events

All topics are `("challenge", <name>)`.

| Name       | Data                                                         |
|------------|--------------------------------------------------------------|
| `created`  | `(id, creator, kind, target, entry_fee, deadline)`           |
| `joined`   | `(id, participant, stake)`                                   |
| `progress` | `(id, participant, amount, saved, deposits)`                 |
| `final`    | `(id, winners, prize_pool)` — on the first settlement        |
| `settled`  | `(id, participant, won, payout)`                             |
| `closed`   | `(id, prize_pool)` — after the last participant settles      |
