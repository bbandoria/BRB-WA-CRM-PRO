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
- Sem assinatura HMAC no payload do webhook (diferente da Meta). O padrão
  observado no ambiente do operador para proteger o endpoint é um `secret`
  na própria query string da URL do webhook.
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
- **Payload exato do webhook de mensagem recebida (evento `messages`) e o
  schema de resposta de `POST /send/text` ainda não foram confirmados** —
  a documentação pública é uma SPA que não expõe o schema em texto simples.
  Serão validados com uma chamada real contra a instância dedicada do
  wacrm assim que ela existir, antes de finalizar o parser do webhook.

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
  `src/lib/whatsapp/encryption.ts`, reaproveitando o mecanismo existente)
- `uazapi_instance_id TEXT NULL`
- `webhook_secret TEXT` (gerado no momento em que a conta salva a
  instância)

Colunas específicas da Meta (`phone_number_id`, `waba_id`, `access_token`,
`verify_token`, campos de registro) permanecem no schema, agora não-lidas
pelo código novo. Nenhuma migração destrutiva.

### Cliente UAZAPI — `src/lib/whatsapp/uazapi-client.ts`
Substitui `meta-api.ts`. Funções:
- `getInstanceStatus(instanceToken)` → `GET /instance/status`
- `connectInstance(instanceToken)` → inicia conexão / retorna QR code
- `configureWebhook(instanceToken, url, secret)` → `POST /webhook`
- `sendText(instanceToken, number, text, opts)` → `POST /send/text`
- `sendMedia(instanceToken, number, media, opts)` → `POST /send/media`

`src/lib/whatsapp/send-message.ts` passa a delegar para este client,
preservando a assinatura já consumida pelos call sites (inbox, broadcasts,
automações, IA) — troca de motor, não de interface pública.

`phone-utils.ts` é reaproveitado sem mudanças (mesmo formato E.164).

### Webhook de entrada — `src/app/api/whatsapp/webhook/route.ts`
- URL registrada na UAZAPI por conta:
  `https://<site>/api/whatsapp/webhook?secret=<webhook_secret-da-conta>`
- O handler identifica a conta pelo `secret` da query string (lookup em
  `whatsapp_config`), substituindo a validação HMAC (`webhook-signature.ts`,
  removido) usada com a Meta.
- Parser reescrito para o formato de evento `messages` da UAZAPI (schema
  exato a confirmar contra a instância dedicada antes de finalizar).
- Registro do webhook é automático: ao salvar a instância em
  Settings → WhatsApp, o app chama `configureWebhook(...)` — o operador
  não mexe na UAZAPI manualmente além de escanear o QR code.

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
1. Confirmar schema exato do payload do evento `messages` do webhook e da
   resposta de `POST /send/text` / `POST /send/media`, testando contra a
   instância dedicada assim que criada.
2. Confirmar se `POST /webhook` da UAZAPI adiciona uma nova entrada à lista
   ou substitui a existente (relevante para não quebrar outros webhooks
   caso a instância venha a ser reaproveitada no futuro — não é o caso da
   instância dedicada, mas vale confirmar o comportamento da API).
