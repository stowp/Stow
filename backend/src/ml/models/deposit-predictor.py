#!/usr/bin/env python3
"""Offline trainer for the savings deposit prediction model.

Implements the same maths as ``savings-prediction.service.ts``:

* deposits are bucketed into weekly totals (weeks start Monday 00:00 UTC);
* a recency-weighted least-squares trend is fitted per user (weights halve
  every ``half_life_weeks``);
* forecasts follow a damped trend; the weighted residual spread gives the
  confidence interval;
* users with little history are shrunk toward a population prior.

``train`` learns the population prior and picks the half-life with the
lowest one-step-ahead error across every user's history. The model JSON it
writes is loaded by ``SavingsPredictionService.loadModel``.

Standard library only, so it runs anywhere Python 3.8+ is available.

Input: a JSON array, or JSON Lines, of deposits::

    {"userId": "user-1", "amount": 150, "timestamp": "2026-10-05T09:30:00Z"}

Usage::

    python deposit-predictor.py train    deposits.jsonl -o deposit-model.json
    python deposit-predictor.py predict  deposit-model.json deposits.jsonl \\
        --user user-1 --horizon 12 --confidence 0.9
    python deposit-predictor.py backtest deposit-model.json deposits.jsonl --holdout 4
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

WEEK_S = 7 * 24 * 3600
# Weeks are aligned to Monday 00:00 UTC (the epoch was a Thursday).
WEEK_OFFSET_S = 4 * 24 * 3600
Z_SCORES = {0.5: 0.6745, 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96, 0.99: 2.5758}
HALF_LIFE_GRID = [2, 4, 8, 13, 26, 52]
MIN_BACKTEST_WEEKS = 4
PRIOR_STRENGTH = 4
DEFAULT_DAMPING = 0.95


def parse_time(value: str) -> float:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def week_index(ts: float) -> int:
    return math.floor((ts - WEEK_OFFSET_S) / WEEK_S)


def load_deposits(path: str) -> Dict[str, List[Tuple[float, float]]]:
    """Return ``{user_id: [(timestamp, amount), ...]}``."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read().strip()
    if not text:
        return {}
    rows: Iterable[dict]
    if text.startswith("["):
        rows = json.loads(text)
    else:
        rows = (json.loads(line) for line in text.splitlines() if line.strip())
    users: Dict[str, List[Tuple[float, float]]] = defaultdict(list)
    for row in rows:
        amount = float(row["amount"])
        if amount <= 0:
            raise ValueError(f"deposit amounts must be positive: {row}")
        users[str(row["userId"])].append((parse_time(str(row["timestamp"])), amount))
    return dict(users)


def weekly_totals(deposits: List[Tuple[float, float]], as_of: Optional[float] = None) -> List[float]:
    if not deposits:
        return []
    start = week_index(min(ts for ts, _ in deposits))
    last = as_of if as_of is not None else max(ts for ts, _ in deposits)
    end = max(week_index(last), start)
    totals = [0.0] * (end - start + 1)
    for ts, amount in deposits:
        i = week_index(ts) - start
        if 0 <= i < len(totals):
            totals[i] += amount
    return totals


Fit = Tuple[float, float, Optional[float], int, float]


def fit_trend(series: List[float], half_life: float) -> Fit:
    """Return ``(level, trend, variance or None, weeks, effective_weeks)``.

    ``level`` is the fitted value at the latest week; ``effective_weeks`` is
    the effective sample size under the recency weights, (sum w)^2 / sum w^2.
    """
    n = len(series)
    if n == 0:
        return 0.0, 0.0, None, 0, 0.0
    if n == 1:
        return series[0], 0.0, None, 1, 1.0
    xs = [i - (n - 1) for i in range(n)]
    ws = [0.5 ** ((n - 1 - i) / half_life) for i in range(n)]
    sw = sum(ws)
    xm = sum(w * x for w, x in zip(ws, xs)) / sw
    ym = sum(w * y for w, y in zip(ws, series)) / sw
    sxx = sum(w * (x - xm) ** 2 for w, x in zip(ws, xs))
    sxy = sum(w * (x - xm) * (y - ym) for w, x, y in zip(ws, xs, series))
    trend = sxy / sxx if sxx > 0 else 0.0
    level = ym - trend * xm
    sse = sum(w * (y - (level + trend * x)) ** 2 for w, x, y in zip(ws, xs, series))
    n_eff = sw * sw / sum(w * w for w in ws)
    # Small-sample correction for the two fitted parameters.
    variance = (sse / sw) * (n_eff / (n_eff - 2)) if n_eff > 2 else None
    return level, trend, variance, n, n_eff


def shrink(fit: Fit, prior: dict) -> Tuple[float, float, float]:
    """Blend a personal fit with the prior. Returns ``(level, trend, sigma)``."""
    level, trend, variance, weeks, _ = fit
    strength = prior.get("strength", 0)
    weight = weeks / (weeks + strength) if strength > 0 else 1.0
    level = weight * level + (1 - weight) * prior.get("level", 0.0)
    trend = weight * trend + (1 - weight) * prior.get("trend", 0.0)
    prior_var = prior.get("sigma", 0.0) ** 2
    if variance is None:
        if strength > 0 and prior.get("sigma", 0.0) > 0:
            variance = prior_var
        else:
            variance = (0.5 * abs(level) + 1) ** 2
    else:
        variance = weight * variance + (1 - weight) * prior_var
    return level, trend, math.sqrt(variance)


def forecast_spread(sigma: float, effective_weeks: float, horizon: int) -> Tuple[float, float]:
    """``(weekly_sd, cumulative_sd)``: residual noise plus level uncertainty."""
    n = max(effective_weeks, 1.0)
    return sigma * math.sqrt(1 + 1 / n), sigma * math.sqrt(horizon + horizon * horizon / n)


