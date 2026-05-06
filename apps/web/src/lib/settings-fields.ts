/**
 * Settings field catalog — re-exports from `@b1dz/core`.
 *
 * The catalog used to live here; it now lives in `@b1dz/core` so the
 * daemon's per-user env-overlay can derive its `OVERLAY_KEYS` from the
 * same source of truth. See `packages/core/src/settings-fields.ts` for
 * the rationale.
 *
 * Existing `@/lib/settings-fields` imports continue to work via this
 * thin re-export.
 */

export {
  SECRET_FIELDS,
  PLAIN_STRING_FIELDS,
  PLAIN_NUMBER_FIELDS,
  PLAIN_BOOL_FIELDS,
  SECRET_SET,
  PLAIN_STRING_SET,
  PLAIN_NUMBER_SET,
  PLAIN_BOOL_SET,
  sanitizePlain,
  type SecretField,
  type PlainStringField,
  type PlainNumberField,
  type PlainBoolField,
  type PlainPayload,
} from '@b1dz/core';
