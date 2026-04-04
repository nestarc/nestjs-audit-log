export interface AuditEntry {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  actorType: string;
  actorIp: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  source: 'auto' | 'manual';
  changes: Record<string, { before?: unknown; after?: unknown }> | null;
  metadata: Record<string, unknown> | null;
  result: 'success' | 'failure';
  createdAt: Date;
}

export interface AuditQueryOptions {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
}

export interface ManualAuditLogInput {
  action: string;
  targetId?: string;
  targetType?: string;
  metadata?: Record<string, unknown>;
  result?: 'success' | 'failure';
}
