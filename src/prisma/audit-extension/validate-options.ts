import type { AuditExtensionOptions } from './audit-types';

const EXPERIMENTAL_TX_AUDIT_REMOVED_ERROR =
  '[@nestarc/audit-log] experimentalTxAudit was removed in v0.5.0; use consistency: "atomic-required" with withAuditTransaction(), or remove experimentalTxAudit and keep explicit consistency: "best-effort"';

/** Validate options without resolving Prisma or creating an extension. */
export function validateAuditExtensionOptions(options: AuditExtensionOptions): void {
  if (Object.prototype.hasOwnProperty.call(options, 'experimentalTxAudit')) {
    throw new Error(EXPERIMENTAL_TX_AUDIT_REMOVED_ERROR);
  }
  if (
    options.consistency !== 'atomic-required' &&
    options.consistency !== 'best-effort'
  ) {
    throw new Error(
      '[@nestarc/audit-log] consistency must be explicitly set to "atomic-required" or "best-effort"',
    );
  }
  if (
    options.maxBatchRecords !== undefined &&
    (!Number.isInteger(options.maxBatchRecords) || options.maxBatchRecords < 1)
  ) {
    throw new Error(
      '[@nestarc/audit-log] maxBatchRecords must be a positive integer',
    );
  }
  if (
    options.batchOverflow !== undefined &&
    options.batchOverflow !== 'reject' &&
    options.batchOverflow !== 'summary'
  ) {
    throw new Error(
      '[@nestarc/audit-log] batchOverflow must be "reject" or "summary"',
    );
  }
  if (
    options.consistency === 'atomic-required' &&
    options.batchOverflow === 'summary'
  ) {
    throw new Error(
      '[@nestarc/audit-log] batchOverflow: "summary" is only available in best-effort mode',
    );
  }
}
