import {
  AuditInputError,
  enforceManualMetadataSize,
  validateManualAuditInput,
  validateManualAuditOptions,
  validateManualIdentity,
  validateManualMetadata,
} from '../src/services/manual-audit-validation';

function expectInputError(run: () => void, field: string, code = 'AUDIT_INPUT_INVALID') {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AuditInputError);
    expect(error).toMatchObject({ name: 'AuditInputError', field, code });
    return error as AuditInputError;
  }
  throw new Error('Expected validation to reject the input');
}

describe('manual audit opt-in validation', () => {
  it('preserves strings and allows caller-owned DTO instances', () => {
    class EventDto {
      action = ' invoice.approved ';
      targetType = ' 발주 ';
      targetId = ' 001 ';
      metadata = { note: '승인 완료', units: 3, enabled: true, empty: null };
    }
    const event = new EventDto();
    validateManualAuditInput(event);
    validateManualMetadata(event.metadata);
    expect(event).toMatchObject({ action: ' invoice.approved ', targetId: ' 001 ' });
  });

  it.each([undefined, null, [], 'event', 1])('rejects invalid event shape %p', input => {
    expectInputError(() => validateManualAuditInput(input), 'input');
  });

  it.each([undefined, null, '', ' \t\n', 1, true])('rejects invalid action %p', action => {
    expectInputError(() => validateManualAuditInput({ action }), 'action');
  });

  it.each(['targetId', 'targetType'])('requires a nonblank %s when provided', field => {
    for (const value of ['', '  ', null, 3]) {
      expectInputError(() => validateManualAuditInput({ action: 'event', [field]: value }), field);
    }
    expect(() => validateManualAuditInput({ action: 'event', [field]: undefined })).not.toThrow();
  });

  it('validates result and metadata shape without demanding metadata', () => {
    for (const result of ['success', 'failure', undefined]) {
      expect(() => validateManualAuditInput({ action: 'event', result })).not.toThrow();
    }
    for (const result of ['', 'SUCCESS', null, 1]) {
      expectInputError(() => validateManualAuditInput({ action: 'event', result }), 'result');
    }
    for (const metadata of [null, [], new Date(), new Map(), 'private-value']) {
      const error = expectInputError(() => validateManualAuditInput({ action: 'event', metadata }), 'metadata');
      expect(error.message).not.toContain('private-value');
    }
    expect(() => validateManualAuditInput({ action: 'event', metadata: Object.create(null) })).not.toThrow();
  });

  it('makes actor and tenant validation explicit without changing optional null identities', () => {
    expect(() => validateManualIdentity(null, 'tenantId')).not.toThrow();
    expect(() => validateManualIdentity(undefined, 'actor.id')).not.toThrow();
    expect(() => validateManualIdentity(' actor ', 'actor.id', true)).not.toThrow();
    for (const value of [null, undefined, '  ', '', 42]) {
      expectInputError(() => validateManualIdentity(value, 'actor.id', true), 'actor.id');
    }
    expectInputError(() => validateManualIdentity(' \n', 'tenantId'), 'tenantId');
  });

  it('validates option types and safe positive byte budgets', () => {
    for (const options of [{}, { strictManualValidation: false }, { strictManualValidation: true, maxMetadataBytes: 1 }]) {
      expect(() => validateManualAuditOptions(options)).not.toThrow();
    }
    for (const strictManualValidation of [null, 'true', 1]) {
      expectInputError(() => validateManualAuditOptions({ strictManualValidation } as any), 'strictManualValidation');
    }
    for (const maxMetadataBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null]) {
      expectInputError(() => validateManualAuditOptions({ maxMetadataBytes } as any), 'maxMetadataBytes');
    }
  });
});

describe('strict metadata evidence', () => {
  it.each([undefined, () => undefined, Symbol('secret'), 1n, NaN, Infinity, -Infinity])(
    'rejects lossy nested values with a field path (%p)', value => {
      const error = expectInputError(() => validateManualMetadata({ entries: [{ value }] }), 'metadata.entries[0].value');
      expect(error.message).not.toContain('secret');
    },
  );

  it('escapes unusual field names in paths', () => {
    const expectedPath = `metadata[${JSON.stringify('a.b')}][${JSON.stringify('quote"')}]`;
    expectInputError(() => validateManualMetadata({ 'a.b': { 'quote"': 1n } }), expectedPath);
  });

  it('allows shared references but rejects ancestor cycles before recursive redaction', () => {
    const shared = { value: 'stored once per path' };
    expect(() => validateManualMetadata({ a: shared, b: shared })).not.toThrow();
    const circular: Record<string, unknown> = { value: 'sensitive-content' };
    circular.child = { parent: circular };
    const error = expectInputError(() => validateManualMetadata(circular), 'metadata.child.parent');
    expect(error.message).not.toContain('sensitive-content');
    const array: unknown[] = [];
    array.push(array);
    expectInputError(() => validateManualMetadata(array), 'metadata[0]');
  });

  it('allows valid Dates and rejects dates or objects that serialize unpredictably', () => {
    expect(() => validateManualMetadata({ at: new Date('2026-10-26T12:00:00Z') })).not.toThrow();
    for (const at of [new Date('invalid'), Object.assign(new Date(), { toJSON: () => 'altered' }), new Map(), /pattern/]) {
      expectInputError(() => validateManualMetadata({ at }), 'metadata.at');
    }
  });

  it('rejects accessors without executing them and rejects omitted properties', () => {
    const getter = jest.fn(() => 'secret-value');
    const accessor = Object.defineProperty({}, 'token', { enumerable: true, get: getter });
    expectInputError(() => validateManualMetadata(accessor), 'metadata.token');
    expect(getter).not.toHaveBeenCalled();
    expectInputError(() => validateManualMetadata({ [Symbol('private')]: 'secret' }), 'metadata');
    const hidden = Object.defineProperty({}, 'hidden', { value: 'secret' });
    expectInputError(() => validateManualMetadata(hidden), 'metadata.hidden');
    const array = Object.assign(['value'], { extra: 'secret' });
    expectInputError(() => validateManualMetadata(array), 'metadata');
    expectInputError(() => validateManualMetadata(new Array(1)), 'metadata[0]');
  });

  it('limits recursion depth while accepting the documented boundary', () => {
    let value: unknown = 'leaf';
    for (let index = 0; index < 64; index++) value = { next: value };
    expect(() => validateManualMetadata(value)).not.toThrow();
    expectInputError(() => validateManualMetadata({ next: value }), `metadata${'.next'.repeat(65)}`);
  });

  it('measures final redacted JSON in UTF-8 bytes without truncation', () => {
    const json = JSON.stringify({ note: '한😀' });
    const bytes = Buffer.byteLength(json, 'utf8');
    expect(bytes).toBeGreaterThan(json.length);
    expect(() => enforceManualMetadataSize(json, bytes)).not.toThrow();
    const error = expectInputError(() => enforceManualMetadataSize(json, bytes - 1), 'metadata', 'AUDIT_METADATA_TOO_LARGE');
    expect(error.message).not.toContain('한😀');
    expect(() => enforceManualMetadataSize(json)).not.toThrow();
    expect(() => enforceManualMetadataSize(null, 1)).not.toThrow();
    expect(json).toBe('{"note":"한😀"}');
  });
});
