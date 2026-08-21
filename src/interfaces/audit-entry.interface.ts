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
  actorType?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  source?: 'auto' | 'manual';
  result?: 'success' | 'failure';
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
  tenantId?: string;
  allTenants?: boolean;
  cursor?: string;
  includeTotal?: boolean;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  total?: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AuditGetByIdOptions {
  tenantId?: string;
  allTenants?: boolean;
}

export type AuditExportScope =
  | { tenantId: string; allTenants?: never }
  | { allTenants: true; tenantId?: never };

export type AuditScanOptions = AuditExportScope & {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  batchSize?: number;
  after?: string;
  until?: string;
  signal?: AbortSignal;
};

export interface AuditScanPage {
  entries: AuditEntry[];
  checkpoint: string | null;
  highWatermark: string;
}

export type AuditCsvColumnVersion = 'v1';

export type AuditCsvOptions = AuditScanOptions & {
  columns?: AuditCsvColumnVersion;
  includeBom?: boolean;
};

export interface ManualAuditLogInput {
  action: string;
  targetId?: string;
  targetType?: string;
  metadata?: Record<string, unknown>;
  result?: 'success' | 'failure';
}
