import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { hashUazapiToken } from '@/lib/whatsapp/uazapi-webhook-auth'
import {
  getInstanceStatus,
  connectInstance,
  configureWebhook,
} from '@/lib/whatsapp/uazapi-client'

// Resolve the absolute origin this deployment is reachable at.
//
// Mirrors the resolution chain in /api/account/invitations' getBaseUrl
// (explicit env → proxy headers → Host header), minus the marketing-
// domain fallback: an invite link pointing at the wrong host is a bad
// link a human notices, but a *webhook* URL pointing at the wrong host
// (or a relative one — UAZAPI accepts `/api/whatsapp/webhook` and then
// silently never delivers anything) is an invisible outage. So when
// nothing resolves, we throw instead of registering a broken URL.
function resolveBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const vercel = process.env.VERCEL_URL?.trim()
  if (vercel) return `https://${vercel.replace(/\/+$/, '')}`

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`

  const host = request.headers.get('host')?.trim()
  if (host) {
    const reqProto = new URL(request.url).protocol.replace(':', '')
    return `${reqProto}://${host}`
  }

  throw new Error(
    'Cannot determine this deployment’s public URL for the UAZAPI webhook. Set NEXT_PUBLIC_SITE_URL.'
  )
}

function webhookUrl(request: Request): string {
  return `${resolveBaseUrl(request)}/api/whatsapp/webhook`
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = await request.json()
    const instanceToken = body.instance_token as string | undefined

    if (!instanceToken) {
      return NextResponse.json({ error: 'instance_token is required' }, { status: 400 })
    }

    const { data: upserted, error: upsertError } = await supabase
      .from('whatsapp_config')
      .upsert(
        {
          account_id: accountId,
          user_id: userId,
          uazapi_instance_token: encrypt(instanceToken),
          uazapi_instance_token_hash: hashUazapiToken(instanceToken),
          uazapi_status: 'connecting',
        },
        { onConflict: 'account_id' }
      )
      .select()
      .single()

    if (upsertError || !upserted) {
      console.error(
        '[uazapi/connect] upsert failed:',
        upsertError?.message ?? 'no row returned'
      )
      return NextResponse.json({ error: 'Failed to save instance token' }, { status: 500 })
    }

    await configureWebhook(instanceToken, webhookUrl(request))

    const status = await getInstanceStatus(instanceToken)
    if (status.connected) {
      await supabase
        .from('whatsapp_config')
        .update({ uazapi_status: 'connected' })
        .eq('id', upserted.id)
      return NextResponse.json({ connected: true, name: status.name, profileName: status.profileName })
    }

    const connectResult = await connectInstance(instanceToken)
    return NextResponse.json({ connected: false, qrcode: connectResult.qrcode })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('uazapi_instance_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config?.uazapi_instance_token) {
      return NextResponse.json({ connected: false, name: '', profileName: '', owner: '' })
    }

    const status = await getInstanceStatus(decrypt(config.uazapi_instance_token))
    return NextResponse.json(status)
  } catch (error) {
    return toErrorResponse(error)
  }
}
