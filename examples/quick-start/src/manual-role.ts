import { AuditService } from '@nestarc/audit-log';
import type { Prisma } from './generated/prisma/client';

// The caller owns the ordinary Prisma transaction and must propagate errors.
export async function changeRoleWithEvent(
  tx: Prisma.TransactionClient, audit: AuditService,
  tenantId: string, userId: string, role: 'member' | 'admin',
) {
  const before = await tx.user.findUniqueOrThrow({ where: { id: userId, tenantId } });
  const after = await tx.user.update({ where: { id: userId, tenantId }, data: { role } });
  await audit.log({
    action: 'user.role.changed', targetType: 'User', targetId: userId,
    metadata: { role: { before: before.role, after: after.role } },
  }, tx);
  return { id: after.id, role: after.role };
}
