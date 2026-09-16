"""Predictive analytics: short-term load forecast and month-end energy forecast.

Implemented on numpy alone (no sklearn dependency) with ridge-regularised least
squares over time features. Household load is strongly periodic over 24 h, so
the design matrix is a Fourier basis on time-of-day plus a linear trend --
cheap, stable on small histories, and easy to justify in a report.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

import numpy as np

HARMONICS = 3          # daily + 12 h + 8 h components
RIDGE_LAMBDA = 1e-2


def _design(ts_hours: np.ndarray, t0: float) -> np.ndarray:
    """[1, trend, sin/cos of day harmonics] for each timestamp (hours)."""
    tod = (ts_hours % 24.0) / 24.0 * 2 * math.pi
    cols = [np.ones_like(ts_hours), (ts_hours - t0) / 24.0]
    for k in range(1, HARMONICS + 1):
        cols.append(np.sin(k * tod))
        cols.append(np.cos(k * tod))
    return np.column_stack(cols)


def _fit(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    n_features = X.shape[1]
    A = X.T @ X + RIDGE_LAMBDA * np.eye(n_features)
    return np.linalg.solve(A, X.T @ y)


def forecast_power(
    history: list[tuple[int, float]],
    horizon_minutes: int = 120,
    step_minutes: int = 10,
) -> dict:
    """Forecast aggregate power for the next `horizon_minutes`.

    `history` is [(epoch_ms, watts)], oldest first.
    Returns points plus a +/-1 sigma band from the in-sample residuals.
    """
    if len(history) < 20:
        return {"points": [], "method": "insufficient_history", "sigma_w": 0.0}

    ts_ms = np.array([h[0] for h in history], dtype=float)
    watts = np.array([h[1] for h in history], dtype=float)
    hours = ts_ms / 3_600_000.0
    t0 = hours[0]

    span_h = hours[-1] - t0
    if span_h < 2.0:
        # Not enough history for the daily basis: fall back to an EWMA level.
        alpha = 0.1
        level = watts[0]
        for w in watts[1:]:
            level = alpha * w + (1 - alpha) * level
        sigma = float(np.std(watts[-60:])) if len(watts) >= 10 else 0.0
        pts = []
        last_ms = ts_ms[-1]
        for m in range(step_minutes, horizon_minutes + 1, step_minutes):
            pts.append({"ts_ms": int(last_ms + m * 60_000), "power_w": round(float(level), 1)})
        return {"points": pts, "method": "ewma", "sigma_w": round(sigma, 1)}

    X = _design(hours, t0)
    beta = _fit(X, watts)
    resid = watts - X @ beta
    sigma = float(np.std(resid))

    last_ms = ts_ms[-1]
    future_ms = np.array(
        [last_ms + m * 60_000 for m in range(step_minutes, horizon_minutes + 1, step_minutes)],
        dtype=float,
    )
    Xf = _design(future_ms / 3_600_000.0, t0)
    yhat = np.clip(Xf @ beta, 0.0, None)

    return {
        "points": [
            {
                "ts_ms": int(t),
                "power_w": round(float(p), 1),
                "lo_w": round(float(max(0.0, p - sigma)), 1),
                "hi_w": round(float(p + sigma), 1),
            }
            for t, p in zip(future_ms, yhat)
        ],
        "method": f"ridge_fourier_h{HARMONICS}",
        "sigma_w": round(sigma, 1),
    }


def forecast_month_kwh(
    daily: list[tuple[str, float]],
    today_kwh: float,
    now: datetime | None = None,
) -> dict:
    """Project total kWh for the current calendar month.

    `daily` is [(YYYY-MM-DD, kwh)] for completed days of this month.
    Today is extrapolated by how much of the day has elapsed, then the remaining
    days are added at the recent daily average.
    """
    now = now or datetime.now()
    days_in_month = (now.replace(day=28) + timedelta(days=4)).replace(day=1)
    days_in_month = (days_in_month - timedelta(days=1)).day

    completed = [kwh for day, kwh in daily if day != now.strftime("%Y-%m-%d")]
    month_so_far = sum(completed)

    # extrapolate today from elapsed fraction, floored so early mornings do not
    # explode the projection
    elapsed = (now.hour * 3600 + now.minute * 60 + now.second) / 86400.0
    today_projected = today_kwh / max(elapsed, 0.08)

    if completed:
        avg_day = sum(completed[-7:]) / len(completed[-7:])
    else:
        avg_day = today_projected

    remaining_days = max(0, days_in_month - now.day)
    projected = month_so_far + today_projected + remaining_days * avg_day

    return {
        "month_so_far_kwh": round(month_so_far + today_kwh, 3),
        "today_projected_kwh": round(today_projected, 3),
        "avg_daily_kwh": round(avg_day, 3),
        "days_elapsed": now.day,
        "days_in_month": days_in_month,
        "projected_month_kwh": round(projected, 2),
        "confidence": "high" if len(completed) >= 5 else ("medium" if completed else "low"),
    }
