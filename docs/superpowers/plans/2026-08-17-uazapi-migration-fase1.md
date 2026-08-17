# UAZAPI Migration — Fase 1 (MVP: conexão + texto) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a integração Meta Cloud API pela UAZAPI para o caminho mínimo funcional: conectar um número via QR code, enviar e receber mensagens de **texto** no Inbox, com toda a lógica existente de contatos/conversas/automações/flows/IA reaproveitada sem alteração.

**Architecture:** Uma nova camada `src/lib/whatsapp/uazapi-client.ts` substitui `meta-api.ts` como único ponto de contato HTTP com o provedor. `send-message.ts` passa a chamar essa camada para mensagens de texto (outros tipos lançam um erro explícito "ainda não suportado" nesta fase). O webhook de entrada é reescrito do zero — o payload da UAZAPI chega **uma mensagem por requisição** (não em lote como a Meta), o que simplifica bastante o handler. A conta é identificada pelo hash do `token` da instância enviado no corpo do evento, sem verificação de assinatura HMAC.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres, schema `wacrm`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-uazapi-migration-design.md`

## Global Constraints

- `UAZAPI_SERVER_URL` é uma env var de aplicação (não por conta) — ex.: `https://tectonny.uazapi.com`.
- Números de telefone continuam em formato E.164 sem `+` (`sanitizePhoneForMeta`/`normalizePhone` de `phone-utils.ts` são reaproveitados sem mudança).
- Toda chamada de saída à UAZAPI usa o header `token: <instance_token da conta>`.
- O `uazapi_instance_token` é armazenado criptografado (AES-256-GCM, `encryption.ts`, mesmo mecanismo já usado para `access_token`); a busca da conta a partir do payload do webhook usa um hash SHA-256 separado (`uazapi_instance_token_hash`), não o valor criptografado.
- Esta fase cobre **apenas mensagens de texto**. Mídia, status de entrega (✓✓), reações e mensagens interativas ficam para fases seguintes — não implementar aqui.
- Não remover nem modificar `meta-api.ts`, as rotas de templates, nem qualquer código relacionado à Meta nesta fase — a remoção é escopo da Fase 3 do projeto maior. O objetivo aqui é a UAZAPI funcionar em paralelo, não a limpeza.
- `whatsapp_config` ganha colunas novas (migração aditiva) — nenhuma coluna existente é removida ou renomeada.

---

### Task 1: Migração de banco — colunas UAZAPI em `whatsapp_config`

**Files:**
- Create: `supabase/migrations/040_uazapi_config.sql`

**Interfaces:**
- Produces: colunas `whatsapp_config.uazapi_instance_token` (text, criptografado), `whatsapp_config.uazapi_instance_token_hash` (text, único, sha256 hex), `whatsapp_config.uazapi_instance_id` (text, nullable), `whatsapp_config.uazapi_status` (text, `'disconnected' | 'connecting' | 'connected'`, default `'disconnected'`).

- [ ] **Step 1: Escrever a migração**

```sql
-- ============================================================
-- 040_uazapi_config.sql
--
-- Adds UAZAPI instance fields to whatsapp_config, additive only.
-- Existing Meta-specific columns (phone_number_id, waba_id,
-- access_token, verify_token, registered_at, etc.) are left
-- untouched — they simply stop being read by the UAZAPI code path.
--
-- uazapi_instance_token_hash exists because AES-256-GCM encryption
-- (encryption.ts) is non-deterministic (random IV per call), so the
-- encrypted uazapi_instance_token column can't be looked up by
-- equality. The UAZAPI webhook sends the instance token in plaintext
-- in every event body; the webhook handler hashes it and looks up
-- this column instead (same pattern as api_keys.key_hash).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (uazapi_status IN ('disconnected', 'connecting', 'connected'));

DROP INDEX IF EXISTS whatsapp_config_uazapi_instance_token_hash_idx;
CREATE UNIQUE INDEX whatsapp_config_uazapi_instance_token_hash_idx
  ON whatsapp_config (uazapi_instance_token_hash)
  WHERE uazapi_instance_token_hash IS NOT NULL;
```

- [ ] **Step 2: Aplicar a migração no banco de desenvolvimento local (schema `wacrm`)**

