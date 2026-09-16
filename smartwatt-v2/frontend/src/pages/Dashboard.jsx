import { Fragment, lazy, Suspense, useEffect, useMemo } from 'react'
import ForecastChart from '../components/ForecastChart.jsx'
import LiveChart from '../components/LiveChart.jsx'
import {
  Alerts, Billing, Breakdown, Events, ShareBars, StatusBanner, Tiles, TipCard,
  TodayEnergy, TopConsumer,
} from '../components/Widgets.jsx'
import { api } from '../lib/api.js'
import { useLive } from '../lib/useLive.js'
import { Card, usePoll, useApp, WIDGETS } from '../lib/ui.jsx'

// three.js is large: load it only when the 3D card is actually on screen
const House3D = lazy(() => import('../components/House3D.jsx'))

const DEFAULT_LAYOUT = WIDGETS.map(([id]) => id)

export default function Dashboard({ device }) {
  const { settings, perms, theme, notify } = useApp()
  const dev = encodeURIComponent(device)
  const live = useLive(device)

  const appliances = usePoll(() => api(`/appliances/${dev}`), 4000, [device, live.controlTick])
  const insights = usePoll(() => api(`/insights/${dev}`), 5000, [device])
  const billing = usePoll(() => api(`/billing/${dev}`), 15000, [device])
  const forecast = usePoll(() => api(`/forecast/${dev}?horizon_minutes=120`), 60000, [device])
  const history = usePoll(() => api(`/readings/${dev}?range=1h&limit=240`), 60000, [device])
  const events = usePoll(() => api(`/events/${dev}?limit=25`), 5000, [device, live.lastEvent?.id])
  const alerts = usePoll(() => api(`/alerts/${dev}?limit=30`), 10000, [device, live.alertFeed.length])

  useEffect(() => {
    const a = live.alertFeed[0]
    if (a) notify({ level: a.severity, title: a.title, message: a.message })
  }, [live.alertFeed, notify])

  // Poll gives the enabled/controllable flags; the live frame gives fresh power.
  const rows = useMemo(() => {
    const base = appliances.data?.appliances || []
    const liveApps = live.reading?.appliances || {}
    const merged = base.map((a) => {
      const l = liveApps[a.id]
      return l ? { ...a, power_w: l.power_w, state: l.state, today_kwh: l.energy_wh / 1000, confidence: l.confidence } : a
    })
    const total = merged.reduce((s, a) => s + (a.today_kwh || 0), 0) || 1
    return merged
      .map((a) => ({ ...a, share_pct: ((a.today_kwh || 0) / total) * 100 }))
      .sort((a, b) => (a.id === 'other') - (b.id === 'other') || b.power_w - a.power_w)
  }, [appliances.data, live.reading])

  const canControl = perms.includes('control')
  const threshold = settings?.threshold_power_w ?? 2000
  const symbol = settings?.currency_symbol || '₹'
  const activeAlerts = (alerts.data || []).filter((a) => a.status === 'active').length

  async function toggle(a) {
    try {
      await api(`/appliances/${dev}/control`, { method: 'POST', body: { appliance_id: a.id, state: !a.enabled } })
      appliances.reload()
    } catch (e) {
      notify({ level: 'critical', title: `Could not switch ${a.name}`, message: e.message })
    }
  }
  async function alertAction(a, action) {
    try {
      await api(`/alerts/${a.id}/${action}`, { method: 'POST' })
      alerts.reload()
    } catch (e) {
      notify({ level: 'critical', title: 'Alert update failed', message: e.message })
    }
  }

  const widgets = {
    status: <StatusBanner reading={live.reading} threshold={threshold} activeAlerts={activeAlerts} />,
    tiles: <Tiles reading={live.reading} settings={settings} />,
    house3d: (
      <Suspense fallback={<Card span={12} title="3D home"><div className="empty">Loading 3D view…</div></Card>}>
        <House3D rows={rows} canControl={canControl} onToggle={toggle} theme={theme} />
      </Suspense>
    ),
    live_chart: <LiveChart series={live.series} threshold={threshold} theme={theme} status={live.status} />,
    today_energy: <TodayEnergy reading={live.reading} billing={billing.data} settings={settings} />,
    top_consumer: <TopConsumer insights={insights.data} />,
    tip: <TipCard insights={insights.data} />,
    breakdown: <Breakdown rows={rows} canControl={canControl} onToggle={toggle} score={live.reading?.disagg_score} />,
    donut: <ShareBars rows={rows} />,
    forecast: (
      <ForecastChart
        history={history.data?.points}
        forecast={forecast.data}
        billing={billing.data}
        theme={theme}
        symbol={symbol}
      />
    ),
    billing: <Billing billing={billing.data} symbol={symbol} />,
    events: <Events events={events.data} />,
    alerts: <Alerts alerts={alerts.data} onAck={(a) => alertAction(a, 'ack')} onResolve={(a) => alertAction(a, 'resolve')} />,
  }

  const layout = settings?.widget_layout?.length ? settings.widget_layout : DEFAULT_LAYOUT

  return (
    <div className="grid">
      {layout.map((id) => (widgets[id] ? <Fragment key={id}>{widgets[id]}</Fragment> : null))}
    </div>
  )
}
