import { createTestPrismaClient, prismaModule, PrismaClient } from './prisma-client';
import { createAuditedClient } from '../../src/prisma/audit-extension';
import { AuditContext } from '../../src/services/audit-context';
import type { PrismaModuleLike } from '../../src/prisma/prisma-namespace';

// Public relation metadata for the three dedicated fixture models. Prisma 7's
// generated namespace may omit DMMF; the fallback case below also covers that lane.
const relationPrismaModule: PrismaModuleLike = {
  Prisma: {
    ...prismaModule.Prisma,
    dmmf: { datamodel: { models: [
      { name: 'AuditGuardRoot', fields: [
        { name: 'id', kind: 'scalar', type: 'String' },
        { name: 'branches', kind: 'object', type: 'AuditGuardBranch' },
      ] },
      { name: 'AuditGuardBranch', fields: [
        { name: 'id', kind: 'scalar', type: 'String' },
        { name: 'rootId', kind: 'scalar', type: 'String' },
        { name: 'root', kind: 'object', type: 'AuditGuardRoot' },
        { name: 'leaves', kind: 'object', type: 'AuditGuardLeaf' },
      ] },
      { name: 'AuditGuardLeaf', fields: [
        { name: 'id', kind: 'scalar', type: 'String' },
        { name: 'branchId', kind: 'scalar', type: 'String' },
        { name: 'branch', kind: 'object', type: 'AuditGuardBranch' },
      ] },
    ] } },
  },
};

describe('nested writes from excluded models E2E', () => {
  let base: PrismaClient;
  let audited: any;

  beforeAll(() => {
    base = createTestPrismaClient();
    audited = createAuditedClient(base, {
      consistency: 'atomic-required',
      trackedModels: ['AuditGuardLeaf'],
      prismaModule: relationPrismaModule,
      logger: { warn: jest.fn(), error: jest.fn() },
    });
  });

  afterEach(async () => {
    await base.auditGuardLeaf.deleteMany({});
    await base.auditGuardBranch.deleteMany({});
    await base.auditGuardRoot.deleteMany({});
  });

  afterAll(async () => { await base.$disconnect(); });

  it.each([false, true])('rejects tracked descendants through excluded models (helper: %s)', async (inHelper) => {
    const mutate = (client: any) => client.auditGuardRoot.create({
      data: { branches: { create: { leaves: { create: {} } } } },
    });

    await expect(inHelper
      ? audited.withAuditTransaction(mutate)
      : mutate(audited),
    ).rejects.toThrow('AuditGuardBranch.leaves');

    expect(await base.auditGuardRoot.count()).toBe(0);
    expect(await base.auditGuardBranch.count()).toBe(0);
    expect(await base.auditGuardLeaf.count()).toBe(0);
  });

  it('rejects nested update and upsert branches without modifying existing rows', async () => {
    const root = await base.auditGuardRoot.create({ data: { branches: { create: {} } }, include: { branches: true } });
    const branch = root.branches[0];
    const update = { branches: { update: { where: { id: branch.id }, data: { leaves: { create: {} } } } } };

    await expect(audited.withAuditTransaction((tx: any) =>
      tx.auditGuardRoot.update({ where: { id: root.id }, data: update }),
    )).rejects.toThrow('AuditGuardBranch.leaves');
    await expect(audited.withAuditTransaction((tx: any) =>
      tx.auditGuardRoot.upsert({ where: { id: root.id }, create: {}, update }),
    )).rejects.toThrow('AuditGuardBranch.leaves');

    expect(await base.auditGuardRoot.count()).toBe(1);
    expect(await base.auditGuardBranch.count()).toBe(1);
    expect(await base.auditGuardLeaf.count()).toBe(0);
  });

  it('permits excluded-only nested writes when public relation metadata is present', async () => {
    await audited.auditGuardRoot.create({ data: { branches: { create: {} } } });
    expect(await base.auditGuardRoot.count()).toBe(1);
    expect(await base.auditGuardBranch.count()).toBe(1);
  });

  it('keeps the intentional NoAudit bypass for nested changes', async () => {
    await AuditContext.run({ actor: null, noAudit: true }, async () =>
      await audited.auditGuardRoot.create({ data: { branches: { create: { leaves: { create: {} } } } } }),
    );
    expect(await base.auditGuardLeaf.count()).toBe(1);
  });

  it('fails conservatively without relation metadata, including on an excluded parent', async () => {
    const withoutMetadata = createAuditedClient(base, {
      consistency: 'atomic-required',
      trackedModels: ['AuditGuardLeaf'],
      prismaModule: { Prisma: { ...prismaModule.Prisma, dmmf: undefined } },
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    await expect(withoutMetadata.auditGuardRoot.create({
      data: { branches: { create: { leaves: { create: {} } } } },
    })).rejects.toThrow('does not support nested writes');
    expect(await base.auditGuardRoot.count()).toBe(0);
  });
});
