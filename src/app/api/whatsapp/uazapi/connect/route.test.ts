import { describe, expect, it, vi, beforeEach } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getInstanceStatus: vi.fn(),
  connectInstance: vi.fn(),
  configureWebhook: vi.fn(),
  upsertedRow: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: unknown) =>
    ({ body: { error: String(e) }, init: { status: 500 } }) as unknown,
}))
vi.mock('@/lib/whatsapp/uazapi-client', () => ({
  getInstanceStatus: h.getInstanceStatus,
  connectInstance: h.connectInstance,
  configureWebhook: h.configureWebhook,
}))
vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, init }) },
}))

function fakeSupabase() {
  return {
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        h.upsertedRow = row
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'cfg-1' }, error: null }) }) }
      },
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: h.upsertedRow, error: null }) }),
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.upsertedRow = null
  h.requireRole.mockResolvedValue({
    supabase: fakeSupabase(),
    accountId: 'acc-1',
    userId: 'user-1',
  })
})

describe('POST /api/whatsapp/uazapi/connect', () => {
  it('saves the instance token, registers the webhook, and returns status', async () => {
    h.getInstanceStatus.mockResolvedValue({ connected: false, name: '', profileName: '', owner: '' })
    h.connectInstance.mockResolvedValue({ qrcode: 'data:image/png;base64,AAAA' })

    const { POST } = await import('./route')
    const response = await POST(
      // The Host header matters: the route refuses to register a
      // relative/unresolvable webhook URL with UAZAPI, so a fixture
      // request has to look like a real one.
      new Request('http://x', {
        method: 'POST',
        headers: { host: 'app.example.com' },
        body: JSON.stringify({ instance_token: 'tok-123' }),
      })
    )

    expect(h.configureWebhook).toHaveBeenCalledWith('tok-123', expect.stringContaining('/api/whatsapp/webhook'))
    expect((response as unknown as { body: { qrcode: string } }).body.qrcode).toBe('data:image/png;base64,AAAA')
  })

  it('rejects a missing instance_token with 400', async () => {
    const { POST } = await import('./route')
    const response = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({}) })
    )
    expect((response as unknown as { init: { status: number } }).init.status).toBe(400)
  })
})

describe('GET /api/whatsapp/uazapi/connect', () => {
  it('returns the current instance status', async () => {
    h.upsertedRow = { uazapi_instance_token: encrypt('tok-123') }
    h.getInstanceStatus.mockResolvedValue({
      connected: true, name: 'BRB WACRM', profileName: 'BRB Suporte', owner: '5519987812265',
    })

    const { GET } = await import('./route')
    const response = await GET()
    expect((response as unknown as { body: { connected: boolean } }).body.connected).toBe(true)
  })
})
