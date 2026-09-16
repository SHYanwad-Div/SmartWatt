import { useCallback, useEffect, useMemo, useState } from 'react'
import Assistant from './components/Assistant.jsx'
import Login from './components/Login.jsx'
import { api, clearSession, DEMO, getUser, setSession } from './lib/api.js'
import { AppContext, Logo, Status, usePoll } from './lib/ui.jsx'
import Automations from './pages/Automations.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Portfolio from './pages/Portfolio.jsx'
import Reports from './pages/Reports.jsx'
import Settings from './pages/Settings.jsx'

const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } },
}

const NAV = [
  ['dashboard', 'Dashboard', 'read'],
  ['portfolio', 'Portfolio', 'billing'],
  ['reports', 'Reports', 'read'],
  ['automations', 'Automations', 'read'],
  ['settings', 'Settings', 'read'],
]

function useTheme() {
  const [pref, setPref] = useState(() => store.get('sw_theme') || 'system')
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    const root = document.documentElement
    if (pref === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', pref)
    store.set('sw_theme', pref)
  }, [pref])
  return [pref, setPref, pref === 'system' ? (systemDark ? 'dark' : 'light') : pref]
}

function useRoute(fallback) {
  const read = () => window.location.hash.replace(/^#\/?/, '') || fallback
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onHash = () => setRoute(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return [route, (r) => { window.location.hash = `/${r}` }]
}

export default function App() {
  const [user, setUser] = useState(getUser)
  const [themePref, setThemePref, theme] = useTheme()

  useEffect(() => {
    const onLogout = () => { clearSession(); setUser(null) }
    window.addEventListener('sw:logout', onLogout)
    return () => window.removeEventListener('sw:logout', onLogout)
  }, [])

  if (!user) {
    return <Login onLogin={(token, u) => { setSession(token, u); setUser(u) }} />
  }
  return (
    <Shell
      user={user}
      onLogout={() => {
        clearSession()
        // Drop the page from the URL so the next account lands on its own
        // default (a utility analyst on Portfolio, not the last user's page).
        window.history.replaceState(null, '', window.location.pathname)
        setUser(null)
      }}
      themePref={themePref}
      setThemePref={setThemePref}
      theme={theme}
    />
  )
}

function Shell({ user, onLogout, themePref, setThemePref, theme }) {
  const perms = user.permissions || []
  const nav = NAV.filter(([, , p]) => perms.includes(p))
  const [route, go] = useRoute(perms.includes('control') || !perms.includes('billing') ? 'dashboard' : 'portfolio')
  const active = nav.find(([id]) => id === route) ? route : nav[0][0]

  const devices = usePoll(() => api('/devices'), 10000, [])
  const [device, setDevice] = useState(() => store.get('sw_device'))
  useEffect(() => {
    const list = devices.data
    if (!list?.length) return
    if (!device || !list.some((d) => d.id === device)) {
      setDevice((list.find((d) => d.source === 'sim') || list[0]).id)
    }
  }, [devices.data, device])
  useEffect(() => { if (device) store.set('sw_device', device) }, [device])

  const [settings, setSettings] = useState(null)
  const reloadSettings = useCallback(() => api('/settings').then(setSettings).catch(() => {}), [])
  useEffect(() => { reloadSettings() }, [reloadSettings])

  const [toasts, setToasts] = useState([])
  const notify = useCallback((t) => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts((cur) => [...cur.slice(-3), { ...t, id }])
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 6000)
  }, [])

  const ctx = useMemo(
    () => ({ user, perms, settings, reloadSettings, theme, notify }),
    [user, perms, settings, reloadSettings, theme, notify],
  )

  const nextTheme = { system: 'light', light: 'dark', dark: 'system' }[themePref]
  const current = devices.data?.find((d) => d.id === device)

  let page = <div className="empty">Waiting for a meter to report…</div>
  if (active === 'portfolio') page = <Portfolio onOpen={(id) => { setDevice(id); go('dashboard') }} />
  else if (device) {
    if (active === 'dashboard') page = <Dashboard key={device} device={device} />
    if (active === 'reports') page = <Reports device={device} />
    if (active === 'automations') page = <Automations device={device} />
    if (active === 'settings') page = <Settings />
  }

  return (
    <AppContext.Provider value={ctx}>
      <header className="topbar">
        <div className="brand"><Logo /> Smart Watt</div>
        {DEMO && (
          <span className="pill demo-pill" title="Simulated meter data, running entirely in your browser">
            <span className="dot on" />Live demo · simulated data
          </span>
        )}
        <nav className="nav" aria-label="Main">
          {nav.map(([id, label]) => (
            <a key={id} href={`#/${id}`} className={active === id ? 'active' : ''} aria-current={active === id ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
        <div className="topbar-right">
          {devices.data?.length > 0 && active !== 'portfolio' && (
            <select aria-label="Meter" value={device || ''} onChange={(e) => setDevice(e.target.value)} style={{ width: 'auto', maxWidth: 220 }}>
              {devices.data.map((d) => (
                <option key={d.id} value={d.id}>{d.online ? '● ' : '○ '}{d.id}</option>
              ))}
            </select>
          )}
          {current && !current.online && active !== 'portfolio' && <Status level="warning">Offline</Status>}
          <button type="button" className="btn sm" onClick={() => setThemePref(nextTheme)} title={`Switch to ${nextTheme} theme`}>
            Theme: {themePref}
          </button>
          <div className="user-chip">
            <strong>{user.display_name || user.username}</strong>
            <small>{user.role}</small>
          </div>
          <button type="button" className="btn sm" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <main className="content">{page}</main>

      {device && active !== 'portfolio' && <Assistant device={device} canControl={perms.includes('control')} />}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <Status level={t.level === 'info' ? 'info' : t.level}>{t.title}</Status>
            {t.message && <div className="msg">{t.message}</div>}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  )
}
