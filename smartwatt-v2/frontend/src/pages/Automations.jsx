import { useState } from 'react'
import { api } from '../lib/api.js'
import { ago, num0 } from '../lib/format.js'
import { Card, useApp, usePoll } from '../lib/ui.jsx'

const TRIGGERS = {
  power_above: 'Total load above',
  daily_budget: "Today's energy above",
  time_of_day: 'Every day at',
  appliance_on_for: 'Appliance left on for',
}
const ACTIONS = { turn_off: 'Turn off', turn_on: 'Turn on', notify: 'Notify only' }

const BLANK = {
  name: '', trigger_type: 'power_above', watts: 2500, kwh: 12, at: '23:00',
  trigger_appliance: 'ac', minutes: 120, action_type: 'turn_off', target: 'one',
  action_appliance: 'ac', except: ['refrigerator'], message: '',
}

function describe(rule, names) {
  const t = rule.trigger_config
  const a = rule.action_config
  const trig = {
    power_above: `load > ${num0(t.watts)} W`,
    daily_budget: `today > ${t.kwh} kWh`,
    time_of_day: `at ${t.at}`,
    appliance_on_for: `${names[t.appliance_id] || t.appliance_id} on for ${t.minutes} min`,
  }[rule.trigger_type]
  const act = rule.action_type === 'notify' ? `notify "${a.message || rule.name}"`
    : `${ACTIONS[rule.action_type].toLowerCase()} ${a.all ? `everything${a.except?.length ? ` except ${a.except.map((e) => names[e] || e).join(', ')}` : ''}` : names[a.appliance_id] || a.appliance_id}`
  return `When ${trig} → ${act}`
}

