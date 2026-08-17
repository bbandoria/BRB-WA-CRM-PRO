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
