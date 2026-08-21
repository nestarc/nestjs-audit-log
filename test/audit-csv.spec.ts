import {
  AUDIT_CSV_COLUMNS_V1,
  canonicalJson,
  escapeCsvCell,
  serializeAuditCsvEntry,
  serializeAuditCsvHeader,
} from '../src/services/audit-csv';
import { AuditEntry } from '../src/interfaces/audit-entry.interface';

describe('audit CSV v1 serializer', () => {
  it('uses stable versioned columns and RFC 4180 CRLF rows', () => {
    expect(serializeAuditCsvHeader()).toBe(
      `${AUDIT_CSV_COLUMNS_V1.join(',')}\r\n`,
    );
  });

  it('canonicalizes nested JSON keys without changing array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [{ b: 2, a: 1 }] }))
      .toBe('{"a":{"x":3,"y":2},"list":[{"a":1,"b":2}],"z":1}');
  });

  it('escapes quotes, commas, and newlines and blocks Excel formulas', () => {
    expect(escapeCsvCell('hello,"world"\n')).toBe('"hello,""world""\n"');
    expect(escapeCsvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
    expect(escapeCsvCell('  +1')).toBe("'  +1");
  });

  it('serializes nullable values, canonical JSON, and timestamps', () => {
    const entry: AuditEntry = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-1',
      actorId: null,
      actorType: 'system',
      actorIp: null,
      action: '=danger',
      targetType: 'User',
      targetId: null,
      source: 'manual',
      result: 'success',
      changes: { z: { after: 1 }, a: { before: 2 } },
      metadata: null,
      createdAt: new Date('2026-08-21T12:34:56.789Z'),
    };

    expect(serializeAuditCsvEntry(entry)).toBe(
      "v1,11111111-1111-4111-8111-111111111111,tenant-1,,system,,'=danger,User,,manual,success," +
        '"{""a"":{""before"":2},""z"":{""after"":1}}",,2026-08-21T12:34:56.789Z\r\n',
    );
  });
});
