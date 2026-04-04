import {
  computeCreateChanges,
  computeUpdateChanges,
  computeDeleteChanges,
  shouldTrackModel,
} from '../src/prisma/diff';

describe('shouldTrackModel', () => {
  it('returns true when model is in trackedModels whitelist', () => {
    expect(shouldTrackModel('User', ['User', 'Invoice'])).toBe(true);
  });

  it('returns false when model is not in trackedModels whitelist', () => {
    expect(shouldTrackModel('Session', ['User', 'Invoice'])).toBe(false);
  });

  it('returns true when model is not in ignoredModels blacklist', () => {
    expect(shouldTrackModel('User', undefined, ['Session'])).toBe(true);
  });

  it('returns false when model is in ignoredModels blacklist', () => {
    expect(shouldTrackModel('Session', undefined, ['Session'])).toBe(false);
  });

  it('trackedModels takes precedence over ignoredModels', () => {
    expect(shouldTrackModel('User', ['User'], ['User'])).toBe(true);
  });

  it('returns false when neither list is provided', () => {
    expect(shouldTrackModel('User')).toBe(false);
  });

  it('returns false when trackedModels is empty array', () => {
    expect(shouldTrackModel('User', [])).toBe(false);
  });
});

describe('computeCreateChanges', () => {
  it('returns after values for all fields', () => {
    const result = computeCreateChanges(
      { name: 'Alice', email: 'alice@example.com' },
      [],
    );
    expect(result).toEqual({
      name: { after: 'Alice' },
      email: { after: 'alice@example.com' },
    });
  });

  it('redacts sensitive fields', () => {
    const result = computeCreateChanges(
      { name: 'Alice', password: 'secret123' },
      ['password'],
    );
    expect(result).toEqual({
      name: { after: 'Alice' },
      password: { after: '[REDACTED]' },
    });
  });
});

describe('computeUpdateChanges', () => {
  it('returns only changed fields with before/after', () => {
    const result = computeUpdateChanges(
      { name: 'Alice', email: 'old@example.com' },
      { name: 'Alice', email: 'new@example.com' },
      [],
    );
    expect(result).toEqual({
      email: { before: 'old@example.com', after: 'new@example.com' },
    });
  });

  it('returns empty object when nothing changed', () => {
    const result = computeUpdateChanges(
      { name: 'Alice' },
      { name: 'Alice' },
      [],
    );
    expect(result).toEqual({});
  });

  it('redacts sensitive fields in both before and after', () => {
    const result = computeUpdateChanges(
      { password: 'old-hash' },
      { password: 'new-hash' },
      ['password'],
    );
    expect(result).toEqual({
      password: { before: '[REDACTED]', after: '[REDACTED]' },
    });
  });
});

describe('computeDeleteChanges', () => {
  it('returns before values for all fields', () => {
    const result = computeDeleteChanges(
      { name: 'Alice', email: 'alice@example.com' },
      [],
    );
    expect(result).toEqual({
      name: { before: 'Alice' },
      email: { before: 'alice@example.com' },
    });
  });

  it('redacts sensitive fields', () => {
    const result = computeDeleteChanges(
      { name: 'Alice', password: 'secret123' },
      ['password'],
    );
    expect(result).toEqual({
      name: { before: 'Alice' },
      password: { before: '[REDACTED]' },
    });
  });
});