Rode via Management API (mesmo método usado para as migrações 001-039 — ver histórico da sessão), com o texto da migração prefixado por `SET search_path TO wacrm, public, extensions;`. Confirme com:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'wacrm' AND table_name = 'whatsapp_config'
AND column_name LIKE 'uazapi%';
```

Esperado: 4 linhas (`uazapi_instance_token`, `uazapi_instance_token_hash`, `uazapi_instance_id`, `uazapi_status`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/040_uazapi_config.sql
git commit -m "feat(whatsapp): add UAZAPI instance columns to whatsapp_config"
```

---

### Task 2: `src/lib/whatsapp/uazapi-client.ts` — cliente HTTP

**Files:**
- Create: `src/lib/whatsapp/uazapi-client.ts`
- Test: `src/lib/whatsapp/uazapi-client.test.ts`

**Interfaces:**
- Consumes: `process.env.UAZAPI_SERVER_URL`
- Produces:
  - `getInstanceStatus(instanceToken: string): Promise<UazapiInstanceStatus>`
  - `connectInstance(instanceToken: string): Promise<UazapiConnectResult>`
  - `configureWebhook(instanceToken: string, webhookUrl: string): Promise<void>`
  - `sendText(args: { instanceToken: string; number: string; text: string }): Promise<{ messageId: string }>`
  - `class UazapiApiError extends Error` com campo `status: number`

- [ ] **Step 1: Escrever os testes**

```typescript
// src/lib/whatsapp/uazapi-client.test.ts
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
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
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
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx vitest run src/lib/whatsapp/uazapi-client.test.ts`
Expected: FAIL — `Cannot find module './uazapi-client'`

- [ ] **Step 3: Implementar o client**

