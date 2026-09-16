import { api } from '../lib/api.js'
import { money, num0, num2, watts } from '../lib/format.js'
import { Card, useApp, usePoll } from '../lib/ui.jsx'

export default function Portfolio({ onOpen }) {
  const { settings } = useApp()
  const symbol = settings?.currency_symbol || '₹'
  const data = usePoll(() => api('/portfolio'), 5000, [])
  const p = data.data

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p>Every connected meter: live load, energy and billing.</p>
        </div>
      </div>
      {data.error && <div className="form-error">{data.error.message}</div>}
      <div className="grid">
        <section className="card span-4 banner info">
          <div className="meta">
            <span className="faint">Combined load now</span>
            <div className="hero">{p ? num0(p.total_power_w) : '—'}<small>W</small></div>
          </div>
        </section>
        <Card span={4} title="Energy today, all meters">
          <div className="big">{p ? num2(p.total_today_kwh) : '—'}<small>kWh</small></div>
        </Card>
        <Card span={4} title="Billed this month, all meters">
          <div className="big">{p ? money(p.total_month_bill, symbol) : '—'}</div>
        </Card>

        <Card span={12} title="Meters">
          {!p?.devices?.length ? <div className="empty">No meters registered.</div> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Meter</th><th>Source</th><th>Status</th><th className="r">Load</th>
                    <th className="r">Peak today</th><th className="r">Today</th><th className="r">Month</th>
                    <th className="r">Bill so far</th><th className="r">Projected</th><th className="r">Alerts</th><th />
                  </tr>
                </thead>
                <tbody>
                  {p.devices.map((d) => (
                    <tr key={d.id} className={d.online ? '' : 'dim'}>
                      <td style={{ fontWeight: 600 }}>{d.id}</td>
                      <td>{d.source === 'sim' ? 'Synthetic' : 'ESP32 / MQTT'}</td>
                      <td><span className="row small"><span className={`dot ${d.online ? 'on' : 'off'}`} />{d.online ? 'Online' : 'Offline'}</span></td>
                      <td className="r">{watts(d.power_w)}</td>
                      <td className="r">{watts(d.peak_w_today)}</td>
                      <td className="r">{num2(d.today_kwh)} kWh</td>
                      <td className="r">{num2(d.month_kwh)} kWh</td>
                      <td className="r">{money(d.month_bill, symbol)}</td>
                      <td className="r">{money(d.projected_bill, symbol)}</td>
                      <td className="r">{d.active_alerts || '—'}</td>
                      <td className="r"><button type="button" className="btn sm" onClick={() => onOpen(d.id)}>Open</button></td>
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
