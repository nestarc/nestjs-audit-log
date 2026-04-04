import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION_KEY = 'AUDIT_ACTION';
export const AuditAction = (action: string) =>
  SetMetadata(AUDIT_ACTION_KEY, action);
