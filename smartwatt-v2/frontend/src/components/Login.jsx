import { useState } from 'react'
import { api, DEMO } from '../lib/api.js'
import { Logo } from '../lib/ui.jsx'

const DEMO_ACCOUNTS = [
  { username: 'home', password: 'home123', label: 'Homeowner', note: 'view + control' },
  { username: 'utility', password: 'utility123', label: 'Utility', note: 'read-only, all meters' },
  { username: 'admin', password: '', label: 'Admin', note: 'password from .env' },
]

const REPO_URL = 'https://github.com/SHYanwad-Div/SmartWatt'

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('home')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function signIn(user, pass) {
    setBusy(true)
    setError('')
    try {
      const res = await api('/auth/login', { method: 'POST', body: { username: user, password: pass } })
      onLogin(res.token, res.user)
    } catch (err) {
      setError(err.status === 401 ? 'Wrong username or password.' : err.message)
    } finally {
      setBusy(false)
    }
  }

  if (DEMO) {
    return (
      <div className="login-wrap">
        <div className="card login">
          <div className="brand"><Logo /> Smart Watt</div>
          <h1>Live demo</h1>
          <p className="muted" style={{ margin: 0 }}>
            An IoT home energy monitor, shown the way it would look with sensors installed. It runs
            on simulated meter data inside your browser: nothing is sent anywhere, and anything you
            switch or change stays on your device.
          </p>
          <div className="demo-roles">
            <button type="button" className="btn primary" disabled={busy} onClick={() => signIn('home', 'demo')}>
              Explore as Homeowner
              <small>see every appliance and switch them</small>
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => signIn('utility', 'demo')}>
              Explore as Utility analyst
              <small>read-only view across three meters</small>
            </button>
          </div>
          {busy && <p className="faint small" role="status">Preparing today&apos;s readings…</p>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <p className="faint small" style={{ marginBottom: 0 }}>
            Source code: <a href={REPO_URL} target="_blank" rel="noreferrer">github.com/SHYanwad-Div/SmartWatt</a>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="login-wrap">
      <div className="card login">
        <div className="brand"><Logo /> Smart Watt</div>
        <h1>Sign in</h1>
        <p className="muted" style={{ margin: 0 }}>IoT energy consumption monitoring</p>
        <form onSubmit={(e) => { e.preventDefault(); signIn(username, password) }}>
          <div className="field">
            <label htmlFor="u">Username</label>
            <input id="u" type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="p">Password</label>
            <input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="section-title">Demo accounts</div>
        <div className="demo">
          {DEMO_ACCOUNTS.map((d) => (
            <button
              key={d.username}
              type="button"
              className="btn"
              style={{ flexDirection: 'column', alignItems: 'flex-start' }}
              onClick={() => { setUsername(d.username); setPassword(d.password); setError('') }}
            >
              {d.label}<small>{d.note}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