export default function Automations({ device }) {
  const { perms, notify } = useApp()
  const canEdit = perms.includes('automate')
  const dev = encodeURIComponent(device)
  const rules = usePoll(() => api(`/automations/${dev}`), 10000, [device])
  const appliances = usePoll(() => api(`/appliances/${dev}`), 0, [device])
  const [form, setForm] = useState(BLANK)
  const [error, setError] = useState('')

  const list = (appliances.data?.appliances || []).filter((a) => a.id !== 'other')
  const controllable = list.filter((a) => a.controllable)
  const names = Object.fromEntries(list.map((a) => [a.id, a.name]))
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  function preset(p) {
    setError('')
    setForm({ ...BLANK, ...p })
  }

  async function create(e) {
    e.preventDefault()
    setError('')
    const trigger_config = {
      power_above: { watts: Number(form.watts) },
      daily_budget: { kwh: Number(form.kwh) },
      time_of_day: { at: form.at },
      appliance_on_for: { appliance_id: form.trigger_appliance, minutes: Number(form.minutes) },
    }[form.trigger_type]
    const action_config = form.action_type === 'notify'
      ? { message: form.message }
      : form.target === 'all' ? { all: true, except: form.except } : { appliance_id: form.action_appliance }
    const name = form.name.trim() || describe({ trigger_type: form.trigger_type, trigger_config, action_type: form.action_type, action_config, name: '' }, names)
    try {
      await api(`/automations/${dev}`, {
        method: 'POST',
        body: { name: name.slice(0, 80), trigger_type: form.trigger_type, trigger_config, action_type: form.action_type, action_config },
      })
      setForm(BLANK)
      rules.reload()
      notify({ level: 'good', title: 'Automation created', message: name })
    } catch (err) {
      setError(err.message)
    }
  }

  async function toggle(rule) {
    try {
      await api(`/automations/${rule.id}?enabled=${!rule.enabled}`, { method: 'PATCH' })
      rules.reload()
    } catch (err) { notify({ level: 'critical', title: 'Update failed', message: err.message }) }
  }
  async function remove(rule) {
    try {
      await api(`/automations/${rule.id}`, { method: 'DELETE' })
      rules.reload()
    } catch (err) { notify({ level: 'critical', title: 'Delete failed', message: err.message }) }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automations</h1>
          <p>Rules that switch appliances or notify you when a condition is met. Each rule fires at most once a minute.</p>
        </div>
      </div>
      <div className="grid">
        <Card span={7} title="Rules">
          {!rules.data?.length ? <div className="empty">No automations yet.</div> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Rule</th><th className="r">Fired</th><th className="r">Enabled</th><th /></tr></thead>
                <tbody>
                  {rules.data.map((r) => (
                    <tr key={r.id} className={r.enabled ? '' : 'dim'}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        <div className="faint small">{describe(r, names)}</div>
                      </td>
                      <td className="r small">{r.fire_count}×{r.last_fired ? <div className="faint">{ago(r.last_fired)}</div> : null}</td>
                      <td className="r">
                        <input type="checkbox" checked={r.enabled} disabled={!canEdit} onChange={() => toggle(r)} aria-label={`Enable ${r.name}`} />
                      </td>
                      <td className="r">
                        {canEdit && <button type="button" className="btn sm ghost danger" onClick={() => remove(r)}>Delete</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card span={5} title="New automation" sub={canEdit ? 'Start from a preset or build your own' : 'Your role cannot create automations'}>
          {canEdit && (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <button type="button" className="chip" onClick={() => preset({ name: 'AC off on overload', trigger_type: 'power_above', watts: 2500, action_type: 'turn_off', target: 'one', action_appliance: 'ac' })}>AC off above 2,500 W</button>
                <button type="button" className="chip" onClick={() => preset({ name: 'Budget guard', trigger_type: 'daily_budget', kwh: 12, action_type: 'turn_off', target: 'all', except: ['refrigerator'] })}>Over budget → all off except fridge</button>
                <button type="button" className="chip" onClick={() => preset({ name: 'Geyser timer', trigger_type: 'appliance_on_for', trigger_appliance: 'geyser', minutes: 20, action_type: 'turn_off', target: 'one', action_appliance: 'geyser' })}>Geyser off after 20 min</button>
              </div>
              <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="field">
                  <label htmlFor="an">Name</label>
                  <input id="an" type="text" maxLength={80} value={form.name} placeholder="Optional - generated from the rule" onChange={(e) => set('name', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="tt">When</label>
                  <select id="tt" value={form.trigger_type} onChange={(e) => set('trigger_type', e.target.value)}>
                    {Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                {form.trigger_type === 'power_above' && (
                  <div className="field"><label htmlFor="tw">Watts</label><input id="tw" type="number" min="50" value={form.watts} onChange={(e) => set('watts', e.target.value)} /></div>
                )}
                {form.trigger_type === 'daily_budget' && (
                  <div className="field"><label htmlFor="tk">kWh</label><input id="tk" type="number" step="0.1" min="0.1" value={form.kwh} onChange={(e) => set('kwh', e.target.value)} /></div>
                )}
                {form.trigger_type === 'time_of_day' && (
                  <div className="field"><label htmlFor="ta">Time</label><input id="ta" type="time" value={form.at} onChange={(e) => set('at', e.target.value)} /></div>
                )}
                {form.trigger_type === 'appliance_on_for' && (
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <div className="field" style={{ flex: 2 }}>
                      <label htmlFor="tap">Appliance</label>
                      <select id="tap" value={form.trigger_appliance} onChange={(e) => set('trigger_appliance', e.target.value)}>
                        {list.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}><label htmlFor="tm">Minutes</label><input id="tm" type="number" min="1" value={form.minutes} onChange={(e) => set('minutes', e.target.value)} /></div>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="at">Then</label>
                  <select id="at" value={form.action_type} onChange={(e) => set('action_type', e.target.value)}>
                    {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                {form.action_type === 'notify' ? (
                  <div className="field"><label htmlFor="am">Message</label><input id="am" type="text" maxLength={200} value={form.message} onChange={(e) => set('message', e.target.value)} /></div>
                ) : (
                  <>
                    <div className="row">
                      <label className="switch"><input type="radio" name="target" checked={form.target === 'one'} onChange={() => set('target', 'one')} />One appliance</label>
                      <label className="switch"><input type="radio" name="target" checked={form.target === 'all'} onChange={() => set('target', 'all')} />Everything</label>
                    </div>
                    {form.target === 'one' ? (
                      <select aria-label="Appliance to switch" value={form.action_appliance} onChange={(e) => set('action_appliance', e.target.value)}>
                        {controllable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    ) : (
                      <div>
                        <div className="faint small" style={{ marginBottom: 4 }}>Except</div>
                        <div className="row">
                          {list.map((a) => (
                            <label className="switch small" key={a.id}>
                              <input type="checkbox" checked={form.except.includes(a.id)}
                                onChange={(e) => set('except', e.target.checked ? [...form.except, a.id] : form.except.filter((x) => x !== a.id))} />
                              {a.name}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
                {error && <div className="form-error" role="alert">{error}</div>}
                <button type="submit" className="btn primary">Create automation</button>
              </form>
            </>
          )}
        </Card>
      </div>
    </>
  )
}