def forecast_weeks(level: float, trend: float, damping: float, horizon: int) -> List[float]:
    out = []
    cumulative = 0.0
    for h in range(1, horizon + 1):
        cumulative += damping ** h
        out.append(max(0.0, level + trend * cumulative))
    return out


def train(users: Dict[str, List[Tuple[float, float]]], damping: float = DEFAULT_DAMPING,
          previous: Optional[dict] = None) -> dict:
    series = [weekly_totals(deps) for deps in users.values() if deps]
    if not series:
        raise ValueError("no deposit history to train on")

    best_half_life, best_error = 8, math.inf
    for half_life in HALF_LIFE_GRID:
        error, count = 0.0, 0
        for s in series:
            for t in range(MIN_BACKTEST_WEEKS, len(s)):
                level, trend, _, _, _ = fit_trend(s[:t], half_life)
                predicted = forecast_weeks(level, trend, damping, 1)[0]
                error += (predicted - s[t]) ** 2
                count += 1
        if count and error / count < best_error:
            best_error, best_half_life = error / count, half_life

    fits = [fit_trend(s, best_half_life) for s in series]
    variances = [f[2] for f in fits if f[2] is not None]
    return {
        "version": (previous or {}).get("version", 0) + 1,
        "half_life_weeks": best_half_life,
        "damping": damping,
        "prior": {
            "level": sum(f[0] for f in fits) / len(fits),
            "trend": sum(f[1] for f in fits) / len(fits),
            "sigma": math.sqrt(sum(variances) / len(variances)) if variances else 0.0,
            "strength": PRIOR_STRENGTH,
        },
        "trained_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "training_size": len(series),
    }


def predict(model: dict, deposits: List[Tuple[float, float]], horizon: int, confidence: float) -> dict:
    z = Z_SCORES[confidence]
    series = weekly_totals(deposits)
    fit = fit_trend(series, model["half_life_weeks"])
    level, trend, sigma = shrink(fit, model["prior"])
    weekly_sd, cumulative_sd = forecast_spread(sigma, fit[4], horizon)
    means = forecast_weeks(level, trend, model["damping"], horizon)
    expected = sum(means)
    spread = z * cumulative_sd
    return {
        "horizonWeeks": horizon,
        "confidence": confidence,
        "expectedDeposits": round(expected, 2),
        "lowerDeposits": round(max(0.0, expected - spread), 2),
        "upperDeposits": round(expected + spread, 2),
        "weekly": [
            {
                "week": i + 1,
                "expected": round(m, 2),
                "lower": round(max(0.0, m - z * weekly_sd), 2),
                "upper": round(m + z * weekly_sd, 2),
            }
            for i, m in enumerate(means)
        ],
    }


def backtest(model: dict, users: Dict[str, List[Tuple[float, float]]], holdout: int,
             confidence: float) -> dict:
    """Share of users whose holdout total fell inside the predicted interval."""
    z = Z_SCORES[confidence]
    inside = total = 0
    for deps in users.values():
        series = weekly_totals(deps)
        if len(series) <= holdout:
            continue
        train_part, actual = series[:-holdout], sum(series[-holdout:])
        fit = fit_trend(train_part, model["half_life_weeks"])
        level, trend, sigma = shrink(fit, model["prior"])
        expected = sum(forecast_weeks(level, trend, model["damping"], holdout))
        spread = z * forecast_spread(sigma, fit[4], holdout)[1]
        total += 1
        if max(0.0, expected - spread) <= actual <= expected + spread:
            inside += 1
    return {"users": total, "coverage": round(inside / total, 4) if total else None,
            "confidence": confidence, "holdoutWeeks": holdout}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p_train = sub.add_parser("train", help="train the population prior")
    p_train.add_argument("deposits")
    p_train.add_argument("-o", "--output", default="-")
    p_train.add_argument("--damping", type=float, default=DEFAULT_DAMPING)
    p_train.add_argument("--previous", help="previous model JSON (bumps the version)")

    p_predict = sub.add_parser("predict", help="forecast one user's deposits")
    p_predict.add_argument("model")
    p_predict.add_argument("deposits")
    p_predict.add_argument("--user", required=True)
    p_predict.add_argument("--horizon", type=int, default=12)
    p_predict.add_argument("--confidence", type=float, default=0.9, choices=sorted(Z_SCORES))

    p_backtest = sub.add_parser("backtest", help="check interval coverage on held-out weeks")
    p_backtest.add_argument("model")
    p_backtest.add_argument("deposits")
    p_backtest.add_argument("--holdout", type=int, default=4)
    p_backtest.add_argument("--confidence", type=float, default=0.9, choices=sorted(Z_SCORES))

    args = parser.parse_args(argv)
    users = load_deposits(args.deposits)

    if args.command == "train":
        previous = None
        if args.previous:
            with open(args.previous, encoding="utf-8") as fh:
                previous = json.load(fh)
        result = train(users, args.damping, previous)
        out = json.dumps(result, indent=2)
        if args.output == "-":
            print(out)
        else:
            with open(args.output, "w", encoding="utf-8") as fh:
                fh.write(out + "\n")
        return 0

    with open(args.model, encoding="utf-8") as fh:
        model = json.load(fh)
    if args.command == "predict":
        if args.user not in users:
            print(f"no deposits for user {args.user}", file=sys.stderr)
            return 1
        print(json.dumps(predict(model, users[args.user], args.horizon, args.confidence), indent=2))
    else:
        print(json.dumps(backtest(model, users, args.holdout, args.confidence), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
