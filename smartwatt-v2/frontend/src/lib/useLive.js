import { useEffect, useState } from 'react'
import { api } from './api.js'
import { connectLive } from './live.js'

const WINDOW_MS = 15 * 60 * 1000

/**
 * Live feed for one device, seeded with the last 15 minutes so the chart is not
 * empty on first paint. Transport (WebSocket or in-browser demo) is in live.js.
 */
export function useLive(deviceId) {
  const [reading, setReading] = useState(null)
  const [series, setSeries] = useState([])
  const [status, setStatus] = useState('connecting')
  const [lastEvent, setLastEvent] = useState(null)
  const [alertFeed, setAlertFeed] = useState([])
  const [controlTick, setControlTick] = useState(0)

  useEffect(() => {
    if (!deviceId) return undefined
    let closed = false

    setReading(null)
    setSeries([])
    api(`/readings/${encodeURIComponent(deviceId)}?range=15m&limit=900`)
      .then((r) => {
        if (!closed) setSeries((cur) => (cur.length > r.points.length ? cur : r.points))
      })
      .catch(() => {})

    const disconnect = connectLive(deviceId, {
      onStatus: (s) => { if (!closed) setStatus(s) },
      onMessage: (data) => {
        if (closed) return
        if (data.type === 'reading') {
          const r = data.reading
          setReading(r)
          setSeries((cur) => {
            if (cur.length && cur[cur.length - 1].ts >= r.ts) return cur
            const cutoff = r.ts - WINDOW_MS
            let start = 0
            while (start < cur.length && cur[start].ts < cutoff) start += 1
            return [...cur.slice(start), { ts: r.ts, power_w: r.power_w }]
          })
          if (data.event) setLastEvent(data.event)
        } else if (data.type === 'alert') {
          setAlertFeed((cur) => [data.alert, ...cur].slice(0, 20))
        } else if (data.type === 'control' || data.type === 'automation') {
          setControlTick((t) => t + 1)
        }
      },
    })

    return () => {
      closed = true
      disconnect()
    }
  }, [deviceId])

  return { reading, series, status, lastEvent, alertFeed, controlTick }
}
