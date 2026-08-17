-- ============================================================
-- 041_uazapi_relax_meta_columns.sql
--
-- The UAZAPI connect route (src/app/api/whatsapp/uazapi/connect)
-- creates whatsapp_config rows without Meta-specific fields.
-- Migration 001 made phone_number_id and access_token NOT NULL,
-- which blocked every fresh account from connecting via UAZAPI —
-- there was no Meta config to have set them first.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;
