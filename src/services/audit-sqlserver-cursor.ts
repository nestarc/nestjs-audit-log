const INVALID_CURSOR_MESSAGE = '[@nestarc/audit-log] invalid SQL Server cursor.';
const SQLSERVER_ISO_PATTERN = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validTimestamp(value: string): boolean {
  if (!SQLSERVER_ISO_PATTERN.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

/** @internal Keep SQL Server's seven fractional digits out of JavaScript Date cursors. */
export function encodeSqlServerAuditCursor(ts: string, id: string): string {
  const normalizedId = id.toLowerCase();
  if (!validTimestamp(ts) || !UUID_PATTERN.test(normalizedId)) {
    throw new Error(INVALID_CURSOR_MESSAGE);
  }
  return Buffer.from(`mssql1|${ts}|${normalizedId}`, 'utf8').toString('base64url');
}

/** @internal Provider-specific because timestamp precision and UUID ordering differ. */
export function decodeSqlServerAuditCursor(cursor: string): { ts: string; id: string } {
  try {
    if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const payload = Buffer.from(cursor, 'base64url');
    if (payload.toString('base64url') !== cursor) throw new Error();
    const [version, ts, id, extra] = payload.toString('utf8').split('|');
    if (version !== 'mssql1' || extra !== undefined || !validTimestamp(ts) || !UUID_PATTERN.test(id)) {
      throw new Error();
    }
    return { ts, id };
  } catch {
    throw new Error(INVALID_CURSOR_MESSAGE);
  }
}