```typescript
// src/lib/whatsapp/uazapi-client.ts
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
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/whatsapp/uazapi-client.test.ts`
Expected: PASS (7 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/uazapi-client.ts src/lib/whatsapp/uazapi-client.test.ts
git commit -m "feat(whatsapp): add UAZAPI HTTP client"
```

---

### Task 3: Helper de autenticação do webhook por hash de token

**Files:**
- Create: `src/lib/whatsapp/uazapi-webhook-auth.ts`
- Test: `src/lib/whatsapp/uazapi-webhook-auth.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (`createHash`, `timingSafeEqual` — mesmo padrão de `src/lib/api-keys/keys.ts:67,88`)
- Produces: `hashUazapiToken(plaintext: string): string`

- [ ] **Step 1: Escrever o teste**

```typescript
// src/lib/whatsapp/uazapi-webhook-auth.test.ts
import { describe, expect, it } from 'vitest';
import { hashUazapiToken } from './uazapi-webhook-auth';

describe('hashUazapiToken', () => {
  it('is deterministic', () => {
    const a = hashUazapiToken('8cdf0d62-925b-4878-b1e1-70dde3b6590b');
    const b = hashUazapiToken('8cdf0d62-925b-4878-b1e1-70dde3b6590b');
    expect(a).toBe(b);
  });

  it('produces a 64-char hex sha256 digest', () => {
    const hash = hashUazapiToken('tok-123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different tokens hash differently', () => {
    expect(hashUazapiToken('tok-a')).not.toBe(hashUazapiToken('tok-b'));
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run src/lib/whatsapp/uazapi-webhook-auth.test.ts`
Expected: FAIL — `Cannot find module './uazapi-webhook-auth'`

- [ ] **Step 3: Implementar**

```typescript
// src/lib/whatsapp/uazapi-webhook-auth.ts
/**
 * Hashes a UAZAPI instance token for lookup against
 * whatsapp_config.uazapi_instance_token_hash. Same rationale as
 * src/lib/api-keys/keys.ts hashApiKey: the token is full-entropy
 * (UAZAPI-issued UUID), so a fast hash with a UNIQUE index is the
 * correct indexable choice — no KDF needed.
 */
import { createHash } from 'node:crypto';

export function hashUazapiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npx vitest run src/lib/whatsapp/uazapi-webhook-auth.test.ts`
Expected: PASS (3 testes)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/uazapi-webhook-auth.ts src/lib/whatsapp/uazapi-webhook-auth.test.ts
git commit -m "feat(whatsapp): add UAZAPI webhook token hashing helper"
```

---

### Task 4: `send-message.ts` — enviar texto via UAZAPI

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts:339-403` (função `attempt`, dentro de `sendMessageToConversation`)
- Modify: `src/lib/whatsapp/send-message.test.ts`

**Interfaces:**
- Consumes: `sendText` de `./uazapi-client` (Task 2)
- Produces: comportamento inalterado de `sendMessageToConversation` para `messageType === 'text'`; demais tipos (`template`, `image`, `video`, `document`, `audio`, `interactive`) agora lançam `SendMessageError('not_implemented', ..., 501)`.

- [ ] **Step 1: Escrever o teste que cobre o novo caminho de texto e o bloqueio dos demais tipos**

Adicionar ao final de `src/lib/whatsapp/send-message.test.ts` (o arquivo já mocka `@/lib/whatsapp/meta-api` em algum ponto acima — trocar esse mock por `@/lib/whatsapp/uazapi-client`; ver Step 3 para o db mock completo usado pelos testes de sucesso existentes no arquivo, que devem ser adaptados da mesma forma):

```typescript
describe('sendMessageToConversation — UAZAPI text send', () => {
  it('sends text via uazapi-client.sendText and persists the message', async () => {
    const { sendText } = await import('./uazapi-client');
    vi.mocked(sendText).mockResolvedValueOnce({ messageId: 'wamid-uaz-1' });

    const db = makeHappyPathDb(); // helper already present further down this file for the pre-UAZAPI Meta tests — reuse/adapt it to return a whatsapp_config row shaped with `uazapi_instance_token: 'enc:token'` instead of Meta fields

    const result = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Oi cliente',
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Oi cliente' })
    );
    expect(result.whatsappMessageId).toBe('wamid-uaz-1');
  });

  it('rejects template sends with 501 not_implemented', async () => {
    const db = makeHappyPathDb();
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'welcome',
      })
    ).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
  });

  it('rejects media sends with 501 not_implemented', async () => {
    const db = makeHappyPathDb();
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
      })
    ).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
  });
});
```

> Nota para quem implementar: o arquivo `send-message.test.ts` já tem (antes desta seção) um bloco de testes de sucesso do caminho Meta usando um `db` fake construído inline — inspecione esse bloco, extraia a construção do `db` fake para uma função `makeHappyPathDb()` reutilizável no topo do arquivo (conversation + contact + `whatsapp_config` + `messages.insert` + `conversations.update`), e ajuste a linha do `whatsapp_config` mockado para retornar `{ id: 'cfg-1', account_id: 'acct-1', uazapi_instance_token: encrypt('tok-123') }` em vez dos campos Meta. Os testes de sucesso do caminho Meta pré-existentes que exercitam `template`/`image`/`interactive` devem ser **removidos** nesta task (esses tipos agora não são suportados — cobertos pelos dois testes `501` acima).

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Expected: FAIL (módulo `./uazapi-client` sem mock configurado / `sendText` não chamado)

- [ ] **Step 3: Implementar — trocar a função `attempt` e os imports**

Em `src/lib/whatsapp/send-message.ts`, substituir o import de `meta-api` (linhas 24-31) por:

```typescript
import { sendText, UazapiApiError } from '@/lib/whatsapp/uazapi-client';
```

Substituir o corpo da função `attempt` (linhas 339-403 do arquivo original) por:

```typescript
  const attempt = async (phone: string): Promise<string> => {
    if (messageType !== 'text') {
      throw new SendMessageError(
        'not_implemented',
        `Message type "${messageType}" is not yet supported on UAZAPI. Only text messages are supported in this phase.`,
        501
      );
    }
    try {
      const result = await sendText({
        instanceToken: config.uazapi_instance_token
          ? decrypt(config.uazapi_instance_token)
          : (() => {
              throw new SendMessageError(
                'whatsapp_not_configured',
                'UAZAPI instance not configured for this account.',
                400
              );
            })(),
        number: phone,
        text: contentText!,
      });
      return result.messageId;
    } catch (err) {
      if (err instanceof SendMessageError) throw err;
      if (err instanceof UazapiApiError) {
        throw new SendMessageError('uazapi_error', err.message, 502);
      }
      throw err;
    }
  };
```

Também trocar, mais acima na mesma função (linha ~269), a leitura do token criptografado:

```typescript
  const accessToken = decrypt(config.access_token);
```

por remover essa linha e a lógica de auto-heal do `access_token` legado logo abaixo (linhas 269-285 do original) — não se aplica mais ao caminho UAZAPI; `config.uazapi_instance_token` é lido diretamente dentro de `attempt` acima.

E o bloco `try { ... } catch` que envolve as tentativas de variantes de telefone (linhas 405-438) permanece igual — ele já trata qualquer erro lançado por `attempt` de forma genérica via `isRecipientNotAllowedError`. Como a UAZAPI não tem esse conceito de "número não permitido" (sandbox da Meta), o loop de variantes ainda funciona mas sempre usa a primeira tentativa (o `sanitizedPhone` original) — comportamento correto e inofensivo, não requer mudança adicional.

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros novos relacionados a `send-message.ts`

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/send-message.ts src/lib/whatsapp/send-message.test.ts
git commit -m "feat(whatsapp): route text sends through UAZAPI, block other types for now"
```

---

### Task 5: Reescrever o webhook de entrada para texto via UAZAPI

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (reescrita quase completa)
- Modify: `src/app/api/whatsapp/webhook/route.test.ts` (reescrita quase completa)

**Interfaces:**
- Consumes: `hashUazapiToken` (Task 3)
- Produces: `POST` handler que autentica pelo `token` do payload, persiste mensagem de texto, dispara flows/automações/IA/webhooks — mesmo contrato observável que o handler Meta tinha para texto simples.

- [ ] **Step 1: Escrever o novo conteúdo do teste**

Reescrever `src/app/api/whatsapp/webhook/route.test.ts` mantendo a MESMA estrutura de mocks do arquivo atual (o bloco `vi.hoisted` com `h.state`, os mocks de `next/server`, `dispatchInboundToFlows`, `runAutomationsForTrigger`, `dispatchInboundToAiReply`, `dispatchWebhookEvent` já existentes — não recriar do zero, só ajustar o mock de `@supabase/supabase-js`'s tabela `whatsapp_config` para retornar `uazapi_instance_token_hash` em vez de `phone_number_id`, e trocar a construção do corpo da requisição de teste do formato Meta para o formato UAZAPI). Os casos de teste específicos de mídia/status/reação/interativo do arquivo atual devem ser **removidos** (fora de escopo desta fase). Adicionar:

```typescript
import { hashUazapiToken } from '@/lib/whatsapp/uazapi-webhook-auth'

function uazapiTextPayload(overrides?: Partial<{ text: string; senderPn: string; fromMe: boolean }>) {
  return {
    EventType: 'messages',
    token: 'tok-123',
    instanceName: 'BRB WACRM',
    message: {
      chatid: '5519999353218@s.whatsapp.net',
      messageid: 'A5D6F48B790E9AD6A3BD05FF75BCCCC4',
      fromMe: overrides?.fromMe ?? false,
      isGroup: false,
      messageType: 'Conversation',
      type: 'text',
      text: overrides?.text ?? 'Oi',
      messageTimestamp: 1786970871000,
      sender_pn: overrides?.senderPn ?? '5519999353218@s.whatsapp.net',
      senderName: 'BRB Agência Digital',
      wasSentByApi: false,
    },
  }
}

describe('POST /api/whatsapp/webhook — UAZAPI', () => {
  it('accepts a payload whose token hash matches a configured account', async () => {
    h.state.uazapiTokenHash = hashUazapiToken('tok-123')
    const { POST } = await import('./route')
    const response = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify(uazapiTextPayload()) })
    )
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
    const { POST } = await import('./route')
    const response = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify(uazapiTextPayload()) })
    )
    expect(response.init?.status).toBe(401)
  })

  it('ignores events that are echoes of our own API-sent messages', async () => {
    h.state.uazapiTokenHash = hashUazapiToken('tok-123')
    const { POST } = await import('./route')
    await POST(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify(uazapiTextPayload({ fromMe: true })),
      })
    )
    for (const cb of h.state.afterCallbacks) await cb()
    expect(h.state.upsertCalls.length).toBe(0)
  })
})
```

Ajustar o mock de `whatsapp_config` no bloco `vi.mock('@supabase/supabase-js', ...)` para:

```typescript
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: h.state.uazapiTokenHash
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
```

E adicionar `uazapiTokenHash: null as string | null,` ao objeto `h.state` existente.

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run src/app/api/whatsapp/webhook/route.test.ts`
Expected: FAIL — o handler atual não reconhece o payload UAZAPI

