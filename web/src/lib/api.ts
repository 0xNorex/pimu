export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T>(path: string, body?: unknown, method?: 'PATCH' | 'PUT' | 'DELETE'): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = data as { error?: string; message?: string }
    if (res.status === 401 && path !== '/api/login') location.hash = '#/login'
    throw new ApiError(res.status, e.error ?? 'http_error', e.message ?? `HTTP ${res.status}`)
  }
  return data as T
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
