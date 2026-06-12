const INVALID_CURSOR_MESSAGE = '[@nestarc/audit-log] invalid cursor.';
const MICRO_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @internal */
export function encodeAuditCursor(createdAtMicroIso: string, id: string): string {
  const normalizedId = id.toLowerCase();
  if (
    !MICRO_ISO_PATTERN.test(createdAtMicroIso) ||
    !UUID_PATTERN.test(normalizedId)
  ) {
    throw new Error(INVALID_CURSOR_MESSAGE);
  }

  return Buffer.from(
    `v1|${createdAtMicroIso}|${normalizedId}`,
    'utf8',
  ).toString('base64url');
}

/** @internal */
export function decodeAuditCursor(cursor: string): { ts: string; id: string } {
  try {
    const payload = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = payload.split('|');
    if (parts.length !== 3) {
      throw new Error(INVALID_CURSOR_MESSAGE);
    }

    const [version, ts, id] = parts;
    const normalizedId = id.toLowerCase();
    if (
      version !== 'v1' ||
      !MICRO_ISO_PATTERN.test(ts) ||
      !UUID_PATTERN.test(normalizedId) ||
      id !== normalizedId
    ) {
      throw new Error(INVALID_CURSOR_MESSAGE);
    }

    return { ts, id: normalizedId };
  } catch {
    throw new Error(INVALID_CURSOR_MESSAGE);
  }
}

/** @internal */
export function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}