- [ ] **Step 3: Reescrever `route.ts`**

Substituir as linhas 1-17 (imports) por:

```typescript
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
```

Manter `maxDuration` e `supabaseAdmin()` (linhas 19-37) inalterados.

Substituir tudo entre a interface `WhatsAppMessage` (linha 39) e o fim de `processMessage`/`parseMessageContent` (linha 1104) — ou seja, remover as interfaces `WhatsAppMessage`/`WhatsAppWebhookEntry`, o handler `GET`, `RECIPIENT_STATUS_LADDER`/`ladderLevel`/`isValidStatusTransition`/`handleStatusUpdate`, `lookupInternalIdByMetaId`, `handleReaction`, `processMessage`, `parseMessageContent` — por:

```typescript
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

  // Skip echoes of messages the app itself sent via the API — those
  // are already persisted at send time (send-message.ts).
  if (body.message.fromMe && body.message.wasSentByApi) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const message = body.message

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
  accountId: string,
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

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

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

  const { error: convError } = await supabaseAdmin().rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || '[text]',
  })
  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  await reopenClosedConversation(supabaseAdmin(), conversation)
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

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

  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: { message_text: contentText, conversation_id: conversation.id },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && contentText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.messageid,
    content_type: 'text',
    text: contentText,
  })
}
```

