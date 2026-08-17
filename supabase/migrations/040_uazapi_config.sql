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
