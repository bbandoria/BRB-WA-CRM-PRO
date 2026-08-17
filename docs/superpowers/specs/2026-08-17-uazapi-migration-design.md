# Migração da integração WhatsApp: Meta Cloud API → UAZAPI

## Contexto e motivação

O wacrm foi construído sobre a API oficial do WhatsApp Business (Meta Cloud
API). O operador deste deployment não pode usar a API oficial e já opera
UAZAPI (`https://tectonny.uazapi.com`, produto "uazapiGO V2") — uma API
não-oficial baseada em WhatsApp Web (protocolo Baileys), com instâncias
pareadas por QR code e sem exigência de templates de mensagem aprovados.

Decisão: **substituição completa**. A Meta deixa de ser suportada; não há
camada de abstração multi-provedor (YAGNI — não existe hoje um segundo
cliente que precise da Meta).

## Descobertas técnicas (validadas contra a instância real do operador)

- Autenticação: header `token: <instance_token>` por instância em endpoints
  regulares; `admintoken` só para endpoints administrativos (criação de
  instância), que este projeto não usa — a instância é criada manualmente
  pelo operador no painel da UAZAPI.
- Estados de instância: `disconnected`, `connecting`, `connected`,
  `hibernated`.
- `GET /instance/status` (header `token`) retorna, entre outros campos:
  `status.connected` (bool), `status.jid`, `instance.name`,
  `instance.profileName`, `instance.profilePicUrl`, `instance.qrcode`,
  `instance.paircode`.
- `GET /webhook` e `POST /webhook` (header `token`) — uma instância pode ter
  **múltiplos webhooks simultâneos** (array), cada um com `url`, `events`,
  `excludeMessages`, `enabled`. Isso importa porque a instância de teste do
  operador já tinha dois webhooks de outros sistemas cadastrados — a
  instância dedicada ao wacrm evita esse compartilhamento por completo.
- Sem assinatura HMAC no payload do webhook (diferente da Meta). **Confirmado
  contra uma instância real**: o próprio `token` da instância vem incluído no
  corpo de todo evento de webhook (campo raiz `token`), então a autenticação
  do endpoint é feita comparando esse valor com `uazapi_instance_token`
  salvo em `whatsapp_config` — não é necessário um `secret` separado na
  query string.
- Envio de mensagens: endpoints em `POST /send/text`, `POST /send/media`,
  além de contato (vCard), localização, presença, status/stories, menu
  interativo, carrossel, solicitação de localização/pagamento, botão PIX.
  Campos opcionais comuns a todos: `delay`, `readchat`, `readmessages`,
  `replyid`, `viewOnce`, `mentions` (grupos), `forward`, `track_source`,
  `track_id`, `async`.
- Números: E.164 sem `+` (ex.: `5511999999999`), igual ao formato já usado
  pelo `phone-utils.ts` existente. Grupos usam `<id>@g.us`.
- Sem restrição de janela de 24h / templates aprovados — mensagem livre a
  qualquer momento.
- Limites: 429 ao exceder o número máximo de instâncias conectadas no
  servidor; erros de volume/qualidade do WhatsApp vêm com
  `error_source: "whatsapp_server"`, `provider_code: 463` e um endpoint de
  diagnóstico, `GET /instance/wa_messages_limits`.
- **Payload real do webhook de mensagem recebida (evento `messages`),
  confirmado contra a instância dedicada do wacrm (`BRB WACRM`,
  token `8cdf0d62-925b-4878-b1e1-70dde3b6590b`)**:

  ```json
  {
    "BaseUrl": "https://tectonny.uazapi.com",
    "EventType": "messages",
    "instanceName": "BRB WACRM",
    "token": "8cdf0d62-925b-4878-b1e1-70dde3b6590b",
    "owner": "5519987812265",
    "chatSource": "updated",
    "chat": {
      "id": "r1690469d782116",
      "wa_chatid": "5519999353218@s.whatsapp.net",
      "wa_contactName": "BRB AGÊNCIA DIGITAL",
      "wa_name": "BRB Marketing Digital",
      "phone": "5519999353218",
      "wa_isGroup": false,
      "imagePreview": "https://pps.whatsapp.net/...",
      "lead_name": "", "lead_email": "", "lead_status": "",
      "...": "demais campos lead_* / wa_* usados pelo CRM nativo da UAZAPI — ignorados pelo wacrm"
    },
    "message": {
      "chatid": "5519999353218@s.whatsapp.net",
      "messageid": "A5D6F48B790E9AD6A3BD05FF75BCCCC4",
      "id": "5519987812265:A5D6F48B790E9AD6A3BD05FF75BCCCC4",
      "fromMe": false,
      "isGroup": false,
      "messageType": "Conversation",
      "type": "text",
      "text": "Oi",
      "content": "Oi",
      "mediaType": "",
      "messageTimestamp": 1786970871000,
      "sender": "233105390600345@lid",
      "sender_pn": "5519999353218@s.whatsapp.net",
      "senderName": "BRB Marketing Digital",
      "source": "android",
      "wasSentByApi": false
    }
  }
  ```

  Pontos relevantes para o parser:
  - Autenticação: `token` (raiz) contra `whatsapp_config.uazapi_instance_token`.
  - Grupos: `message.isGroup: true`, `message.chatid` termina em `@g.us`.
  - **`sender` usa o esquema `@lid` (ID ofuscado, privacidade do WhatsApp) —
    não é o número de telefone.** Para casar/criar contato por telefone,
    usar `message.sender_pn` (formato `<E.164>@s.whatsapp.net`) ou
    `message.chatid` em conversas 1:1; em grupos, `sender_pn` identifica o
    autor real dentro do grupo.
  - `message.fromMe: true` e `message.wasSentByApi: true` identificam eco de
    mensagens enviadas pela própria API (evita duplicar no Inbox mensagens
    que o wacrm mesmo acabou de mandar).
  - Mídia: `message.mediaType` e `message.messageType` variam por tipo
    (texto observado é `"Conversation"`); schema de mídia a confirmar
    quando a automação de mídia for implementada (não bloqueia o texto).