Manter, sem alteração, as funções `findOrCreateContact` e `findOrCreateConversation` (linhas 1109-1245 do arquivo original) — copiá-las para o final do arquivo reescrito, exatamente como estão, junto com o type `ContactRow`/`ContactOutcome`.

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npx vitest run src/app/api/whatsapp/webhook/route.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros novos

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/webhook/route.ts src/app/api/whatsapp/webhook/route.test.ts
git commit -m "feat(whatsapp): rewrite inbound webhook for UAZAPI text messages"
```

---

### Task 6: Tipo `WhatsAppConfig` — campos UAZAPI

**Files:**
- Modify: `src/types/index.ts:275-296` (interface `WhatsAppConfig`)

**Interfaces:**
- Produces: `WhatsAppConfig.uazapi_instance_token?`, `.uazapi_instance_id?`, `.uazapi_status?`

- [ ] **Step 1: Editar a interface**

Adicionar ao final da interface `WhatsAppConfig` (após o último campo, antes do `}` de fechamento):

```typescript
  /** UAZAPI instance token (encrypted at rest, same mechanism as access_token). */
  uazapi_instance_token?: string;
  uazapi_instance_id?: string;
  uazapi_status?: 'disconnected' | 'connecting' | 'connected';
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(whatsapp): add UAZAPI fields to WhatsAppConfig type"
```

---

### Task 7: Rota de conexão — `GET/POST /api/whatsapp/uazapi/connect`

**Files:**
- Create: `src/app/api/whatsapp/uazapi/connect/route.ts`
- Test: `src/app/api/whatsapp/uazapi/connect/route.test.ts`

**Interfaces:**
- Consumes: `getInstanceStatus`, `connectInstance`, `configureWebhook`, `sendText`-adjacent (Task 2); `requireRole` de `@/lib/auth/account`; `encrypt`/`decrypt` de `./encryption`; `hashUazapiToken` (Task 3)
- Produces:
  - `POST /api/whatsapp/uazapi/connect` — body `{ instance_token: string }`: salva o token (criptografado + hash) em `whatsapp_config` para a conta, chama `configureWebhook`, retorna `{ status, qrcode? }`.
  - `GET /api/whatsapp/uazapi/connect` — retorna o status atual (`GET /instance/status`) para a instância já salva da conta.

- [ ] **Step 1: Escrever os testes**

```typescript
// src/app/api/whatsapp/uazapi/connect/route.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

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
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({ instance_token: 'tok-123' }),
      })
    )

    expect(h.configureWebhook).toHaveBeenCalledWith('tok-123', expect.stringContaining('/api/whatsapp/webhook'))
    expect((response as { body: { qrcode: string } }).body.qrcode).toBe('data:image/png;base64,AAAA')
  })

  it('rejects a missing instance_token with 400', async () => {
    const { POST } = await import('./route')
    const response = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({}) })
    )
    expect((response as { init: { status: number } }).init.status).toBe(400)
  })
})

