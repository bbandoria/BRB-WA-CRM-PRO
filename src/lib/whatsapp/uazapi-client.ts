/**
 * UAZAPI client — the single module that speaks HTTP to the UAZAPI
 * server. Mirrors the shape of meta-api.ts: named-args functions,
 * throw on non-2xx, no retry logic here (callers own that).
 */

function baseUrl(): string {
  const url = process.env.UAZAPI_SERVER_URL;
  if (!url) throw new Error('UAZAPI_SERVER_URL is not configured');
  return url.replace(/\/$/, '');
}

export class UazapiApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UazapiApiError';
    this.status = status;
  }
}

async function request<T>(
  path: string,
  instanceToken: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      token: instanceToken,
      'Content-Type': 'application/json',
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  if (!response.ok) {
    let message = `UAZAPI error: ${response.status}`;
    try {
      const data = (await response.json()) as { message?: string };
      if (data.message) message = data.message;
    } catch {
      // response body wasn't JSON — keep the fallback
    }
    throw new UazapiApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

export interface UazapiInstanceStatus {
  connected: boolean;
  name: string;
  profileName: string;
  owner: string;
}

export async function getInstanceStatus(
  instanceToken: string
): Promise<UazapiInstanceStatus> {
  const data = await request<{
    instance: { name?: string; profileName?: string; owner?: string };
    status: { connected: boolean };
  }>('/instance/status', instanceToken);

  return {
    connected: data.status.connected,
    name: data.instance.name ?? '',
    profileName: data.instance.profileName ?? '',
    owner: data.instance.owner ?? '',
  };
}

export interface UazapiConnectResult {
  qrcode: string;
}

export async function connectInstance(
  instanceToken: string
): Promise<UazapiConnectResult> {
  const data = await request<{ instance: { qrcode?: string } }>(
    '/instance/connect',
    instanceToken,
    { method: 'POST' }
  );
  return { qrcode: data.instance.qrcode ?? '' };
}

/**
 * Registers the app's webhook for this instance, subscribed to the
 * `messages` event only. UAZAPI's POST /webhook REPLACES the
 * instance's webhook list rather than appending — safe here because
 * every wacrm account uses a dedicated instance (never shared with
 * another consumer). See the design spec for how this was confirmed.
 */
export async function configureWebhook(
  instanceToken: string,
  webhookUrl: string
): Promise<void> {
  await request('/webhook', instanceToken, {
    method: 'POST',
    body: { url: webhookUrl, events: ['messages'], enabled: true },
  });
}

export interface SendTextArgs {
  instanceToken: string;
  number: string;
  text: string;
}

export async function sendText(
  args: SendTextArgs
): Promise<{ messageId: string }> {
  const { instanceToken, number, text } = args;
  const data = await request<{ messageid: string }>(
    '/send/text',
    instanceToken,
    { method: 'POST', body: { number, text } }
  );
  return { messageId: data.messageid };
}
