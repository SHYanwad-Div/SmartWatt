import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Card, useApp, WIDGETS } from '../lib/ui.jsx'

const NUMBERS = [
  ['threshold_power_w', 'Overload limit', 'W', 'Alert when total load exceeds this.'],
  ['threshold_daily_kwh', 'Daily energy budget', 'kWh', 'Alert when today passes this.'],
  ['threshold_voltage_low', 'Low voltage limit', 'V', ''],
  ['threshold_voltage_high', 'High voltage limit', 'V', ''],
  ['standby_waste_w', 'Phantom load level', 'W', 'Draw with everything off above this is flagged.'],
  ['anomaly_z', 'Spike sensitivity', 'z', 'Lower = more sensitive (robust z-score).'],
  ['alert_cooldown_s', 'Alert cooldown', 's', 'Minimum gap between repeats of one alert type.'],
]
const CALIBRATION = [
  ['cal_voltage_gain', 'Voltage gain'],
  ['cal_current_gain', 'Current gain'],
  ['cal_power_gain', 'Power gain'],
]
const CHANNELS = [
  ['notify_dashboard', 'Dashboard (live)'],
  ['notify_email', 'Email (SMTP in .env)'],
  ['notify_webhook', 'Webhook (URL in .env)'],
  ['notify_telegram', 'Telegram (bot in .env)'],
]