describe('GET /api/whatsapp/uazapi/connect', () => {
  it('returns the current instance status', async () => {
    h.upsertedRow = { uazapi_instance_token: 'iv:ct:tag' }
    h.getInstanceStatus.mockResolvedValue({
      connected: true, name: 'BRB WACRM', profileName: 'BRB Suporte', owner: '5519987812265',
    })

    const { GET } = await import('./route')
    const response = await GET()
    expect((response as { body: { connected: boolean } }).body.connected).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `npx vitest run src/app/api/whatsapp/uazapi/connect/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implementar a rota**

```typescript
// src/app/api/whatsapp/uazapi/connect/route.ts
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
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `npx vitest run src/app/api/whatsapp/uazapi/connect/route.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/uazapi/connect/route.ts src/app/api/whatsapp/uazapi/connect/route.test.ts
git commit -m "feat(whatsapp): add UAZAPI connect/status API route"
```

---

### Task 8: Tela `Settings → WhatsApp` — fluxo de QR code

**Files:**
- Modify: `src/components/settings/whatsapp-config.tsx` (reescrita completa do componente)

**Interfaces:**
- Consumes: `POST`/`GET /api/whatsapp/uazapi/connect` (Task 7)
- Produces: componente `WhatsAppConfig` com o mesmo nome/export, sem props — mesmo contrato de uso na página de Settings que já o renderiza.

- [ ] **Step 1: Reescrever o componente**

```tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';

type Status = {
  connected: boolean;
  name: string;
  profileName: string;
  owner?: string;
};

export function WhatsAppConfig() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [instanceToken, setInstanceToken] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect');
      const data = await res.json();
      setStatus(data);
    } catch {
      toast.error('Failed to load WhatsApp connection status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll for connection while a QR code is on screen — the user scans
  // it out-of-band, so there's no client-side event to react to.
  useEffect(() => {
    if (!qrcode) return;
    const interval = setInterval(async () => {
      const res = await fetch('/api/whatsapp/uazapi/connect');
      const data = await res.json();
      if (data.connected) {
        setStatus(data);
        setQrcode(null);
        toast.success('WhatsApp connected');
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [qrcode]);

  const handleConnect = async () => {
    if (!instanceToken) {
      toast.error('Instance token is required');
      return;
    }
    setConnecting(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_token: instanceToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect');
        return;
      }
      if (data.connected) {
        setStatus(data);
        toast.success('WhatsApp connected');
      } else if (data.qrcode) {
        setQrcode(data.qrcode);
      }
    } catch {
      toast.error('Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">WhatsApp</CardTitle>
        <CardDescription className="text-muted-foreground">
          Connect a UAZAPI instance to send and receive WhatsApp messages.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status?.connected ? (
          <div className="flex items-center gap-2 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            Connected as {status.profileName || status.name}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <XCircle className="h-4 w-4" />
            Not connected
          </div>
        )}

        {!status?.connected && canEditSettings && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="instance-token" className="text-muted-foreground">
                Instance token
              </Label>
              <Input
                id="instance-token"
                value={instanceToken}
                onChange={(e) => setInstanceToken(e.target.value)}
                placeholder="UAZAPI instance token"
                className="border-border bg-muted text-foreground"
              />
            </div>
            <Button onClick={handleConnect} disabled={connecting} className="w-fit">
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        )}

        {qrcode && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border p-4">
            <p className="text-sm text-muted-foreground">Scan this QR code with WhatsApp</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrcode} alt="WhatsApp QR code" className="h-48 w-48" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: sucesso, sem erros de tipo

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/whatsapp-config.tsx
git commit -m "feat(whatsapp): replace Settings > WhatsApp with UAZAPI QR-code flow"
```

---

### Task 9: Verificação manual ponta a ponta

**Files:** nenhum (verificação, não código)

- [ ] **Step 1: Rodar a suíte completa**

Run: `npm run lint && npx tsc --noEmit && npm run test && npm run build`
Expected: tudo verde

- [ ] **Step 2: Configurar `UAZAPI_SERVER_URL` no `.env.local`**

Adicionar `UAZAPI_SERVER_URL=https://tectonny.uazapi.com` (ou o servidor de produção) ao `.env.local`.

- [ ] **Step 3: Rodar `npm run dev`, ir em Settings → WhatsApp, colar o token da instância dedicada (`BRB WACRM`), confirmar que mostra "Connected"**

Como a instância já está conectada (confirmado nesta sessão), a resposta de `GET /instance/status` deve vir com `connected: true` direto, sem precisar escanear QR code de novo.

- [ ] **Step 4: Mandar uma mensagem de WhatsApp real para o número conectado e confirmar que aparece no Inbox**

- [ ] **Step 5: Responder pelo Inbox e confirmar que chega no WhatsApp do destinatário**

- [ ] **Step 6: Commit final (se algo precisar de ajuste fino descoberto no teste manual)**
