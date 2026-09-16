"""Slab-based electricity tariff engine.

Indian domestic tariffs are telescopic: each slab's rate applies only to the
units falling inside that slab, not to the whole consumption. The default slabs
are Karnataka-style (BESCOM domestic LT-2a); all of it is editable in Settings.
"""
from __future__ import annotations

from typing import Any


def compute_bill(kwh: float, cfg: dict[str, Any]) -> dict:
    """Telescopic slab bill for `kwh` units in a month."""
    slabs = cfg.get("tariff_slabs") or []
    fixed = float(cfg.get("tariff_fixed_charge", 0))
    tax_pct = float(cfg.get("tariff_tax_pct", 0))

    remaining = max(0.0, kwh)
    lower = 0.0
    energy_charge = 0.0
    breakdown: list[dict] = []

    for slab in slabs:
        upto = slab.get("upto")
        rate = float(slab.get("rate", 0))
        capacity = float("inf") if upto is None else max(0.0, float(upto) - lower)
        units = min(remaining, capacity)
        if units > 0:
            cost = units * rate
            energy_charge += cost
            breakdown.append({
                "from": round(lower, 2),
                "to": None if upto is None else float(upto),
                "rate": rate,
                "units": round(units, 3),
                "cost": round(cost, 2),
            })
            remaining -= units
        lower = float(upto) if upto is not None else lower
        if remaining <= 0:
            break

    tax = (energy_charge + fixed) * tax_pct / 100.0
    total = energy_charge + fixed + tax

    return {
        "kwh": round(kwh, 3),
        "energy_charge": round(energy_charge, 2),
        "fixed_charge": round(fixed, 2),
        "tax": round(tax, 2),
        "total": round(total, 2),
        "currency": cfg.get("tariff_currency", "INR"),
        "symbol": cfg.get("currency_symbol", "₹"),
        "breakdown": breakdown,
        "effective_rate": round(total / kwh, 3) if kwh > 0 else 0.0,
    }


def next_slab_info(kwh: float, cfg: dict[str, Any]) -> dict:
    """How close consumption is to crossing into a more expensive slab.

    Answers the dashboard's "How close am I to the next slab?" query.
    """
    slabs = cfg.get("tariff_slabs") or []
    lower = 0.0
    for i, slab in enumerate(slabs):
        upto = slab.get("upto")
        if upto is None:
            return {
                "in_top_slab": True,
                "current_rate": float(slab.get("rate", 0)),
                "units_to_next": None,
                "next_rate": None,
                "boundary": None,
                "pct_through_slab": 100.0,
            }
        upto = float(upto)
        if kwh < upto:
            nxt = slabs[i + 1] if i + 1 < len(slabs) else None
            span = upto - lower
            return {
                "in_top_slab": False,
                "current_rate": float(slab.get("rate", 0)),
                "units_to_next": round(upto - kwh, 2),
                "next_rate": float(nxt.get("rate", 0)) if nxt else None,
                "boundary": upto,
                "pct_through_slab": round((kwh - lower) / span * 100, 1) if span > 0 else 0.0,
            }
        lower = upto

    return {
        "in_top_slab": True,
        "current_rate": float(slabs[-1].get("rate", 0)) if slabs else 0.0,
        "units_to_next": None,
        "next_rate": None,
        "boundary": None,
        "pct_through_slab": 100.0,
    }


def marginal_cost_of(kwh_extra: float, current_kwh: float, cfg: dict[str, Any]) -> float:
    """Cost of consuming `kwh_extra` more, accounting for slab crossings."""
    a = compute_bill(current_kwh, cfg)["total"]
    b = compute_bill(current_kwh + kwh_extra, cfg)["total"]
    return round(b - a, 2)