- **Resposta real de `POST /send/text`**, confirmada com envio real
  (`{"number": "5519999353218", "text": "Teste wacrm, ignore"}`):

  ```json
  {
    "chatid": "5519999353218@s.whatsapp.net",
    "id": "5519987812265:3EB0FC09FB42475624D4A0",
    "messageid": "3EB0FC09FB42475624D4A0",
    "messageType": "ExtendedTextMessage",
    "messageTimestamp": 1786971096656,
    "status": "Pending",
    "text": "Teste wacrm, ignore",
    "fromMe": true,
    "sender": "5519987812265@s.whatsapp.net",
    "senderName": "BRB Marketing Digital Suporte"
  }
  ```

  `messageid` é o identificador a persistir como `wamid`-equivalente
  (mesmo papel que o `wamid` da Meta tinha na tabela de mensagens/broadcast).

- **Confirmado**: `POST /webhook` **substitui** a lista de webhooks da
  instância (não é aditivo) — ao chamar para registrar o webhook do wacrm,
  qualquer outro webhook previamente configurado na mesma instância é
  perdido. Reforça a decisão de usar sempre uma instância dedicada por
  conta (nunca compartilhada) para essa integração.

## Escopo

### Dentro do escopo
- Nova camada de cliente UAZAPI substituindo o cliente Meta.
- Reescrita do endpoint de webhook para o formato de payload da UAZAPI e
  para o esquema de segurança por `secret` na URL.
- Reescrita da tela `Settings → WhatsApp` para o fluxo de QR code.
- Atualização de todos os pontos que hoje enviam mensagem via Meta
  (automações, resposta automática de IA, broadcasts, rotas de API) para
  usar o client novo, mantendo as mesmas assinaturas de função nos call
  sites onde possível.
- Remoção da feature de Message Templates (tela, rotas, componentes,
  lógica de submissão/sincronização com a Meta). Quick Replies passa a ser
  o único mecanismo de texto salvo, inclusive para broadcasts.
- Migração de banco aditiva (`040_uazapi_config.sql`) que adiciona colunas
  novas em `whatsapp_config` sem remover as antigas.

### Fora do escopo
- Suporte simultâneo a Meta e UAZAPI (nenhuma camada de abstração
  multi-provedor).
- Migração/remoção das tabelas de template no banco (ficam intocadas,
  apenas deixam de ser usadas pelo código).
- Tradução da UI para PT-BR (tratado à parte).
- Qualquer mudança na instância UAZAPI compartilhada já existente
  (`BRB SUPORTE TESTE`) — o wacrm usa uma instância própria e dedicada.

## Arquitetura

### Configuração
- Nova env var de nível de aplicação: `UAZAPI_SERVER_URL` (servidor UAZAPI
  compartilhado por todas as contas do deployment, ex.:
  `https://tectonny.uazapi.com`).
- Cada conta (`account_id`) mantém, em `whatsapp_config`, seu próprio
  `uazapi_instance_token` (criptografado como hoje é feito com
  `access_token`) e um `webhook_secret` gerado automaticamente por conta.

### Migração de banco — `supabase/migrations/040_uazapi_config.sql`
Adiciona a `whatsapp_config`:
- `uazapi_instance_token TEXT` (armazenado criptografado via
  `src/lib/whatsapp/encryption.ts`, reaproveitando o mecanismo existente —
  usado para chamadas de saída à UAZAPI)
- `uazapi_instance_token_hash TEXT UNIQUE` (SHA-256 do token em texto
  puro). A criptografia AES-256-GCM usada em `encryption.ts` é não
  determinística (IV aleatório por chamada), então não dá para buscar uma
  linha por igualdade no valor criptografado. O webhook da UAZAPI manda o
  token em texto puro no corpo do evento (ver "Webhook de entrada"), então
  a conta é resolvida com `WHERE uazapi_instance_token_hash = sha256(token
  recebido)` — mesmo padrão já usado pela API pública (`api_keys`,
  ver `docs/public-api.md`) para não guardar segredos pesquisáveis em texto
  puro.
- `uazapi_instance_id TEXT NULL`

