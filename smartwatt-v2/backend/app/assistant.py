"""Energy Assistant: natural-language queries over live energy state.

Intent matching is rule-based and runs entirely offline - no API key, no model
download, deterministic answers, and every number it quotes is read from the
same live state the dashboard renders. Each handler returns text plus optional
structured data so the UI can render a chip or chart alongside the reply.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Callable

from . import billing, control, db
from .analytics.disaggregation import OTHER_ID
from .analytics.forecast import forecast_month_kwh

# Tips shown for specific appliance categories.
TIPS: dict[str, str] = {
    "ac": "Raise the AC to 26-27 C and clean the filters monthly. Every 1 C lower "
          "costs roughly 6% more energy.",
    "refrigerator": "Keep the fridge away from the wall and the stove, and check the "
                    "door gasket. A worn gasket can add 20% to its running cost.",
    "geyser": "Heat water only for as long as you need it. A 15-minute timer on a "
              "2 kW geyser saves more than almost any other single change.",
    "tv": "Switch the TV off at the socket. Standby draw is small but runs 24x7.",
    "fan": "Fans cost a fraction of an AC. Running a fan at 26 C feels like 23 C.",
    "lights": "Swap any remaining CFL or halogen fittings for LED; same light for "
              "about a fifth of the power.",
    "washing_machine": "Wash full loads on a cold cycle. Heating the water is most "
                       "of the machine's energy use.",
    "microwave": "A microwave is far more efficient than an oven for small portions.",
    "router": "The router is a small constant load; leave it on, it is not worth "
              "switching.",
}

GENERIC_TIPS = [
    "Shift heavy loads such as the washing machine to off-peak hours.",
    "Switching off at the socket avoids standby draw across the whole house.",
    "Track your daily budget - small daily savings compound across the billing cycle.",
]


class Assistant:
    def __init__(self, pipeline) -> None:
        self.pipeline = pipeline
        self.handlers: list[tuple[re.Pattern, Callable]] = [
            (re.compile(r"\b(help|what can you do|commands)\b", re.I), self._help),
            (re.compile(r"turn\s+(off|on)\s+every(thing|\s*one)|turn\s+(off|on)\s+all", re.I),
             self._control_all),
            (re.compile(r"\b(turn|switch)\s+(off|on)\b", re.I), self._control_one),
            (re.compile(r"\b(next\s+slab|slab|tariff\s+band)\b", re.I), self._slab),
            (re.compile(r"\b(bill|cost|projected|how much.*(pay|cost)|rupees)\b", re.I),
             self._bill),
            (re.compile(r"\b(which|what).*(most|highest|biggest|top)\b", re.I), self._top),
            (re.compile(
                r"\b(how many|how much)\b.*\b(kwh|unit|energy|consum|use|used|using|"
                r"draw|drawn|run|spent)", re.I), self._energy),
            (re.compile(r"\b(alert|warning|problem|anomal)", re.I), self._alerts),
            (re.compile(r"\b(voltage|current|volt|amp)\b", re.I), self._electrical),
            (re.compile(r"\b(tip|save|saving|advice|reduce|suggest)\b", re.I), self._tip),
            (re.compile(r"\b(status|now|live|right now|current power|power)\b", re.I),
             self._status),
            (re.compile(r"\b(forecast|predict|tomorrow|expect)\b", re.I), self._forecast),
        ]

    # ------------------------------------------------------------- helpers
    def _state(self, device_id: str) -> dict | None:
        rt = self.pipeline.runtimes.get(device_id)
        return rt.last if rt else None

    @staticmethod
    def _appliances(device_id: str) -> dict[str, dict]:
        rows = db.query("SELECT * FROM appliances WHERE device_id=?", (device_id,))
        return {r["id"]: dict(r) for r in rows}

    def _find_appliance(self, device_id: str, text: str) -> dict | None:
        """Resolve an appliance from free text by id, name or a common alias."""
        aliases = {
            "ac": ["ac", "air conditioner", "aircon", "a/c", "cooler"],
            "refrigerator": ["fridge", "refrigerator", "freezer"],
            "geyser": ["geyser", "water heater", "heater", "boiler"],
            "tv": ["tv", "television", "telly"],
            "fan": ["fan", "ceiling fan"],
            "lights": ["light", "lights", "lamp", "bulb"],
            "washing_machine": ["washing machine", "washer", "laundry"],
            "microwave": ["microwave", "oven"],
            "router": ["router", "wifi", "modem", "ont"],
        }
        low = text.lower()
        appliances = self._appliances(device_id)
        # longest alias first so "washing machine" beats "machine"
        candidates: list[tuple[int, str]] = []
        for aid, names in aliases.items():
            if aid not in appliances:
                continue
            for n in names:
                if re.search(rf"\b{re.escape(n)}\b", low):
                    candidates.append((len(n), aid))
        for aid, row in appliances.items():
            if re.search(rf"\b{re.escape(row['name'].lower())}\b", low):
                candidates.append((len(row["name"]), aid))
        if not candidates:
            return None
        return appliances[max(candidates)[1]]

    # ------------------------------------------------------------ handlers
    def _help(self, device_id: str, text: str, m) -> dict:
        return {
            "text": "I can answer questions about live usage, energy, bills and "
                    "alerts, and I can switch appliances on or off.",
            "suggestions": [
                "Which device uses most?",
                "How much did AC use today?",
                "Projected bill?",
                "How close am I to the next slab?",
                "Turn off AC",
                "Turn off everything except Refrigerator",
            ],
        }

    def _status(self, device_id: str, text: str, m) -> dict:
        s = self._state(device_id)
        if not s:
            return {"text": "No live data yet for this device."}
        on = [a["name"] for a in s["appliances"].values()
              if a["state"] and a["id"] != OTHER_ID]
        return {
            "text": f"Drawing {s['power_w']:.0f} W right now at {s['voltage_v']:.0f} V. "
                    f"Today's use is {s['today_kwh']:.3f} kWh. "
                    + (f"Running: {', '.join(on)}." if on else "Nothing significant is on."),
            "data": {"power_w": s["power_w"], "today_kwh": s["today_kwh"]},
        }

    def _electrical(self, device_id: str, text: str, m) -> dict:
        s = self._state(device_id)
        if not s:
            return {"text": "No live data yet."}
        return {
            "text": f"Voltage {s['voltage_v']:.1f} V, current {s['current_a']:.2f} A, "
                    f"power factor {s['pf']:.2f}, load {s['power_w']:.0f} W.",
            "data": {k: s[k] for k in ("voltage_v", "current_a", "pf", "power_w")},
        }

    def _top(self, device_id: str, text: str, m) -> dict:
        s = self._state(device_id)
        if not s:
            return {"text": "No live data yet."}
        items = [a for aid, a in s["appliances"].items() if aid != OTHER_ID]
        if not items:
            return {"text": "No appliance breakdown available yet."}

        # If most of the load is unattributed, naming the largest *identified*
        # appliance would be misleading -- an 18 W router is not "the biggest
        # load" in a 2 kW house.
        other = s["appliances"].get(OTHER_ID, {})
        biggest_known = max((a["power_w"] for a in items), default=0.0)
        if other.get("power_w", 0) > max(biggest_known, 30.0):
            raw_w = s.get("power_raw_w", s["power_w"])
            return {
                "text": f"{other['power_w']:.0f} W of the current {raw_w:.0f} W is "
                        "not yet attributed to a known appliance - the meter has not seen "
                        "those appliances switch on yet. Give it a few minutes of "
                        "switching activity and the breakdown will fill in.",
                "data": {"unattributed_w": other.get("power_w")},
            }

        by_power = max(items, key=lambda a: a["power_w"])
        # share of the whole house, unattributed load included
        total_wh = sum(a["energy_wh"] for a in s["appliances"].values()) or 1.0
        by_energy = max(items, key=lambda a: a["energy_wh"])
        share = by_energy["energy_wh"] / total_wh * 100
        return {
            "text": f"{by_power['name']} is the biggest load right now at "
                    f"{by_power['power_w']:.0f} W. Over today, {by_energy['name']} has "
                    f"used the most: {by_energy['energy_wh']/1000:.3f} kWh "
                    f"({share:.1f}% of the total).",
            "data": {"top_now": by_power["id"], "top_today": by_energy["id"],
                     "share_pct": round(share, 1)},
        }

    def _energy(self, device_id: str, text: str, m) -> dict:
        s = self._state(device_id)
        if not s:
            return {"text": "No live data yet."}
        appliance = self._find_appliance(device_id, text)
        if appliance:
            a = s["appliances"].get(appliance["id"])
            if not a:
                return {"text": f"No data for {appliance['name']} yet."}
            total_wh = sum(x["energy_wh"] for x in s["appliances"].values()) or 1.0
            share = a["energy_wh"] / total_wh * 100
            cfg = db.all_settings()
            cost = billing.marginal_cost_of(
                a["energy_wh"] / 1000.0, s["today_kwh"], cfg
            )
            return {
                "text": f"{a['name']} has used {a['energy_wh']/1000:.4f} kWh today "
                        f"({share:.1f}% of the house), about {cfg['currency_symbol']}{cost:.2f}. "
                        f"It is drawing {a['power_w']:.0f} W and is currently "
                        f"{'ON' if a['state'] else 'OFF'}.",
                "data": {"appliance": a["id"], "kwh": round(a["energy_wh"]/1000, 4),
                         "share_pct": round(share, 1), "cost": cost},
            }
        return {
            "text": f"The house has used {s['today_kwh']:.3f} kWh today, peaking at "
                    f"{s['peak_w_today']:.0f} W.",
            "data": {"today_kwh": s["today_kwh"]},
        }

    def _bill(self, device_id: str, text: str, m) -> dict:
        cfg = db.all_settings()
        s = self._state(device_id)
        today_kwh = s["today_kwh"] if s else 0.0
        month = datetime.now().strftime("%Y-%m")
        daily = [
            (r["day"], r["kwh"])
            for r in db.query(
                "SELECT day, kwh FROM daily_energy WHERE device_id=? AND day LIKE ? "
                "ORDER BY day", (device_id, f"{month}-%"))
        ]
        proj = forecast_month_kwh(daily, today_kwh)
        bill_now = billing.compute_bill(proj["month_so_far_kwh"], cfg)
        bill_proj = billing.compute_bill(proj["projected_month_kwh"], cfg)
        sym = cfg["currency_symbol"]
        return {
            "text": f"This month you have used {proj['month_so_far_kwh']:.2f} kWh, "
                    f"costing {sym}{bill_now['total']:.2f} so far. At your recent "
                    f"average of {proj['avg_daily_kwh']:.2f} kWh/day, the month should "
                    f"end near {proj['projected_month_kwh']:.1f} kWh, about "
                    f"{sym}{bill_proj['total']:.2f} ({proj['confidence']} confidence).",
            "data": {"current": bill_now, "projected": bill_proj, "forecast": proj},
        }

    def _slab(self, device_id: str, text: str, m) -> dict:
        cfg = db.all_settings()
        s = self._state(device_id)
        month = datetime.now().strftime("%Y-%m")
        daily = [
            (r["day"], r["kwh"])
            for r in db.query(
                "SELECT day, kwh FROM daily_energy WHERE device_id=? AND day LIKE ?",
                (device_id, f"{month}-%"))
        ]
        month_kwh = sum(k for d, k in daily if d != datetime.now().strftime("%Y-%m-%d"))
        month_kwh += s["today_kwh"] if s else 0.0
        info = billing.next_slab_info(month_kwh, cfg)
        sym = cfg["currency_symbol"]
        if info["in_top_slab"]:
            return {
                "text": f"At {month_kwh:.1f} kWh you are in the highest slab, paying "
                        f"{sym}{info['current_rate']}/unit. Every unit saved now saves "
                        f"the most it possibly can.",
                "data": info,
            }
        return {
            "text": f"You have used {month_kwh:.1f} kWh this month, paying "
                    f"{sym}{info['current_rate']}/unit. You are {info['units_to_next']:.1f} kWh "
                    f"below the {info['boundary']:.0f} kWh boundary, after which units cost "
                    f"{sym}{info['next_rate']}/unit. You are {info['pct_through_slab']:.0f}% "
                    "through the current slab.",
            "data": info,
        }

    def _alerts(self, device_id: str, text: str, m) -> dict:
        from . import alerts as alerts_mod
        active = alerts_mod.recent(device_id, limit=5, status="active")
        if not active:
            return {"text": "No active alerts. Everything looks normal."}
        lines = [f"{a['severity'].upper()}: {a['title']} - {a['message']}" for a in active]
        return {"text": f"{len(active)} active alert(s).\n" + "\n".join(lines),
                "data": {"alerts": active}}

    def _tip(self, device_id: str, text: str, m) -> dict:
        appliance = self._find_appliance(device_id, text)
        if appliance and appliance["id"] in TIPS:
            return {"text": TIPS[appliance["id"]], "data": {"appliance": appliance["id"]}}
        s = self._state(device_id)
        if s:
            items = [a for aid, a in s["appliances"].items() if aid != OTHER_ID]
            if items:
                top = max(items, key=lambda a: a["energy_wh"])
                tip = TIPS.get(top["id"], GENERIC_TIPS[0])
                return {"text": f"{top['name']} is your largest consumer today. {tip}",
                        "data": {"appliance": top["id"]}}
        return {"text": GENERIC_TIPS[0]}

    def _forecast(self, device_id: str, text: str, m) -> dict:
        from .analytics.forecast import forecast_power
        rt = self.pipeline.runtimes.get(device_id)
        if not rt or len(rt.history) < 20:
            return {"text": "Not enough history yet to forecast. Give it a few minutes."}
        f = forecast_power(list(rt.history), horizon_minutes=120, step_minutes=30)
        if not f["points"]:
            return {"text": "Not enough history yet to forecast."}
        nxt = f["points"][0]["power_w"]
        end = f["points"][-1]["power_w"]
        return {
            "text": f"Over the next two hours I expect load around {nxt:.0f} W rising "
                    f"or falling toward {end:.0f} W (model: {f['method']}, "
                    f"+/-{f['sigma_w']:.0f} W).",
            "data": f,
        }

    def _control_all(self, device_id: str, text: str, m) -> dict:
        on = bool(re.search(r"turn\s+on|switch\s+on", text, re.I))
        except_ids: list[str] = []
        exc = re.search(r"except\s+(?:the\s+)?(.+)$", text, re.I)
        if exc:
            for part in re.split(r",|\band\b", exc.group(1)):
                found = self._find_appliance(device_id, part)
                if found:
                    except_ids.append(found["id"])
        res = control.set_all(device_id, on, except_ids, source="assistant")
        word = "on" if on else "off"
        kept = f" Left running: {', '.join(res['skipped'])}." if res["skipped"] else ""
        if not res["changed"]:
            return {"text": f"Nothing to switch {word}.{kept}", "data": res}
        return {"text": f"Switched {word}: {', '.join(res['changed'])}.{kept}", "data": res}

    def _control_one(self, device_id: str, text: str, m) -> dict:
        on = bool(re.search(r"(turn|switch)\s+on", text, re.I))
        appliance = self._find_appliance(device_id, text)
        if not appliance:
            return {"text": "Which appliance? Try \"turn off AC\" or \"turn off the fan\"."}
        res = control.set_appliance(device_id, appliance["id"], on, source="assistant")
        if not res.get("ok"):
            return {"text": res.get("error", "That could not be switched."), "data": res}
        return {
            "text": f"{appliance['name']} switched {'on' if on else 'off'}.",
            "data": res,
        }

    # --------------------------------------------------------------- entry
    CONTROL_INTENTS = {"control_all", "control_one"}

    def classify(self, text: str) -> str:
        """Intent name for `text`, without running anything."""
        for pattern, handler in self.handlers:
            if pattern.search(text or ""):
                return handler.__name__.lstrip("_")
        return "unknown"

    def ask(self, device_id: str, text: str, can_control: bool = True) -> dict:
        text = (text or "").strip()
        if not text:
            return {"text": "Ask me something about your energy use."}
        for pattern, handler in self.handlers:
            m = pattern.search(text)
            if m:
                intent = handler.__name__.lstrip("_")
                # Permission is decided before the handler runs. Checking the
                # reply afterwards let a read-only user switch appliances and
                # merely receive a 403 once the relay had already moved.
                if intent in self.CONTROL_INTENTS and not can_control:
                    return {
                        "text": "Your account can view energy data but cannot switch "
                                "appliances.",
                        "intent": intent,
                        "forbidden": True,
                    }
                try:
                    reply = handler(device_id, text, m)
                except Exception as exc:  # a bad query must not 500 the API
                    reply = {"text": f"I could not work that out ({exc})."}
                reply.setdefault("intent", handler.__name__.lstrip("_"))
                return reply
        return {
            "text": "I did not follow that. Try \"which device uses most?\", "
                    "\"projected bill?\", or \"turn off AC\".",
            "intent": "unknown",
            "suggestions": [
                "Which device uses most?", "How many kWh today?",
                "Projected bill?", "Turn off AC",
            ],
        }
