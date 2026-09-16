// Thin client over the Smart Watt REST + WebSocket API.

const TOKEN_KEY = 'sw_token'
const USER_KEY = 'sw_user'

function store(fn, fallback = null) {
  try { return fn() } catch { return fallback }   // storage can throw (private mode)
}

export const getToken = () => store(() => localStorage.getItem(TOKEN_KEY))
export const getUser = () => store(() => JSON.parse(localStorage.getItem(USER_KEY) || 'null'))

export function setSession(token, user) {
  store(() => {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  })
}

export function clearSession() {
  store(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  })
}

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail)
    this.status = status
  }
}

async function errorDetail(res) {
  try {
    const body = await res.json()
    if (typeof body.detail === 'string') return body.detail
    if (Array.isArray(body.detail) && body.detail[0]?.msg) {
      const d = body.detail[0]
      return `${(d.loc || []).slice(1).join('.')}: ${d.msg}`
    }
  } catch { /* not JSON */ }
  return res.statusText || `HTTP ${res.status}`
}

/** Static showcase build: the backend runs inside the browser (src/demo). */
export const DEMO = import.meta.env?.VITE_DEMO === '1'

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  if (DEMO) {
    try {
      const { demoApi } = await import('../demo/engine.js')
      return await demoApi(path, { method, body, raw })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && path !== '/auth/login') {
        clearSession()
        window.dispatchEvent(new Event('sw:logout'))
      }
      throw e
    }
  }
  const headers = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401 && path !== '/auth/login') {
    clearSession()
    window.dispatchEvent(new Event('sw:logout'))
  }
  if (!res.ok) throw new ApiError(res.status, await errorDetail(res))
  return raw ? res : res.json()
}

export function wsUrl(deviceId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const token = encodeURIComponent(getToken() || '')
  return `${proto}://${location.host}/api/ws/${encodeURIComponent(deviceId)}?token=${token}`
}

export async function downloadCsv(deviceId, range) {
  const res = await api(`/reports/${encodeURIComponent(deviceId)}/export.csv?range=${range}`, { raw: true })
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `smartwatt_${deviceId}_${range}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
