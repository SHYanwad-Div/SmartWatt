import { useState } from 'react'
import { ago, clock, dateTime, kwh, money, num0, num1, num2, watts } from '../lib/format.js'
import { Card, Segmented, Status } from '../lib/ui.jsx'

/* ------------------------------------------------------------- status */

export function StatusBanner({ reading, threshold, activeAlerts, span = 12 }) {
  let level = 'info'
  let label = 'Waiting for data'
  if (reading) {
    const p = reading.power_w
    if (p > threshold) { level = 'critical'; label = 'Overload' }
    else if (p > threshold * 0.8) { level = 'warning'; label = 'High usage' }
    else { level = 'good'; label = 'Normal usage' }
  }
  return (
    <section className={`card span-${span} banner ${level}`}>
      <div className="meta">
        <Status level={level}>{label}</Status>
        <div className="hero">
          {reading ? num0(reading.power_w) : '—'}<small>W now</small>
        </div>
        <div className="faint small">
          Limit {num0(threshold)} W{reading ? ` · updated ${clock(reading.ts)}` : ''}
        </div>
      </div>
      <div className="facts">
        {reading && (
          <span className="pill">
            <span className="dot on" />
            {reading.source === 'sim' ? 'Synthetic data (no hardware)' : 'Live ESP32 meter'}
          </span>
        )}
        <span className="pill">
          <span className={`dot ${activeAlerts ? 'off' : 'on'}`} />
          {activeAlerts ? `${activeAlerts} active alert${activeAlerts > 1 ? 's' : ''}` : 'No active alerts'}
        </span>
      </div>
    </section>
  )
}