export default function Settings() {
  const { settings, perms, reloadSettings } = useApp()
  const canEdit = perms.includes('settings')
  const [form, setForm] = useState(null)
  const [msg, setMsg] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (settings) setForm(structuredClone(settings))
  }, [settings])

  if (!form) return <div className="empty">Loading settings…</div>

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  const numberField = (key, label, unit, hint) => (
    <div className="field" key={key}>
      <label htmlFor={key}>{label}{unit ? ` (${unit})` : ''}</label>
      <input
        id={key}
        type="number"
        step="any"
        disabled={!canEdit}
        value={form[key] ?? ''}
        onChange={(e) => set(key, e.target.value === '' ? '' : Number(e.target.value))}
      />
      {hint && <span className="hint">{hint}</span>}
    </div>
  )

  const slabs = form.tariff_slabs || []
  const setSlab = (i, key, value) =>
    set('tariff_slabs', slabs.map((s, j) => (j === i ? { ...s, [key]: value } : s)))
  const addSlab = () => {
    const prevUpto = slabs.length > 1 ? slabs[slabs.length - 2].upto || 0 : 0
    const next = [...slabs]
    next.splice(Math.max(0, next.length - 1), 0, { upto: prevUpto + 100, rate: next[next.length - 1]?.rate ?? 5 })
    set('tariff_slabs', next)
  }
  const removeSlab = (i) => set('tariff_slabs', slabs.filter((_, j) => j !== i))

  const layout = form.widget_layout || []
  const toggleWidget = (id) =>
    set('widget_layout', layout.includes(id) ? layout.filter((w) => w !== id) : [...layout, id])
  const move = (id, dir) => {
    const i = layout.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= layout.length) return
    const next = [...layout]
    ;[next[i], next[j]] = [next[j], next[i]]
    set('widget_layout', next)
  }
  const ordered = [...layout, ...WIDGETS.map(([id]) => id).filter((id) => !layout.includes(id))]
  const labelOf = Object.fromEntries(WIDGETS)

  async function save() {
    setSaving(true)
    setMsg(null)
    const changed = {}
    for (const [k, v] of Object.entries(form)) {
      if (JSON.stringify(v) !== JSON.stringify(settings[k])) changed[k] = v
    }
    if (!Object.keys(changed).length) {
      setMsg({ ok: true, text: 'Nothing changed.' })
      setSaving(false)
      return
    }
    try {
      await api('/settings', { method: 'PUT', body: { values: changed } })
      await reloadSettings()
      setMsg({ ok: true, text: `Saved ${Object.keys(changed).length} setting(s).` })
    } catch (e) {
      // The server names settings by key; show the label the user actually sees.
      const labels = {
        ...Object.fromEntries(NUMBERS.map(([k, l]) => [k, l])),
        ...Object.fromEntries(CALIBRATION.map(([k, l]) => [k, l])),
        tariff_fixed_charge: 'Fixed charge', tariff_tax_pct: 'Tax', tariff_slabs: 'Tariff slabs',
        currency_symbol: 'Currency symbol', widget_layout: 'Dashboard widgets',
      }
      const text = e.message.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (k) => labels[k] || k)
      setMsg({ ok: false, text })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>{canEdit ? 'Thresholds, tariff, notifications and dashboard layout.' : 'Your role can view settings but not change them.'}</p>
        </div>
        <div className="spacer" />
        {canEdit && (
          <>
            <button type="button" className="btn" onClick={() => { setForm(structuredClone(settings)); setMsg(null) }}>Discard</button>
            <button type="button" className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
          </>
        )}
      </div>
      {msg && <div className={msg.ok ? 'form-ok' : 'form-error'} role="status" style={{ marginBottom: 12 }}>{msg.text}</div>}

      <div className="grid">
        <Card span={6} title="Alert thresholds">
          <div className="form-grid">{NUMBERS.map((n) => numberField(...n))}</div>
        </Card>

        <Card span={6} title="Tariff" sub="Telescopic slabs: each rate applies only to units inside its band">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="sym">Currency symbol</label>
              <input id="sym" type="text" maxLength={4} disabled={!canEdit} value={form.currency_symbol} onChange={(e) => set('currency_symbol', e.target.value)} />
            </div>
            {numberField('tariff_fixed_charge', 'Fixed charge / month', form.currency_symbol)}
            {numberField('tariff_tax_pct', 'Tax', '%')}
          </div>
          <div className="section-title">Slabs</div>
          <table className="data">
            <thead><tr><th>From (kWh)</th><th>Up to (kWh)</th><th>Rate ({form.currency_symbol}/unit)</th><th /></tr></thead>
            <tbody>
              {slabs.map((s, i) => {
                const last = i === slabs.length - 1
                return (
                  <tr key={i}>
                    <td className="num">{i === 0 ? 0 : slabs[i - 1].upto}</td>
                    <td>
                      {last ? <span className="faint">and above</span> : (
                        <input type="number" step="any" disabled={!canEdit} value={s.upto ?? ''} aria-label={`Slab ${i + 1} upper limit`}
                          onChange={(e) => setSlab(i, 'upto', e.target.value === '' ? '' : Number(e.target.value))} />
                      )}
                    </td>
                    <td>
                      <input type="number" step="any" disabled={!canEdit} value={s.rate} aria-label={`Slab ${i + 1} rate`}
                        onChange={(e) => setSlab(i, 'rate', e.target.value === '' ? '' : Number(e.target.value))} />
                    </td>
                    <td className="r">
                      {canEdit && !last && slabs.length > 1 && (
                        <button type="button" className="btn sm ghost danger" onClick={() => removeSlab(i)}>Remove</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {canEdit && <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={addSlab}>Add slab</button>}
        </Card>

        <Card span={6} title="Dashboard widgets" sub="Choose what shows and in which order">
          {ordered.map((id) => (
            <div className="widget-row" key={id}>
              <input id={`w-${id}`} type="checkbox" disabled={!canEdit} checked={layout.includes(id)} onChange={() => toggleWidget(id)} />
              <label htmlFor={`w-${id}`}>{labelOf[id]}</label>
              <button type="button" className="btn sm ghost" disabled={!canEdit || !layout.includes(id)} onClick={() => move(id, -1)} aria-label={`Move ${labelOf[id]} up`}>↑</button>
              <button type="button" className="btn sm ghost" disabled={!canEdit || !layout.includes(id)} onClick={() => move(id, 1)} aria-label={`Move ${labelOf[id]} down`}>↓</button>
            </div>
          ))}
        </Card>

        <Card span={6} title="Notifications and calibration">
          {CHANNELS.map(([key, label]) => (
            <label className="switch" key={key}>
              <input type="checkbox" disabled={!canEdit} checked={!!form[key]} onChange={(e) => set(key, e.target.checked)} />
              {label}
            </label>
          ))}
          <div className="section-title">Sensor calibration</div>
          <div className="form-grid">{CALIBRATION.map(([k, l]) => numberField(k, l, '×', ''))}</div>
          <p className="faint small">Multiply raw readings to correct sensor scaling. 1 = no correction.</p>
        </Card>
      </div>
    </>
  )
}
