describe('resolvePrismaNamespace', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@prisma/client');
  });

  it('preserves the original require failure as the error cause', () => {
    const cause = new Error('generated client missing');

    jest.isolateModules(() => {
      jest.doMock('@prisma/client', () => {
        throw cause;
      });

      const { resolvePrismaNamespace } = require('../src/prisma/prisma-namespace');

      expect(() => resolvePrismaNamespace({})).toThrow(
        'Could not load @prisma/client',
      );
      try {
        resolvePrismaNamespace({});
      } catch (error) {
        expect((error as Error & { cause?: unknown }).cause).toBe(cause);
      }
    });
  });
});
