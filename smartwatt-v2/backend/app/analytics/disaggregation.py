"""Appliance-level disaggregation (NILM) from the aggregate signal only.

Given the step events produced by `events.EdgeDetector`, match each edge against
a library of appliance power signatures and maintain a running estimate of which
appliances are on and how much each is drawing. Whatever cannot be attributed is
reported as "Other", which keeps the breakdown honest instead of forcing every
watt onto a known appliance.

Known limitation: several appliances switching inside one sustain window arrive
as a single merged step, which is attributed to the closest single signature
(e.g. AC + lights + fan read as a water heater). The state corrects itself at the
next OFF step of that load. Combinatorial matching over pairs/triples of
signatures was tried and rejected: it lowered steady-state accuracy from 0.877
to 0.837 and on the merged-step scenario fixed one seed while breaking another,
because sums of rated powers in this appliance set are too ambiguous.
"""
from __future__ import annotations

import statistics
import time
from collections import deque
from dataclasses import dataclass

OTHER_ID = "other"

# How often (seconds of simulated/real time) to re-check the residual and
# correct appliance states that edge matching missed.
RECONCILE_EVERY_S = 20.0

# Correction match window; tighter than edge matching so ambiguous
# signatures (AC 1500 W vs water heater 2000 W) are left alone.
RECONCILE_TOLERANCE = 0.15

# Above this unattributed share, attribution is clearly broken (typically a cold
# start) and reconciliation is switched on regardless of configuration.
COLD_START_SHARE = 0.25

# A relay switch-off shows up in the total a few samples later. An OFF step of
# the right size inside this window is credited to the appliance just switched.
PARKED_EDGE_WINDOW_MS = 20_000


@dataclass
class Signature:
    id: str
    name: str
    icon: str
    rated_w: float
    standby_w: float = 0.0
    behaviour: str = "occupancy"
    tolerance: float = 0.25      # fractional match window around rated_w


@dataclass
class _State:
    on: bool = False
    power_w: float = 0.0
    since_ts: int = 0
    energy_wh: float = 0.0
    confidence: float = 0.0
    # set when the relay cuts an appliance that was drawing power
    parked_at_ms: int = 0
    parked_power_w: float = 0.0


