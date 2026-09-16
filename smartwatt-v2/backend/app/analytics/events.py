"""Edge (step) detection on the aggregate power signal.

This is the front half of NILM: find the moments where total demand steps up or
down, which correspond to an appliance switching. A candidate edge must persist
for `sustain_samples` before it is emitted, so a single noisy sample or an
inrush spike does not produce a phantom event.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass


@dataclass
class Edge:
    ts: int
    delta_w: float
    direction: str      # ON | OFF
    power_now: float


class EdgeDetector:
    def __init__(
        self,
        threshold_w: float = 30.0,
        sustain_samples: int = 3,
        baseline_window: int = 5,
        relative_threshold: float = 0.0,
    ) -> None:
        self.threshold_w = threshold_w
        self.relative_threshold = relative_threshold
        self.sustain_samples = sustain_samples
        self.baseline = deque(maxlen=baseline_window)
        self._pending: float | None = None    # baseline before the candidate edge
        self._pending_count = 0
        self._pending_ts = 0

    def _baseline_w(self) -> float:
        return sum(self.baseline) / len(self.baseline) if self.baseline else 0.0

    def _threshold_for(self, base: float) -> float:
        """Detection band scales with the load.

        A flat deadband is correct for a clean RMS-averaged signal. On noisy
        hardware the ripple scales with the load, so set `relative_threshold`
        (e.g. 0.04) to widen the band proportionally at high load and stop the
        detector inventing events. Default 0.0 keeps small appliances visible
        underneath large ones, which measurably improves attribution.
        """
        return max(self.threshold_w, self.relative_threshold * abs(base))

    def push(self, ts: int, power_w: float) -> Edge | None:
        """Feed one sample. Returns an Edge when a step is confirmed."""
        if not self.baseline:
            self.baseline.append(power_w)
            return None

        base = self._baseline_w()
        delta = power_w - base

        if abs(delta) >= self._threshold_for(base):
            if self._pending is None:
                self._pending = base
                self._pending_count = 1
                self._pending_ts = ts
            else:
                self._pending_count += 1

            if self._pending_count >= self.sustain_samples:
                confirmed = Edge(
                    ts=self._pending_ts,
                    delta_w=round(power_w - self._pending, 2),
                    direction="ON" if power_w > self._pending else "OFF",
                    power_now=round(power_w, 2),
                )
                # reset the baseline to the new plateau
                self.baseline.clear()
                self.baseline.append(power_w)
                self._pending = None
                self._pending_count = 0
                return confirmed
            # do NOT feed the candidate into the baseline while pending
            return None

        # back inside the deadband: candidate was a transient
        self._pending = None
        self._pending_count = 0
        self.baseline.append(power_w)
        return None