export function Tiles({ reading, settings, span = 12 }) {
  const v = reading?.voltage_v
  const vLo = settings?.threshold_voltage_low ?? 200
  const vHi = settings?.threshold_voltage_high ?? 250
  const vLevel = v == null ? null : v < vLo ? ['warning', 'Low supply'] : v > vHi ? ['warning', 'High supply'] : ['good', 'In range']
  return (
    <section className={`span-${span} tiles`}>
      <div className="card tile">
        <div className="label">Voltage</div>
        <div className="value">{v != null ? num1(v) : '—'}<small>V</small></div>
        <div className="foot">{vLevel && <Status level={vLevel[0]}>{vLevel[1]}</Status>}</div>
      </div>
      <div className="card tile">
        <div className="label">Current</div>
        <div className="value">{reading ? num2(reading.current_a) : '—'}<small>A</small></div>
        <div className="foot">Raw power {reading ? watts(reading.power_raw_w) : '—'}</div>
      </div>
      <div className="card tile">
        <div className="label">Power factor</div>
        <div className="value">{reading ? reading.pf.toFixed(2) : '—'}</div>
        <div className="foot">{reading ? (reading.pf >= 0.9 ? 'Good' : 'Inductive load heavy') : ''}</div>
      </div>
      <div className="card tile">
        <div className="label">Peak today</div>
        <div className="value">{reading ? num0(reading.peak_w_today) : '—'}<small>W</small></div>
        <div className="foot">Highest smoothed load since midnight</div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------- energy */

export function TodayEnergy({ reading, billing, settings, span = 4 }) {
  const budget = settings?.threshold_daily_kwh ?? 12
  const used = reading?.today_kwh ?? 0
  const pct = budget > 0 ? (used / budget) * 100 : 0
  const level = pct >= 100 ? 'critical' : pct >= 80 ? 'warning' : ''
  const symbol = settings?.currency_symbol || '₹'
  return (
    <Card span={span} title="Today's energy" sub={`Daily budget ${num1(budget)} kWh`}>
      <div className="big">{num2(used)}<small>kWh</small></div>
      <div className={`meter ${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Share of daily budget used">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="row small">
        {level === 'critical' ? <Status level="critical">Over budget</Status>
          : level === 'warning' ? <Status level="warning">Nearing budget</Status>
            : <span className="muted">{num0(pct)}% of budget</span>}
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="kv"><span>Cost so far</span><span className="num">{billing ? money(billing.today.cost, symbol) : '—'}</span></div>
        <div className="kv"><span>On pace for</span><span className="num">{billing ? kwh(billing.forecast.today_projected_kwh, 1) : '—'}</span></div>
      </div>
    </Card>
  )
}

export function TopConsumer({ insights, span = 6 }) {
  const top = insights?.top_now
  const mostlyUnknown = insights && insights.unattributed_is_largest
  return (
    <Card span={span} title="Highest power consumer right now">
      {!insights ? <div className="empty">Loading…</div>
        : mostlyUnknown ? (
          <>
            <div className="big">{watts(insights.unattributed_w)}<small>unattributed</small></div>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              Most of the current load has not been matched to an appliance yet. The meter
              identifies appliances when it sees them switch, so this fills in within a few minutes.
            </p>
          </>
        ) : top ? (
          <>
            <div className="appl" style={{ fontSize: 22, fontWeight: 600 }}>
              <span className="ico" aria-hidden="true">{top.icon}</span>{top.name}
            </div>
            <div className="big" style={{ marginTop: 4 }}>{watts(top.power_w)}</div>
            {top.tip && <p className="muted" style={{ margin: '8px 0 0' }}>{top.tip}</p>}
          </>
        ) : <div className="empty">No appliance running.</div>}
    </Card>
  )
}

export function TipCard({ insights, span = 6 }) {
  const t = insights?.top_today
  return (
    <Card span={span} title="Smart energy tip">
      {t && t.energy_wh > 0 ? (
        <>
          <div className="appl" style={{ fontSize: 18, fontWeight: 600 }}>
            <span className="ico" aria-hidden="true">{t.icon}</span>{t.name}
          </div>
          <p style={{ margin: '6px 0' }}>
            Used <strong>{num1(t.share_pct)}%</strong> of today's energy ({kwh(t.energy_wh / 1000, 3)}).
          </p>
          {t.tip && <p className="muted" style={{ margin: 0 }}>{t.tip}</p>}
        </>
      ) : <div className="empty">Tips appear once appliances have used some energy today.</div>}
    </Card>
  )
}

/* ---------------------------------------------------------- appliances */

export function Breakdown({ rows, canControl, onToggle, score, span = 8 }) {
  const [busy, setBusy] = useState(null)
  const toggle = async (a) => {
    setBusy(a.id)
    try { await onToggle(a) } finally { setBusy(null) }
  }
  // Prefer the rolling mean: the instant value dips hard for a few minutes after
  // two appliances switch together, which misrepresents a healthy estimate.
  const acc = score?.accuracy_30m ?? score?.accuracy
  const accWindow = score?.accuracy_30m != null ? 'last 30 min' : 'right now'
  return (
    <Card
      span={span}
      title="Appliance breakdown"
      sub={`Estimated from the total signal (NILM)${acc != null ? ` · accuracy vs simulator truth ${num0(acc * 100)}% (${accWindow})` : ''}`}
    >
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Appliance</th><th>State</th><th className="r">Power</th>
              <th className="r">Today</th><th className="r">Share</th><th className="r">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const other = a.id === 'other'
              return (
                <tr key={a.id} className={!a.enabled ? 'dim' : ''}>
                  <td>
                    <span className="appl"><span className="ico" aria-hidden="true">{a.icon}</span>{a.name}</span>
                  </td>
                  <td>
                    {!a.enabled ? <span className="badge">Switched off</span>
                      : other ? <span className="faint small">—</span>
                        : <span className="row small"><span className={`dot ${a.state ? 'on' : ''}`} />{a.state ? 'On' : 'Off'}</span>}
                  </td>
                  <td className="r">{watts(a.power_w)}</td>
                  <td className="r">{num2(a.today_kwh)} kWh</td>
                  <td className="r">{num1(a.share_pct)}%</td>
                  <td className="r">
                    {other ? null : a.controllable && canControl ? (
                      <button
                        type="button"
                        className={`btn sm ${a.enabled ? 'danger' : 'primary'}`}
                        disabled={busy === a.id}
                        aria-label={`${a.enabled ? 'Turn off' : 'Turn on'} ${a.name}`}
                        onClick={() => toggle(a)}
                      >
                        {a.enabled ? 'Turn off' : 'Turn on'}
                      </button>
                    ) : (
                      <span className="faint small">{a.controllable ? 'View only' : 'Not switchable'}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** Share of today's energy: one hue, sorted, value labelled at each bar tip. */
export function ShareBars({ rows, span = 4 }) {
  const items = rows.filter((r) => r.today_kwh > 0).sort((a, b) => b.today_kwh - a.today_kwh)
  const max = items.reduce((m, r) => Math.max(m, r.share_pct), 0) || 1
  return (
    <Card span={span} title="Energy share today" sub="Grey = not yet attributed to an appliance">
      {!items.length ? <div className="empty">No energy recorded yet today.</div> : items.map((r) => (
        <div className="share-row" key={r.id}>
          <span className="appl small"><span className="ico" aria-hidden="true">{r.icon}</span>{r.name}</span>
          <span className={`share-track ${r.id === 'other' ? 'unattributed' : ''}`}>
            <span style={{ width: `${(r.share_pct / max) * 100}%` }} />
          </span>
          <span className="share-val">{num1(r.share_pct)}% · {num2(r.today_kwh)} kWh</span>
        </div>
      ))}
    </Card>
  )
}

/* ------------------------------------------------------------- billing */

export function Billing({ billing, symbol, span = 5 }) {
  if (!billing) return <Card span={span} title="Bill and tariff slab"><div className="empty">Loading…</div></Card>
  const mtd = billing.month_to_date
  const slab = billing.next_slab
  const pct = slab.pct_through_slab || 0
  return (
    <Card span={span} title="Bill and tariff slab" sub="Telescopic slabs, month to date">
      <div className="row" style={{ alignItems: 'flex-end', gap: 24 }}>
        <div>
          <div className="faint small">Month to date</div>
          <div className="big">{money(mtd.total, symbol)}</div>
        </div>
        <div>
          <div className="faint small">Projected month end</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{money(billing.projected_month.total, symbol)}</div>
        </div>
      </div>
      <div className={`meter ${pct >= 90 && !slab.in_top_slab ? 'warning' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Progress through current tariff slab">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="small muted">
        {slab.in_top_slab
          ? `In the highest slab at ${money(slab.current_rate, symbol)}/unit`
          : `${num1(slab.units_to_next)} kWh until the ${num0(slab.boundary)} kWh boundary · ${money(slab.current_rate, symbol)} → ${money(slab.next_rate, symbol)}/unit`}
      </div>
      <div className="slab-list" style={{ marginTop: 10 }}>
        {mtd.breakdown.map((b) => (
          <div className="kv" key={b.from}>
            <span>{num0(b.from)}–{b.to == null ? '∞' : num0(b.to)} kWh @ {money(b.rate, symbol)}</span>
            <span>{num2(b.units)} u · {money(b.cost, symbol)}</span>
          </div>
        ))}
        <div className="kv"><span>Fixed charge</span><span>{money(mtd.fixed_charge, symbol)}</span></div>
        <div className="kv"><span>Tax</span><span>{money(mtd.tax, symbol)}</span></div>
        <div className="kv"><span>Energy so far</span><span>{kwh(mtd.kwh, 2)}</span></div>
      </div>
    </Card>
  )
}

/* -------------------------------------------------------------- events */

export function Events({ events, span = 6 }) {
  return (
    <Card span={span} title="Detected events" sub="Load steps found in the total signal and the appliance each was matched to">
      {!events?.length ? <div className="empty">No switching events yet.</div> : (
        <div className="table-wrap" style={{ maxHeight: 320 }}>
          <table className="data">
            <thead><tr><th>Time</th><th className="r">Change</th><th>Appliance</th><th className="r">Confidence</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="num">{clock(e.ts)}</td>
                  <td className="r">{e.delta_w > 0 ? '+' : ''}{num0(e.delta_w)} W</td>
                  <td>
                    {e.label === 'device' ? <span className="faint">Reported by meter</span>
                      : e.label || <span className="faint">Unidentified</span>}
                    <span className="faint small"> · {e.direction}</span>
                  </td>
                  <td className="r">{e.appliance_id ? `${num0((e.confidence || 0) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------- alerts */

const SEVERITY = { info: 'info', warning: 'warning', critical: 'critical' }

export function Alerts({ alerts, onAck, onResolve, span = 6 }) {
  const [filter, setFilter] = useState('open')
  const list = (alerts || []).filter((a) => (filter === 'open' ? a.status !== 'resolved' : true))
  return (
    <Card
      span={span}
      title="Alerts"
      actions={(
        <Segmented
          label="Alert filter"
          value={filter}
          onChange={setFilter}
          options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]}
        />
      )}
    >
      {!list.length ? <div className="empty">Nothing to show.</div> : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {list.map((a) => (
            <div key={a.id} className={`alert-item ${a.status === 'resolved' ? 'resolved' : ''}`}>
              <Status level={SEVERITY[a.severity] || 'info'}>{''}</Status>
              <div>
                <div className="title">{a.title}</div>
                <div className="msg">{a.message}</div>
                <div className="faint small" title={dateTime(a.ts)}>
                  {ago(a.ts)} · {a.severity} · {a.status}
                </div>
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                {a.status === 'active' && <button type="button" className="btn sm" onClick={() => onAck(a)}>Acknowledge</button>}
                {a.status !== 'resolved' && <button type="button" className="btn sm ghost" onClick={() => onResolve(a)}>Resolve</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
