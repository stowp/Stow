#!/usr/bin/env python3
"""Offline trainer for the savings-account fraud detection model.

Trains the same class-balanced, L2-regularized logistic regression that
``fraud-detection.service.ts`` runs online, on the same features, and writes
a model JSON the service loads with ``FraudDetectionService.loadModel``.

Standard library only, so it runs anywhere Python 3.8+ is available.

Input: a JSON array, or JSON Lines, of labeled transactions::

    {"id": "tx-1", "accountId": "acct-1", "amount": 120.5,
     "timestamp": "2026-10-01T14:03:00Z", "type": "withdrawal",
     "balanceBefore": 2500, "isFraud": false}

Usage::

    python fraud-detector.py train  labeled.jsonl -o fraud-model.json
    python fraud-detector.py score  fraud-model.json transactions.jsonl
    python fraud-detector.py evaluate fraud-model.json labeled.jsonl

Retraining on new fraud cases is simply ``train`` on the old data plus the
newly confirmed cases; the version number is bumped when ``--previous`` is
given.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

# Order matters: must match FEATURE_NAMES in fraud-detection.service.ts.
FEATURE_NAMES = [
    "amount_deviation",
    "unusual_hour",
    "night_time",
    "burst_frequency",
    "withdrawal",
    "balance_drain",
    "new_account",
]

HOUR_S = 3600
DAY_S = 24 * HOUR_S
MIN_AMOUNT_HISTORY = 3
MIN_HOUR_HISTORY = 5
NEW_ACCOUNT_S = 7 * DAY_S
MIN_LOG_STD = 0.25
MAX_AMOUNT_DEVIATION = 10.0
HOUR_WINDOW = 2
MAX_HISTORY = 500
DEFAULT_THRESHOLD = 0.7


def parse_ts(value: str) -> float:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def clamp(v: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, v))


def hour_distance(a: int, b: int) -> int:
    d = abs(a - b) % 24
    return min(d, 24 - d)


@dataclass
class History:
    """Per-account behavioural history (mirrors TransactionHistory)."""

    accounts: Dict[str, List[Tuple[float, float, int]]] = field(default_factory=dict)
    first_seen: Dict[str, float] = field(default_factory=dict)

    def featurize(self, tx: dict) -> List[float]:
        ts = parse_ts(tx["timestamp"])
        hour = datetime.fromtimestamp(ts, tz=timezone.utc).hour
        history = self.accounts.get(tx["accountId"], [])
        amount = max(0.0, float(tx["amount"]))
        log_amount = math.log1p(amount)

        amount_deviation = 0.0
        if len(history) >= MIN_AMOUNT_HISTORY:
            logs = [math.log1p(a) for _, a, _ in history]
            mean = sum(logs) / len(logs)
            var = sum((v - mean) ** 2 for v in logs) / len(logs)
            std = max(math.sqrt(var), MIN_LOG_STD)
            amount_deviation = clamp(
                (log_amount - mean) / std, -MAX_AMOUNT_DEVIATION, MAX_AMOUNT_DEVIATION
            )

        unusual_hour = 0.0
        if len(history) >= MIN_HOUR_HISTORY:
            near = sum(1 for _, _, h in history if hour_distance(h, hour) <= HOUR_WINDOW)
            unusual_hour = 1 - near / len(history)

        night_time = 1.0 if hour < 5 else 0.0
        recent = sum(1 for t, _, _ in history if t <= ts and ts - t <= HOUR_S)
        burst_frequency = math.log1p(recent)
        withdrawal = 1.0 if tx["type"] == "withdrawal" else 0.0

        drain = 0.0
        balance = tx.get("balanceBefore")
        if tx["type"] != "deposit" and balance is not None and balance > 0:
            drain = clamp(amount / float(balance), 0.0, 1.0)

        first = self.first_seen.get(tx["accountId"])
        new_account = 1.0 if first is None or ts - first < NEW_ACCOUNT_S else 0.0

        return [
            amount_deviation,
            unusual_hour,
            night_time,
            burst_frequency,
            withdrawal,
            drain,
            new_account,
        ]

    def record(self, tx: dict) -> None:
        ts = parse_ts(tx["timestamp"])
        hour = datetime.fromtimestamp(ts, tz=timezone.utc).hour
        entries = self.accounts.setdefault(tx["accountId"], [])
        entries.append((ts, max(0.0, float(tx["amount"])), hour))
        if len(entries) > MAX_HISTORY:
            entries.pop(0)
        first = self.first_seen.get(tx["accountId"])
        if first is None or ts < first:
            self.first_seen[tx["accountId"]] = ts


def featurize_all(txs: Iterable[dict]) -> List[Tuple[List[float], dict]]:
    history = History()
    out = []
    for tx in sorted(txs, key=lambda t: parse_ts(t["timestamp"])):
        out.append((history.featurize(tx), tx))
        history.record(tx)
    return out


def sigmoid(z: float) -> float:
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)


def predict(model: dict, values: Sequence[float]) -> Tuple[float, List[float]]:
    z = model["bias"]
    contributions = []
    for i, v in enumerate(values):
        c = model["weights"][i] * (v - model["mean"][i]) / model["std"][i]
        contributions.append(c)
        z += c
    return sigmoid(z), contributions


def fit(
    xs: List[List[float]],
    ys: List[bool],
    epochs: int = 2000,
    lr: float = 0.5,
    l2: float = 1e-3,
) -> dict:
    m = len(xs)
    if m == 0:
        raise ValueError("cannot train on an empty dataset")
    n = len(FEATURE_NAMES)
    mean = [sum(x[i] for x in xs) / m for i in range(n)]
    std = []
    for i in range(n):
        s = math.sqrt(sum((x[i] - mean[i]) ** 2 for x in xs) / m)
        std.append(s if s >= 1e-9 else 1.0)
    zs = [[(x[i] - mean[i]) / std[i] for i in range(n)] for x in xs]

    positives = sum(1 for y in ys if y)
    negatives = m - positives
    pos_w = m / (2 * positives) if positives else 1.0
    neg_w = m / (2 * negatives) if negatives else 1.0

    weights = [0.0] * n
    bias = 0.0
    for _ in range(epochs):
        grad = [0.0] * n
        grad_b = 0.0
        for x, y in zip(zs, ys):
            z = bias + sum(w * v for w, v in zip(weights, x))
            err = (sigmoid(z) - (1.0 if y else 0.0)) * (pos_w if y else neg_w)
            for i in range(n):
                grad[i] += err * x[i]
            grad_b += err
        for i in range(n):
            weights[i] -= lr * (grad[i] / m + l2 * weights[i])
        bias -= lr * (grad_b / m)

    return {"weights": weights, "bias": bias, "mean": mean, "std": std}


def metrics(model: dict, rows: List[Tuple[List[float], dict]]) -> dict:
    tp = fp = tn = fn = 0
    for values, tx in rows:
        flagged = predict(model, values)[0] >= model["threshold"]
        fraud = bool(tx["isFraud"])
        if flagged and fraud:
            tp += 1
        elif flagged:
            fp += 1
        elif fraud:
            fn += 1
        else:
            tn += 1
    total = len(rows) or 1
    return {
        "accuracy": (tp + tn) / total,
        "precision": tp / (tp + fp) if tp + fp else 0.0,
        "recall": tp / (tp + fn) if tp + fn else 0.0,
        "falsePositiveRate": fp / (fp + tn) if fp + tn else 0.0,
        "support": len(rows),
    }


def load_transactions(path: str) -> List[dict]:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read().strip()
    if not text:
        return []
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def load_model(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        model = json.load(fh)
    if model.get("feature_names") != FEATURE_NAMES:
        raise ValueError(f"model features must be {FEATURE_NAMES}")
    return model


def cmd_train(args: argparse.Namespace) -> int:
    txs = load_transactions(args.data)
    rows = featurize_all(txs)
    labels = [bool(tx["isFraud"]) for _, tx in rows]
    if not any(labels) or all(labels):
        print("training data needs both fraudulent and legitimate examples", file=sys.stderr)
        return 1

    version = 1
    if args.previous:
        version = int(load_model(args.previous).get("version", 0)) + 1

    params = fit([v for v, _ in rows], labels, args.epochs, args.lr, args.l2)
    model = {
        "version": version,
        "feature_names": FEATURE_NAMES,
        **params,
        "threshold": args.threshold,
        "trained_at": datetime.now(tz=timezone.utc).isoformat(),
        "training_size": len(rows),
    }
    model["metrics"] = metrics(model, rows)

    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(model, fh, indent=2)
    print(json.dumps({"version": version, **model["metrics"]}, indent=2))
    return 0


def explain(model: dict, values: List[float], top: int = 3) -> List[str]:
    _, contributions = predict(model, values)
    ranked = sorted(zip(FEATURE_NAMES, contributions), key=lambda p: -p[1])
    return [f"{name} (+{c:.2f})" for name, c in ranked[:top] if c > 0]


def cmd_score(args: argparse.Namespace) -> int:
    model = load_model(args.model)
    for values, tx in featurize_all(load_transactions(args.data)):
        probability, _ = predict(model, values)
        print(
            json.dumps(
                {
                    "transactionId": tx.get("id"),
                    "accountId": tx["accountId"],
                    "riskScore": round(probability * 100, 1),
                    "flagged": probability >= model["threshold"],
                    "topFactors": explain(model, values),
                }
            )
        )
    return 0


def cmd_evaluate(args: argparse.Namespace) -> int:
    model = load_model(args.model)
    rows = featurize_all(load_transactions(args.data))
    print(json.dumps(metrics(model, rows), indent=2))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    train = sub.add_parser("train", help="train a model on labeled transactions")
    train.add_argument("data")
    train.add_argument("-o", "--output", default="fraud-model.json")
    train.add_argument("--previous", help="previous model JSON, to bump its version")
    train.add_argument("--epochs", type=int, default=2000)
    train.add_argument("--lr", type=float, default=0.5)
    train.add_argument("--l2", type=float, default=1e-3)
    train.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    train.set_defaults(func=cmd_train)

    score = sub.add_parser("score", help="score transactions with a trained model")
    score.add_argument("model")
    score.add_argument("data")
    score.set_defaults(func=cmd_score)

    evaluate = sub.add_parser("evaluate", help="report metrics on labeled data")
    evaluate.add_argument("model")
    evaluate.add_argument("data")
    evaluate.set_defaults(func=cmd_evaluate)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
