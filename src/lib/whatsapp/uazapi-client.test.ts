import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  getInstanceStatus,
  connectInstance,
  configureWebhook,
  sendText,
  UazapiApiError,
} from './uazapi-client';

const ORIGINAL_ENV = process.env.UAZAPI_SERVER_URL;

beforeEach(() => {
  process.env.UAZAPI_SERVER_URL = 'https://tectonny.uazapi.com';
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  process.env.UAZAPI_SERVER_URL = ORIGINAL_ENV;
  vi.unstubAllGlobals();
});

describe('getInstanceStatus', () => {
  it('calls GET /instance/status with the token header and returns connected status', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        instance: { name: 'BRB WACRM', profileName: 'BRB Suporte', owner: '5519987812265' },
        status: { connected: true, jid: '5519987812265:20@s.whatsapp.net' },
      }),
    });

    const result = await getInstanceStatus('tok-123');

    expect(fetch).toHaveBeenCalledWith(
      'https://tectonny.uazapi.com/instance/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ token: 'tok-123' }),
      })
    );
    expect(result).toEqual({
      connected: true,
      name: 'BRB WACRM',
      profileName: 'BRB Suporte',
      owner: '5519987812265',
    });
  });

  it('throws UazapiApiError on a non-2xx response', async () => {
    const mockFetch = (fetch as unknown as ReturnType<typeof vi.fn>);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: 'invalid token' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: 'invalid token' }),
    });

    await expect(getInstanceStatus('bad-token')).rejects.toBeInstanceOf(UazapiApiError);
    await expect(getInstanceStatus('bad-token')).rejects.toMatchObject({ status: 401 });
  });
});

describe('sendText', () => {
  it('POSTs to /send/text with the number and text, returns messageId', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messageid: '3EB0FC09FB42475624D4A0', status: 'Pending' }),
    });

    const result = await sendText({
      instanceToken: 'tok-123',
      number: '5519999353218',
      text: 'Oi',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://tectonny.uazapi.com/send/text',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          token: 'tok-123',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ number: '5519999353218', text: 'Oi' }),
      })
    );
    expect(result).toEqual({ messageId: '3EB0FC09FB42475624D4A0' });
  });

  it('throws UazapiApiError when the send fails', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ message: 'invalid number' }),
    });

    await expect(
      sendText({ instanceToken: 'tok-123', number: 'bad', text: 'x' })
    ).rejects.toBeInstanceOf(UazapiApiError);
  });
});

describe('configureWebhook', () => {
  it('POSTs to /webhook with the url and the messages event only', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ([{ url: 'https://example.com/hook', events: ['messages'], enabled: true }]),
    });

    await configureWebhook('tok-123', 'https://example.com/hook');

    expect(fetch).toHaveBeenCalledWith(
      'https://tectonny.uazapi.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ token: 'tok-123' }),
        body: JSON.stringify({
          url: 'https://example.com/hook',
          events: ['messages'],
          enabled: true,
        }),
      })
    );
  });
});

describe('connectInstance', () => {
  it('POSTs to /instance/connect and returns the qrcode', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ instance: { qrcode: 'data:image/png;base64,AAAA' } }),
    });

    const result = await connectInstance('tok-123');

    expect(fetch).toHaveBeenCalledWith(
      'https://tectonny.uazapi.com/instance/connect',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result).toEqual({ qrcode: 'data:image/png;base64,AAAA' });
  });
});
