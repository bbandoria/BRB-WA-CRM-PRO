import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { hashUazapiToken } from '@/lib/whatsapp/uazapi-webhook-auth'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing fans out to flows, automations and AI auto-reply, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: 'wacrm' } }
    )
  }
  return _adminClient
}

/**
 * UAZAPI delivers ONE event per HTTP request — there is no `entry[] /
 * changes[] / value.messages[]` batching envelope like Meta's Cloud API
 * had. `token` at the root is the instance token in cleartext; it is
 * what authenticates the request (we hash it and match it against
 * whatsapp_config.uazapi_instance_token_hash).
 */
interface UazapiMessagePayload {
  EventType: string
  token: string
  message?: {
    chatid: string
    messageid: string
    fromMe: boolean
    isGroup: boolean
    type: string
    text?: string
    content?: string
    messageTimestamp: number
    sender_pn?: string
    senderName?: string
    wasSentByApi: boolean
  }
}

// POST - Receive a single inbound event
export async function POST(request: Request) {
  const rawBody = await request.text()

  let body: UazapiMessagePayload
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 401 })
  }

  const tokenHash = hashUazapiToken(body.token)
  const { data: configRows, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('uazapi_instance_token_hash', tokenHash)

  if (configError) {
    console.error('[webhook] error looking up whatsapp_config by token hash:', configError)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!configRows || configRows.length === 0) {
    console.warn('[webhook] no account matches the UAZAPI instance token in this event')
    return NextResponse.json({ error: 'Unknown instance token' }, { status: 401 })
  }

  const config = configRows[0]

  // Only the `messages` event, text type, is handled in this phase.
  if (body.EventType !== 'messages' || !body.message || body.message.type !== 'text') {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  // Three classes of event that must never become a customer message:
  //
  //  - `fromMe`: anything sent BY the connected number. When
  //    `wasSentByApi` it's an echo of our own send (already persisted by
  //    send-message.ts); when not, the owner typed it on the phone
  //    itself. Neither is inbound, and treating either as one stores it
  //    as sender_type='customer', bumps unread, and fires flows /
  //    automations / AI auto-reply — i.e. the CRM answering itself.
  //  - `isGroup`: the sender jid of a group event is the group's own
  //    `...@g.us` id, which normalizePhone cannot tell apart from a
  //    phone number. That mints a phantom contact, and an AI auto-reply
  //    would then be sent privately to the wrong party.
  //  - missing `messageid`: message_id would be written NULL, and NULL
  //    never conflicts on the (conversation_id, message_id) unique
  //    index — so the idempotent upsert silently stops being idempotent
  //    and every webhook retry would duplicate the message and replay
  //    the whole fan-out.
  if (body.message.fromMe || body.message.isGroup || !body.message.messageid) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const message = body.message

  // Process AFTER the response so we ack the provider quickly (a slow ack
  // triggers retries + duplicate deliveries), while still guaranteeing the
  // work runs to completion.
  //
  // This MUST use `after()` rather than a detached promise: on serverless
  // platforms (we run on Vercel) the function can be frozen or terminated
  // the moment the response is sent, so a floating promise's DB writes are
  // not guaranteed to finish. That dropped a non-deterministic *subset* of
  // inbound messages — contacts/conversations were created but the message
  // insert never landed (see issue #301). `after()` hands the callback to
  // the runtime, which keeps the function alive until it resolves (within
  // the route's maxDuration).
  after(async () => {
    try {
      await processInboundText(message, config.account_id, config.user_id)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

async function processInboundText(
  message: NonNullable<UazapiMessagePayload['message']>,
  // Tenancy — drives every contact / conversation lookup and the
  // engines' active-row dispatch.
  accountId: string,
  // Audit / sender-of-record — used as the user_id on row inserts that
  // need it for NOT NULL FK compliance. Always the admin who saved the
  // WhatsApp config.
  configOwnerUserId: string
) {
  const senderRaw = message.sender_pn || message.chatid
  const senderPhone = normalizePhone(senderRaw.split('@')[0])
  const contentText = message.text || message.content || ''

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    message.senderName || senderPhone
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert. The provider retries webhook deliveries (a slow
  // ack, a transient 5xx), and each retry replays the exact same
  // messageid. The unique index on (conversation_id, message_id) makes a
  // replay conflict; `ignoreDuplicates` turns that into ON CONFLICT DO
  // NOTHING, and `.select()` then returns a row ONLY on a genuine first
  // insert — an empty result means this delivery was a replay. This is
  // the single idempotency boundary, and it must sit BEFORE the unread
  // bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: contentText,
        message_id: message.messageid,
        status: 'delivered',
        created_at: new Date(message.messageTimestamp).toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  if (!insertedRows || insertedRows.length === 0) {
    console.info('[webhook] duplicate inbound message ignored (idempotent replay):', message.messageid)
    return
  }

  // The unread bump is done DB-side rather than as a read-modify-write of
  // a snapshot: two inbound messages for the same conversation can process
  // concurrently, and computing `snapshot + 1` in the app let both reads
  // see the same value and write the same increment, losing one (#369).
  const { error: convError } = await supabaseAdmin().rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || '[text]',
  })
  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409).
  await reopenClosedConversation(supabaseAdmin(), conversation)
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active run
  // or started a new one), we suppress the `new_message_received` +
  // `keyword_match` automation triggers for this inbound. The customer is
  // navigating the bot menu, not sending a fresh trigger word.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those are
  // about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed` result
  // before deciding whether to dispatch automations.
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: { kind: 'text', text: contentText, meta_message_id: message.messageid },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through (issue #301's
  // failure mode, one level down). `runAutomationsForTrigger` owns its own
  // try/catch and never throws; the `.catch` is belt-and-braces so one
  // trigger type's failure can't skip the rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: { message_text: contentText, conversation_id: conversation.id },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for text the deterministic flow runner did
  // NOT consume (flows win over the LLM), and only when the account has
  // enabled it. `dispatchInboundToAiReply` owns its eligibility gates +
  // try/catch and never throws.
  if (!flowConsumed && contentText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited for the same reason as
  // the automations above. `dispatchWebhookEvent` early-exits when the
  // account has no matching endpoint and never throws.
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.messageid,
    content_type: 'text',
    text: contentText,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processInboundText. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — a retried delivery, or a
  // batch fanning out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
