import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashUazapiToken } from '@/lib/whatsapp/uazapi-webhook-auth'

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    /**
     * SHA-256 of the UAZAPI instance token stored on the single
     * whatsapp_config row the mocked DB knows about. The config lookup
     * filters on it exactly as the real `.eq(...)` would, so a payload
     * carrying any other token resolves to zero rows.
     */
    uazapiTokenHash: null as string | null,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    /** Rows written by findOrCreateContact's name refresh. */
    contactUpdates: [] as Record<string, unknown>[],
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              // select('*').eq('uazapi_instance_token_hash', hash)
              eq: (_column: string, value: string) =>
                Promise.resolve({
                  data:
                    h.state.uazapiTokenHash && h.state.uazapiTokenHash === value
                      ? [
                          {
                            id: 'cfg-1',
                            account_id: 'acc-1',
                            user_id: 'user-1',
                            uazapi_instance_token_hash: h.state.uazapiTokenHash,
                          },
                        ]
                      : [],
                  error: null,
                }),
            }),
          }
        case 'contacts':
          // findOrCreateContact refreshes the stored name when the
          // sender's WhatsApp profile name changed: update().eq()
          return {
            update: (row: Record<string, unknown>) => {
              h.state.contactUpdates.push(row)
              return { eq: () => Promise.resolve({ data: null, error: null }) }
            },
          }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          }
        case 'broadcast_recipients':
          // flagBroadcastReplyIfAny: select().eq().eq().in().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () =>
                        Promise.resolve({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }
        case 'messages':
          return {
            // priorCustomerMsgCount: select('id',{count,head}).eq().eq()
            select: () => ({
              eq: () => ({
                eq: () =>
                  Promise.resolve({
                    count: h.state.priorCustomerMsgCount,
                    error: null,
                  }),
              }),
            }),
            // Idempotent insert: upsert(...).select('id')
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              }
            },
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: vi.fn(async () => undefined),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import { POST } from './route'

/**
 * One UAZAPI `messages` event, exactly as the provider POSTs it: a
 * single message per HTTP request, with the instance token in cleartext
 * at the root of the body.
 */
function uazapiTextPayload(
  overrides?: Partial<{
    text: string
    senderPn: string
    fromMe: boolean
    wasSentByApi: boolean
    messageid: string
    chatid: string
    isGroup: boolean
    type: string
    EventType: string
  }>,
) {
  return {
    EventType: overrides?.EventType ?? 'messages',
    token: 'tok-123',
    instanceName: 'BRB WACRM',
    message: {
      chatid: overrides?.chatid ?? '5519999353218@s.whatsapp.net',
      messageid: overrides?.messageid ?? 'A5D6F48B790E9AD6A3BD05FF75BCCCC4',
      fromMe: overrides?.fromMe ?? false,
      isGroup: overrides?.isGroup ?? false,
      messageType: 'Conversation',
      type: overrides?.type ?? 'text',
      text: overrides?.text ?? 'Oi',
      messageTimestamp: 1786970871000,
      sender_pn: overrides?.senderPn ?? '5519999353218@s.whatsapp.net',
      senderName: 'BRB Agência Digital',
      wasSentByApi: overrides?.wasSentByApi ?? false,
    },
  }
}

/**
 * The mocked `NextResponse.json` returns a plain `{ body, init }` pair
 * rather than a real Response, so assertions read the status off `init`.
 * POST's declared return type is NextResponse — cast once, here.
 */
type MockedResponse = { body: unknown; init?: { status?: number } }

async function postWebhook(body: unknown): Promise<MockedResponse> {
  const res = await POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
  )
  return res as unknown as MockedResponse
}

async function runWebhook(overrides?: Parameters<typeof uazapiTextPayload>[0]) {
  const res = await postWebhook(uazapiTextPayload(overrides))
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.priorCustomerMsgCount = 0
  h.state.uazapiTokenHash = hashUazapiToken('tok-123')
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' }
  h.state.contactUpdates = []
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.afterCallbacks = []
  h.state.automationStarted = 0
  h.state.automationCompleted = 0
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++
        resolve()
      }, 0)
    })
  })
})

describe('POST /api/whatsapp/webhook — UAZAPI', () => {
  it('accepts a payload whose token hash matches a configured account', async () => {
    h.state.uazapiTokenHash = hashUazapiToken('tok-123')
    const response = await postWebhook(uazapiTextPayload())
    expect(response.init?.status ?? 200).toBe(200)
    for (const cb of h.state.afterCallbacks) await cb()
    expect(h.state.upsertCalls.at(-1)?.row).toMatchObject({
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Oi',
      message_id: 'A5D6F48B790E9AD6A3BD05FF75BCCCC4',
    })
  })

  it('rejects a payload whose token does not match any account', async () => {
    h.state.uazapiTokenHash = hashUazapiToken('a-different-token')
    const response = await postWebhook(uazapiTextPayload())
    expect(response.init?.status).toBe(401)
  })

  it('rejects a payload with no token at all', async () => {
    const body = uazapiTextPayload() as Record<string, unknown>
    delete body.token
    const response = await postWebhook(body)
    expect(response.init?.status).toBe(401)
  })

  it('ignores events that are echoes of our own API-sent messages', async () => {
    const response = await runWebhook({ fromMe: true, wasSentByApi: true })
    expect(response.body).toMatchObject({ status: 'ignored' })
    expect(h.state.upsertCalls.length).toBe(0)
  })

  it('ignores messages the owner typed on the phone itself', async () => {
    // fromMe with wasSentByApi:false — not an API echo, so the
    // idempotent upsert would NOT have caught it. Stored as a customer
    // message it would bump unread and trigger the AI auto-reply,
    // i.e. the CRM answering itself.
    const response = await runWebhook({ fromMe: true, wasSentByApi: false })
    expect(response.body).toMatchObject({ status: 'ignored' })
    expect(h.state.upsertCalls.length).toBe(0)
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('ignores group messages', async () => {
    // The group jid is not a phone number, but normalizePhone cannot
    // tell — processing it would mint a phantom contact.
    const response = await runWebhook({
      isGroup: true,
      chatid: '120363123456789012@g.us',
    })
    expect(response.body).toMatchObject({ status: 'ignored' })
    expect(h.state.upsertCalls.length).toBe(0)
  })

  it('ignores an event with no messageid, which would break idempotency', async () => {
    // A NULL message_id never conflicts on the unique index, so every
    // retry of this delivery would insert again and replay the fan-out.
    const response = await runWebhook({ messageid: '' })
    expect(response.body).toMatchObject({ status: 'ignored' })
    expect(h.state.upsertCalls.length).toBe(0)
  })

  it('ignores non-message events', async () => {
    const response = await runWebhook({ EventType: 'connection' })
    expect(response.init?.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ignored' })
    expect(h.state.upsertCalls.length).toBe(0)
  })

  it('ignores message types other than text (out of scope this phase)', async () => {
    const response = await runWebhook({ type: 'image' })
    expect(response.init?.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ignored' })
    expect(h.state.upsertCalls.length).toBe(0)
  })

  it('routes the inbound text to flows with the provider message id', async () => {
    await runWebhook()

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        message: {
          kind: 'text',
          text: 'Oi',
          meta_message_id: 'A5D6F48B790E9AD6A3BD05FF75BCCCC4',
        },
      }),
    )
  })
})

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook()

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    // Downstream side effects ran exactly once.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = []

    await runWebhook()

    expect(h.state.upsertCalls).toHaveLength(1)
    // None of the downstream side effects fire on a replay.
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook()

    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1' },
    })
  })
})

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook()

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3)
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3)
  })
})
