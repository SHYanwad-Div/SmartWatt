import { createContext, useContext, useEffect, useRef, useState } from 'react'

export const AppContext = createContext(null)
export const useApp = () => useContext(AppContext)

export const WIDGETS = [
  ['status', 'Status and current load'],
  ['tiles', 'Voltage, current, power factor, peak'],
  ['house3d', '3D home (click appliances to switch)'],
  ['live_chart', 'Live power chart'],
  ['today_energy', "Today's energy vs budget"],
  ['top_consumer', 'Highest consumer right now'],
  ['tip', 'Smart energy tip'],
  ['breakdown', 'Appliance breakdown and control'],
  ['donut', 'Energy share by appliance'],
  ['forecast', 'Load forecast'],
  ['billing', 'Bill and tariff slab'],
  ['events', 'Detected switching events'],
  ['alerts', 'Alerts'],
]

const PATHS = {
  good: <path d="M5 8.2 7 10.2 11 6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  warning: <path d="M8 4.8v3.8M8 10.9v.1" stroke="#0b0b0b" strokeWidth="1.8" strokeLinecap="round" />,
  serious: <path d="M8 4.8v3.8M8 10.9v.1" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />,
  critical: <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />,
  info: <path d="M8 7.3v4M8 4.9v.1" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />,
}

/** Status never rides on colour alone: icon shape + a text label beside it. */
export function StatusIcon({ level = 'info', size = 16 }) {
  const lvl = PATHS[level] ? level : 'info'
  const shape = lvl === 'warning'
    ? <path d="M8 1.5 15 14H1z" fill="currentColor" />
    : lvl === 'critical'
      ? <path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z" fill="currentColor" />
      : <circle cx="8" cy="8" r="7" fill="currentColor" />
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {shape}
      {PATHS[lvl]}
    </svg>
  )
}

export function Status({ level, children }) {
  return (
    <span className={`status ${level}`}>
      <StatusIcon level={level} />
      <span>{children}</span>
    </span>
  )
}

export function Card({ title, sub, actions, span = 12, className = '', children }) {
  return (
    <section className={`card span-${span} ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'on' : ''}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Fetch on mount and every `ms`. Keeps the previous data while refetching so
 * widgets hold their frame instead of flashing a loading state.
 */
export function usePoll(fetcher, ms, deps = []) {
  const [state, setState] = useState({ data: null, error: null })
  const [nonce, setNonce] = useState(0)
  const ref = useRef(fetcher)
  ref.current = fetcher

  useEffect(() => {
    let alive = true
    let timer
    const run = async () => {
      try {
        const data = await ref.current()
        if (alive) setState({ data, error: null })
      } catch (error) {
        if (alive) setState((s) => ({ data: s.data, error }))
      }
      if (alive && ms) timer = setTimeout(run, ms)
    }
    run()
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, ms])

  return { ...state, reload: () => setNonce((n) => n + 1) }
}

export function Logo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--accent)" />
      <path d="M13.5 3.5 6.5 13h5l-1 7.5 7-9.5h-5z" fill="var(--on-accent)" />
    </svg>
  )
}
