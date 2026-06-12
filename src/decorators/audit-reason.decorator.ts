import { SetMetadata } from '@nestjs/common';

export const AUDIT_REASON_KEY = 'AUDIT_REASON';

export const AuditReason = (reason: string) =>
  SetMetadata(AUDIT_REASON_KEY, reason);
