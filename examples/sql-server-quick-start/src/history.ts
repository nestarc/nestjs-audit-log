import type { PrismaClient } from './generated/prisma/client';

export interface DemoPrincipal {
  id: string;
  tenantIds: readonly string[];
  permissions: readonly string[];
}

export interface HistoryEntry {
  id: string;
  tenantId: string;
  actorId: string;
  action: string;
  targetId: string;
  source: string;
  metadata: string | null;
}

// This example deliberately demonstrates an application-owned read.
// In 0.8.0, AuditService.query() is also available for SQL Server history and cursor pagination.
// Obtain the principal from trusted authentication and membership data in a real application.
export async function readInvoiceHistory(
  base: PrismaClient, principal: DemoPrincipal, tenantId: string, invoiceId: string,
): Promise<HistoryEntry[]> {
  if (!principal.permissions.includes('audit:read') || !principal.tenantIds.includes(tenantId)) {
    throw new Error('AUDIT_READ_FORBIDDEN');
  }
  return base.$queryRaw<HistoryEntry[]>`
    SELECT TOP (50) CONVERT(NVARCHAR(36), [id]) AS [id], [tenant_id] AS [tenantId],
      [actor_id] AS [actorId], [action], [target_id] AS [targetId], [source], [metadata]
    FROM [dbo].[audit_demo_logs]
    WHERE [tenant_id] = ${tenantId} AND [target_type] = ${'Invoice'} AND [target_id] = ${invoiceId}
    ORDER BY [created_at] DESC, [id] DESC
  `;
}
