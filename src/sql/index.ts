import { readFileSync } from 'fs';
import { join } from 'path';

export function getAuditTableSQL(): string {
  return readFileSync(join(__dirname, 'audit-log-schema.sql'), 'utf-8');
}
