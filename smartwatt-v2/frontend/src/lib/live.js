import { DEMO, wsUrl } from './api.js'

/**
 * Live feed for one device. The server build uses the WebSocket with capped
 * reconnect backoff; the static demo build subscribes to the in-browser engine.
 * Returns a disconnect function.
 */
export function connectLive(deviceId, { onStatus, onMessage }) {
  if (DEMO) {
    let closed = false
    let unsubscribe = () => {}
    onStatus('connecting')
    import('../demo/engine.js').then(({ subscribe }) => {
      if (closed) return
      unsubscribe = subscribe(deviceId, onMessage)
      onStatus('live')
    })
    return () => {
      closed = true
      unsubscribe()
    }
  }

  let ws
  let timer
  let closed = false
  let attempt = 0
  const connect = () => {
    onStatus(attempt ? 'reconnecting' : 'connecting')
    ws = new WebSocket(wsUrl(deviceId))
    ws.onopen = () => {
      attempt = 0
      onStatus('live')
    }
    ws.onmessage = (msg) => {
      let data
      try { data = JSON.parse(msg.data) } catch { return }
      onMessage(data)
    }
    ws.onclose = (e) => {
      if (closed) return
      if (e.code === 4401) {
        window.dispatchEvent(new Event('sw:logout'))
        return
      }
      onStatus('offline')
      attempt += 1
      timer = setTimeout(connect, Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4)))
    }
  }
  connect()
  return () => {
    closed = true
    clearTimeout(timer)
    if (ws) ws.close()
  }
}
