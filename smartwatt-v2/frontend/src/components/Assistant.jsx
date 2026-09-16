import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'

const SUGGESTIONS = [
  'Which device uses most?',
  'How much did AC use today?',
  'Projected bill?',
  'How close am I to the next slab?',
  'How many kWh today?',
  'Turn off AC',
  'Turn off everything except Refrigerator',
]

export default function Assistant({ device, canControl }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([
    { from: 'bot', text: 'Hello, I am the Energy Assistant. Ask about usage, your bill, or switching appliances.' },
  ])
  const logRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, open])
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  const suggestions = canControl ? SUGGESTIONS : SUGGESTIONS.filter((s) => !/^turn/i.test(s))

  async function send(text) {
    const q = text.trim()
    if (!q || busy) return
    setInput('')
    setLog((l) => [...l, { from: 'user', text: q }])
    setBusy(true)
    try {
      const reply = await api(`/assistant/${encodeURIComponent(device)}`, { method: 'POST', body: { query: q } })
      setLog((l) => [...l, { from: 'bot', text: reply.text }])
    } catch (e) {
      setLog((l) => [...l, { from: 'bot', text: e.message, denied: e.status === 403 }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {open && (
        <div className="assistant" role="dialog" aria-label="Energy Assistant">
          <header>
            <strong>Energy Assistant</strong>
            <span className="faint small">{device}</span>
            <button type="button" className="btn ghost icon" aria-label="Close assistant" onClick={() => setOpen(false)}>✕</button>
          </header>
          <div className="log" ref={logRef} aria-live="polite">
            {log.map((m, i) => (
              <div key={i} className={`bubble ${m.from} ${m.denied ? 'denied' : ''}`}>{m.text}</div>
            ))}
            {busy && <div className="bubble bot faint">…</div>}
          </div>
          <div className="suggest">
            {suggestions.map((s) => (
              <button type="button" key={s} className="chip" onClick={() => send(s)} disabled={busy}>{s}</button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(input) }}>
            <input
              ref={inputRef}
              type="text"
              value={input}
              maxLength={500}
              placeholder={canControl ? "e.g. 'How much did AC use today?' or 'Turn off AC'" : "e.g. 'Projected bill?'"}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Ask the Energy Assistant"
            />
            <button type="submit" className="btn primary" disabled={busy || !input.trim()}>Send</button>
          </form>
        </div>
      )}
      <button type="button" className="fab" aria-label={open ? 'Close Energy Assistant' : 'Open Energy Assistant'} onClick={() => setOpen((o) => !o)}>
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M12.6 7.2 9.8 11h2.4l-.6 3 2.8-3.8H12z" fill="currentColor" />
        </svg>
      </button>
    </>
  )
}
