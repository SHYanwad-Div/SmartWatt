import { useState } from 'react'
import DailyChart from '../components/DailyChart.jsx'
import { api, downloadCsv } from '../lib/api.js'
import { kwh, money, num0, num2 } from '../lib/format.js'
import { Card, Segmented, useApp, usePoll } from '../lib/ui.jsx'

export default function Reports({ device }) {
  const { settings, theme, notify } = useApp()
  const symbol = settings?.currency_symbol || '₹'
  const [days, setDays] = useState(30)
  const [range, setRange] = useState('24h')
  const [busy, setBusy] = useState(false)
  const report = usePoll(() => api(`/reports/${encodeURIComponent(device)}/daily?days=${days}`), 60000, [device, days])
  const rows = report.data?.days || []

  async function exportCsv() {
    setBusy(true)
    try {
      await downloadCsv(device, range)
    } catch (e) {
      notify({ level: 'critical', title: 'Export failed', message: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p>Daily energy, peak load and cost for {device}.</p>
        </div>
        <div className="spacer" />
        <Segmented label="Report period" value={days} onChange={setDays}
          options={[{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]} />
      </div>
      <div className="grid">
        <Card span={4} title="Energy in period">
          <div className="big">{kwh(report.data?.total_kwh || 0, 2)}</div>
          <div className="muted small" style={{ marginTop: 4 }}>{rows.length} day(s) recorded</div>
        </Card>
        <Card span={4} title="Cost in period" sub="Slab rates applied cumulatively across the days shown">
          <div className="big">{money(report.data?.total_cost || 0, symbol)}</div>
        </Card>
        <Card span={4} title="Export readings" sub="Voltage, current, power, power factor and energy as CSV">
          <div className="row">
            <Segmented label="Export range" value={range} onChange={setRange}
              options={[{ value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} />
            <button type="button" className="btn primary" disabled={busy} onClick={exportCsv}>{busy ? 'Preparing…' : 'Download CSV'}</button>
          </div>
        </Card>

        <Card span={12} title="Energy per day">
          <DailyChart days={rows} theme={theme} symbol={symbol} />
        </Card>

        <Card span={12} title="Daily detail">
          {!rows.length ? <div className="empty">No days recorded yet.</div> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Day</th><th className="r">Energy</th><th className="r">Peak load</th><th className="r">Cost</th></tr></thead>
                <tbody>
                  {[...rows].reverse().map((d) => (
                    <tr key={d.day}>
                      <td className="num">{d.day}</td>
                      <td className="r">{num2(d.kwh)} kWh</td>
                      <td className="r">{num0(d.peak_w)} W</td>
                      <td className="r">{money(d.cost, symbol)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