class Disaggregator:
    """Aggregate -> per-appliance attribution.

    `reconcile` is off by default. Measured over 8 simulated hours x 3 seeds it
    *lowered* mean attribution accuracy from 0.877 to 0.846: once the relaxed
    matching pass in `match_edge` resynchronises stale state, residual-based
    guessing adds more error than it removes. It is kept for noisy real-world
    meters where edges are genuinely lost.
    """

    def __init__(self, signatures: list[Signature], reconcile: bool = False) -> None:
        self.reconcile_enabled = reconcile
        self.signatures: dict[str, Signature] = {s.id: s for s in signatures}
        self.states: dict[str, _State] = {}
        for s in signatures:
            self.states[s.id] = self._fresh_state(s)
        self.other = _State(on=True, power_w=0.0, confidence=1.0)
        # appliances switched off at the relay: id -> (signature, state)
        self._disabled: dict[str, tuple[Signature, _State]] = {}
        self._residuals: deque[float] = deque(maxlen=64)
        self._since_reconcile = 0.0
        self._pending_fix: str | None = None
        # appliances credited by the most recent match_edge call
        self.last_match_ids: list[str] = []

    @staticmethod
    def _fresh_state(sig: Signature) -> _State:
        st = _State()
        if sig.behaviour == "always_on":
            st.on, st.power_w, st.confidence = True, sig.rated_w, 1.0
        else:
            st.power_w = sig.standby_w
        return st

    # ------------------------------------------------------------------ util
    def name_of(self, appliance_id: str) -> str | None:
        """Display name for an appliance, including ones switched off."""
        sig = self.signatures.get(appliance_id)
        if sig is None and appliance_id in self._disabled:
            sig = self._disabled[appliance_id][0]
        return sig.name if sig else None

    def restore_energy(self, appliance_id: str, energy_wh: float) -> None:
        """Seed today's energy-so-far for one appliance (used after a restart)."""
        if appliance_id == OTHER_ID:
            self.other.energy_wh = energy_wh
        elif appliance_id in self.states:
            self.states[appliance_id].energy_wh = energy_wh
        elif appliance_id in self._disabled:
            self._disabled[appliance_id][1].energy_wh = energy_wh

    def set_enabled(self, appliance_id: str, enabled: bool) -> None:
        """Relay control. A disabled appliance draws nothing, not even standby.

        It is parked outside `signatures`/`states`, so edge matching and
        reconciliation cannot attribute new load to something the user has cut
        off. The power it was drawing is remembered briefly so the resulting OFF
        step is labelled with it rather than logged as unidentified. Its energy
        so far is kept and restored when it is switched back on.
        """
        if not enabled:
            if appliance_id in self.signatures:
                sig = self.signatures.pop(appliance_id)
                st = self.states.pop(appliance_id)
                if st.on and st.power_w > sig.standby_w:
                    st.parked_power_w = st.power_w
                    st.parked_at_ms = int(time.time() * 1000)
                st.on, st.power_w, st.confidence = False, 0.0, 1.0
                self._disabled[appliance_id] = (sig, st)
        elif appliance_id in self._disabled:
            sig, st = self._disabled.pop(appliance_id)
            fresh = self._fresh_state(sig)
            st.on, st.power_w, st.confidence = fresh.on, fresh.power_w, fresh.confidence
            st.parked_at_ms, st.parked_power_w = 0, 0.0
            self.signatures[appliance_id] = sig
            self.states[appliance_id] = st

    def set_signatures(self, signatures: list[Signature]) -> None:
        """Re-sync the library (e.g. after an appliance is added) keeping state."""
        signatures = [s for s in signatures if s.id not in self._disabled]
        self.signatures = {s.id: s for s in signatures}
        for s in signatures:
            if s.id not in self.states:
                self.states[s.id] = self._fresh_state(s)
        for gone in set(self.states) - set(self.signatures):
            del self.states[gone]

    def force_off(self, appliance_id: str) -> None:
        st = self.states.get(appliance_id)
        if st:
            sig = self.signatures[appliance_id]
            st.on, st.power_w, st.confidence = False, sig.standby_w, 1.0

    # ------------------------------------------------------------- matching
    def _match_parked(self, magnitude: float) -> tuple[str | None, float]:
        """An OFF step right after a relay switch-off belongs to that appliance."""
        now_ms = int(time.time() * 1000)
        best_id, best_score = None, float("inf")
        for aid, (sig, st) in self._disabled.items():
            if st.parked_power_w <= 0 or now_ms - st.parked_at_ms > PARKED_EDGE_WINDOW_MS:
                continue
            score = abs(magnitude - st.parked_power_w) / st.parked_power_w
            if score < best_score:
                best_score, best_id = score, aid
        if best_id is None or best_score > self._disabled[best_id][0].tolerance:
            return None, 0.0
        sig, st = self._disabled[best_id]
        st.parked_power_w = 0.0          # one step per switch-off
        return best_id, round(max(0.0, 1.0 - best_score / sig.tolerance), 3)

    def match_edge(self, delta_w: float, ts: int) -> tuple[str | None, float]:
        """Attribute one edge to an appliance. Returns (appliance_id, confidence)."""
        magnitude = abs(delta_w)
        turning_on = delta_w > 0
        self.last_match_ids = []

        if not turning_on:
            parked_id, parked_conf = self._match_parked(magnitude)
            if parked_id is not None:
                self.last_match_ids = [parked_id]
                return parked_id, parked_conf

        best_id: str | None = None
        best_score = float("inf")
        for aid, sig in self.signatures.items():
            st = self.states[aid]
            if sig.behaviour == "always_on":
                continue
            if turning_on and st.on:
                continue            # already on, cannot turn on again
            if not turning_on and not st.on:
                continue            # already off, cannot turn off again

            # when switching off, compare against what we believe it is drawing
            expected = sig.rated_w if turning_on else max(st.power_w, sig.rated_w * 0.5)
            if expected <= 0:
                continue
            score = abs(magnitude - expected) / expected
            if score < best_score:
                best_score, best_id = score, aid

        relaxed = False
        if best_id is None or best_score > self.signatures[best_id].tolerance:
            # Strict pass failed. This usually means our belief about the
            # appliance is stale -- we missed its ON edge, so its OFF edge now
            # looks impossible. Retry ignoring the on/off constraint, which lets
            # the edge itself resynchronise the state.
            best_id, best_score = None, float("inf")
            for aid, sig in self.signatures.items():
                if sig.behaviour == "always_on" or sig.rated_w <= 0:
                    continue
                score = abs(magnitude - sig.rated_w) / sig.rated_w
                if score < best_score:
                    best_score, best_id = score, aid
            if best_id is None or best_score > self.signatures[best_id].tolerance:
                return None, 0.0
            relaxed = True

        confidence = round(max(0.0, 1.0 - best_score / self.signatures[best_id].tolerance), 3)
        if relaxed:
            confidence = round(confidence * 0.6, 3)
        st = self.states[best_id]
        sig = self.signatures[best_id]
        if turning_on:
            st.on = True
            st.power_w = magnitude
            st.since_ts = ts
        else:
            st.on = False
            st.power_w = sig.standby_w
        st.confidence = confidence
        self.last_match_ids = [best_id]
        return best_id, confidence

    # -------------------------------------------------------- reconciliation
    def _reconcile(self) -> None:
        """Correct states that edge matching missed.

        Edges are lost when two appliances switch within the same sustain
        window (their steps cancel) or when a step lands under the detector
        threshold. Both show up as a persistent residual, so a residual that
        looks like a known appliance's signature is folded back in.

        This is deliberately conservative: a correction needs a tight match
        (RECONCILE_TOLERANCE, tighter than edge matching) and has to survive two
        consecutive windows, otherwise a transient would latch an appliance on
        and it would never switch off again.
        """
        if len(self._residuals) < 8:
            return
        median_residual = statistics.median(self._residuals)

        candidate: str | None = None
        score_of_candidate = 1.0

        if median_residual > 25.0:
            # unattributed load: which switched-off appliance looks like it?
            best_id, best_score = None, float("inf")
            for aid, sig in self.signatures.items():
                if self.states[aid].on or sig.behaviour == "always_on":
                    continue
                score = abs(median_residual - sig.rated_w) / sig.rated_w
                if score < best_score:
                    best_score, best_id = score, aid
            if best_id is not None and best_score <= RECONCILE_TOLERANCE:
                candidate, score_of_candidate = f"on:{best_id}", best_score

        elif median_residual < -25.0:
            # over-assigned: which appliance we think is on accounts for the excess?
            excess = -median_residual
            best_id, best_score = None, float("inf")
            for aid, sig in self.signatures.items():
                st = self.states[aid]
                if not st.on or sig.behaviour == "always_on" or st.power_w <= 0:
                    continue
                score = abs(excess - st.power_w) / st.power_w
                if score < best_score:
                    best_score, best_id = score, aid
            if best_id is not None and best_score <= RECONCILE_TOLERANCE:
                candidate, score_of_candidate = f"off:{best_id}", best_score

        # hysteresis: only act when the same correction is proposed twice
        if candidate is not None and candidate == self._pending_fix:
            action, aid = candidate.split(":", 1)
            st, sig = self.states[aid], self.signatures[aid]
            if action == "on":
                st.on = True
                st.power_w = min(abs(median_residual), sig.rated_w * 1.2)
            else:
                st.on = False
                st.power_w = sig.standby_w
            st.confidence = round(0.5 * max(0.0, 1 - score_of_candidate), 3)
            self._residuals.clear()
            self._pending_fix = None
        else:
            self._pending_fix = candidate

    # ---------------------------------------------------------- attribution
    def attribute(self, total_w: float, dt_s: float) -> dict[str, dict]:
        """Split `total_w` across appliances; integrate energy over `dt_s`."""
        # Reconcile when explicitly enabled, and always when a large share of the
        # load is unattributed. That second case is cold start: a meter that
        # comes up mid-cycle never saw the switch-on edges, so there is nothing
        # for edge matching to work with and everything piles into "Other".
        # Gating on the unattributed share means reconciliation cannot fire once
        # attribution is already healthy, where it was measured to do harm.
        unattributed_share = self.other.power_w / max(total_w, 1.0)
        if self.reconcile_enabled or unattributed_share > COLD_START_SHARE:
            self._residuals.append(total_w - sum(s.power_w for s in self.states.values()))
            self._since_reconcile += dt_s
            if self._since_reconcile >= RECONCILE_EVERY_S:
                self._since_reconcile = 0.0
                self._reconcile()

        assigned = 0.0
        for aid, st in self.states.items():
            sig = self.signatures[aid]
            if st.on and sig.behaviour == "always_on":
                st.power_w = sig.rated_w
            assigned += st.power_w

        residual = total_w - assigned

        # If we are over-assigned (appliances we think are on but aren't),
        # scale the switched-on estimates down rather than reporting negatives.
        if residual < 0:
            switched = {a: s for a, s in self.states.items() if s.on
                        and self.signatures[a].behaviour != "always_on"}
            switched_total = sum(s.power_w for s in switched.values())
            if switched_total > 0:
                scale = max(0.0, 1.0 + residual / switched_total)
                for s in switched.values():
                    s.power_w *= scale
            residual = max(0.0, total_w - sum(s.power_w for s in self.states.values()))

        self.other.power_w = max(0.0, residual)

        out: dict[str, dict] = {}
        for aid, st in self.states.items():
            st.energy_wh += st.power_w * dt_s / 3600.0
            sig = self.signatures[aid]
            out[aid] = {
                "id": aid,
                "name": sig.name,
                "icon": sig.icon,
                "power_w": round(st.power_w, 2),
                "state": bool(st.on),
                "energy_wh": round(st.energy_wh, 4),
                "confidence": st.confidence,
                # read by the "appliance left on for N minutes" automation,
                # which could never fire while this field was missing
                "since_ts": st.since_ts if st.on else 0,
            }

        for aid, (sig, st) in self._disabled.items():
            out[aid] = {
                "id": aid,
                "name": sig.name,
                "icon": sig.icon,
                "power_w": 0.0,
                "state": False,
                "energy_wh": round(st.energy_wh, 4),
                "confidence": 1.0,
            }

        self.other.energy_wh += self.other.power_w * dt_s / 3600.0
        out[OTHER_ID] = {
            "id": OTHER_ID,
            "name": "Other / Unmetered",
            "icon": "❓",
            "power_w": round(self.other.power_w, 2),
            "state": self.other.power_w > 1.0,
            "energy_wh": round(self.other.energy_wh, 4),
            "confidence": 1.0,
        }
        return out

    def reset_daily_energy(self) -> None:
        for st in self.states.values():
            st.energy_wh = 0.0
        for _, st in self._disabled.values():
            st.energy_wh = 0.0
        self.other.energy_wh = 0.0

    # ------------------------------------------------------------- scoring
    @staticmethod
    def score(estimate: dict[str, dict], truth: dict[str, float]) -> dict:
        """Compare an estimate against simulator ground truth (demo only).

        Returns per-appliance absolute error and the standard NILM accuracy
        metric 1 - sum|est-true| / (2 * sum true).
        """
        total_true = sum(truth.values())
        abs_err = 0.0
        per: dict[str, float] = {}
        for aid, t in truth.items():
            e = estimate.get(aid, {}).get("power_w", 0.0)
            per[aid] = round(e - t, 2)
            abs_err += abs(e - t)
        # unattributed truth shows up as "other"
        accuracy = 1.0 - abs_err / (2 * total_true) if total_true > 0 else 1.0
        return {
            "accuracy": round(max(0.0, min(1.0, accuracy)), 4),
            "abs_error_w": round(abs_err, 2),
            "per_appliance_error_w": per,
        }
