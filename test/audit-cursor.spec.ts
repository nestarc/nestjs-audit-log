import {
  decodeAuditCursor,
  encodeAuditCursor,
  escapeLikePattern,
} from '../src/services/audit-cursor';

describe('audit cursor helpers', () => {
  const ts = '2026-06-11T03:14:15.926535Z';
  const id = '11111111-1111-4111-8111-111111111111';

  it('round-trips a v1 cursor as unpadded base64url', () => {
    const cursor = encodeAuditCursor(ts, id);

    expect(cursor).not.toContain('=');
    expect(decodeAuditCursor(cursor)).toEqual({ ts, id });
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toBe(
      `v1|${ts}|${id}`,
    );
  });

  it('rejects invalid cursor payloads with a stable message', () => {
    const invalidPayloads = [
      'not a valid cursor',
      Buffer.from(`v1|${ts}`, 'utf8').toString('base64url'),
      Buffer.from(`v2|${ts}|${id}`, 'utf8').toString('base64url'),
      Buffer.from(
        `v1|2026-06-11T03:14:15.926Z|${id}`,
        'utf8',
      ).toString('base64url'),
      Buffer.from(`${ts}|not-a-uuid`, 'utf8').toString('base64url'),
    ];

    for (const cursor of invalidPayloads) {
      expect(() => decodeAuditCursor(cursor)).toThrow(
        '[@nestarc/audit-log] invalid cursor.',
      );
    }
  });

  it('escapes LIKE pattern literals before wildcard conversion', () => {
    expect(escapeLikePattern('\\%_')).toBe('\\\\\\%\\_');
    expect(escapeLikePattern('discount_50.%')).toBe('discount\\_50.\\%');
  });
});
