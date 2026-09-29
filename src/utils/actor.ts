import type { AuditActor } from '../interfaces/actor.interface';

/** Copy before validating so later context mutations cannot change stored identity. */
export function snapshotAuditActor(
  actor: AuditActor | null,
  required = false,
): AuditActor | null {
  const snapshot = actor ? { ...actor } : null;
  if (required && (
    typeof snapshot?.id !== 'string' || snapshot.id.trim().length === 0
  )) {
    throw new Error(
      '[@nestarc/audit-log] actorRequired requires an actor with a non-blank string ID; ' +
        'provide an authenticated actor or use AuditContext.runAs(actor, callback)',
    );
  }
  return snapshot;
}
