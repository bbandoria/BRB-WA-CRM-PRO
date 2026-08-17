import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { hashUazapiToken } from '@/lib/whatsapp/uazapi-webhook-auth'
import {
  getInstanceStatus,
  connectInstance,
  configureWebhook,
} from '@/lib/whatsapp/uazapi-client'

function webhookUrl(): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL || ''
  return `${site.replace(/\/$/, '')}/api/whatsapp/webhook`
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
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
          uazapi_instance_token: encrypt(instanceToken),
          uazapi_instance_token_hash: hashUazapiToken(instanceToken),
          uazapi_status: 'connecting',
        },
        { onConflict: 'account_id' }
      )
      .select()
      .single()

    if (upsertError || !upserted) {
      return NextResponse.json({ error: 'Failed to save instance token' }, { status: 500 })
    }

    await configureWebhook(instanceToken, webhookUrl())

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