Colunas específicas da Meta (`phone_number_id`, `waba_id`, `access_token`,
`verify_token`, campos de registro) permanecem no schema, agora não-lidas
pelo código novo. Nenhuma migração destrutiva.

### Cliente UAZAPI — `src/lib/whatsapp/uazapi-client.ts`
Substitui `meta-api.ts`. Funções:
- `getInstanceStatus(instanceToken)` → `GET /instance/status`
- `connectInstance(instanceToken)` → inicia conexão / retorna QR code
- `configureWebhook(instanceToken, url)` → `POST /webhook`
- `sendText(instanceToken, number, text, opts)` → `POST /send/text`
- `sendMedia(instanceToken, number, media, opts)` → `POST /send/media`

`src/lib/whatsapp/send-message.ts` passa a delegar para este client,
preservando a assinatura já consumida pelos call sites (inbox, broadcasts,
automações, IA) — troca de motor, não de interface pública.

`phone-utils.ts` é reaproveitado sem mudanças (mesmo formato E.164).

### Webhook de entrada — `src/app/api/whatsapp/webhook/route.ts`
- URL registrada na UAZAPI é única para toda a aplicação (não por conta):
  `https://<site>/api/whatsapp/webhook`.
- O handler identifica a conta pelo campo raiz `token` do payload (ver
  schema confirmado acima): calcula `sha256(token)` e busca a linha em
  `whatsapp_config` por `uazapi_instance_token_hash`, com
  `timingSafeEqual` na comparação (mesmo padrão de `src/lib/api-keys/keys.ts`).
  Isso substitui a validação HMAC (`webhook-signature.ts`, removido) usada
  com a Meta.
- Parser lê `message.{chatid,messageid,fromMe,isGroup,text,messageType,
  messageTimestamp,sender_pn,wasSentByApi}` do payload confirmado acima.
  Mensagens com `wasSentByApi: true` e `fromMe: true` são ignoradas (eco de
  envio feito pelo próprio wacrm, já persistido no momento do envio).
- Registro do webhook é automático: ao salvar a instância em
  Settings → WhatsApp, o app chama `configureWebhook(...)` apontando para
  essa URL única — o operador não mexe na UAZAPI manualmente além de
  escanear o QR code.

### `Settings → WhatsApp` (`whatsapp-config.tsx`, reescrito)
- Remove campos: Phone Number ID, WABA ID, Access Token, Verify Token, PIN.
- Novo fluxo: usuário cola o `instance_token` da instância dedicada →
  `GET /instance/status`; se desconectado, inicia conexão e exibe QR code
  → polling até `connected: true` → exibe nome/número conectado → registra
  webhook automaticamente.

### Remoção da feature de Templates
Removidos: tela de Templates, `/api/whatsapp/templates/*`,
`template-manager.tsx`, `template-picker.tsx` (inbox),
`registration.ts`, rota `verify-registration`, `template-body.ts`,
`template-webhook.ts`.

`step1-choose-template.tsx` (broadcasts) passa a selecionar uma Quick
Reply; broadcast envia texto livre, sem restrição de janela de 24h.

### Call sites atualizados para o novo client
- `src/lib/automations/meta-send.ts` → `uazapi-send.ts`
- `src/lib/ai/auto-reply.ts`
- `src/lib/whatsapp/broadcast-core.ts` / `broadcast-resume.ts`
- Rotas `/api/whatsapp/send`, `/api/whatsapp/react`, `/api/whatsapp/broadcast`

## Erros e limites
- 429 do servidor UAZAPI (limite de instâncias conectadas) — mensagem
  amigável na tela de conexão.
- Erros de volume/qualidade do WhatsApp (`provider_code: 463`) — mensagem
  amigável em broadcasts/envio, com referência ao endpoint de diagnóstico
  `GET /instance/wa_messages_limits`.
- Mantido o espaçamento entre mensagens em disparos em massa (broadcasts /
  automações), agora usando os parâmetros nativos da UAZAPI (`delay`,
  observados também como `msg_delay_min`/`msg_delay_max` na instância).

## Testes
- Reescrever os testes unitários que hoje mockam `meta-api.ts`
  (`send-message.test.ts`, `broadcast-core.test.ts`,
  `broadcast-resume.test.ts`, `resolve-conversation.test.ts`, etc.) para o
  client UAZAPI.
- Remover testes específicos de template (`template-body.test.ts`,
  `template-webhook.test.ts`).
- Teste de integração manual: conectar a instância dedicada via QR code,
  enviar e receber uma mensagem real, confirmar que aparece na Inbox —
  feito em conjunto com o operador durante a implementação.

## Pendências a resolver durante a implementação
1. Schema de `POST /send/media` (imagem/vídeo/áudio/documento) ainda não
   testado contra a instância real — apenas texto foi validado. Confirmar
   antes de implementar envio de mídia.
2. Instância dedicada de teste (`BRB WACRM`, id `rb633397c65fbb1`) está
   conectada com o mesmo número que a instância compartilhada
   (`5519987812265`) — decisão intencional do operador para este ambiente
   de teste. Cada nova conta do wacrm em produção deve, idealmente, ter um
   número próprio, mas a arquitetura não impõe isso.
