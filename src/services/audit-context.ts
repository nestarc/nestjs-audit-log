import { AsyncLocalStorage } from 'async_hooks';
import { AuditActor } from '../interfaces/actor.interface';

export interface AuditContextStore {
  actor: AuditActor | null;
  noAudit: boolean;
  actionOverride?: string;
  metadata?: Record<string, unknown>;
  reason?: string;
}

export class AuditContext {
  private static readonly storage = new AsyncLocalStorage<AuditContextStore>();

  static run<T>(store: AuditContextStore, fn: () => T): T {
    return this.storage.run(store, fn);
  }

  static runAs<T>(actor: AuditActor, fn: () => T): T {
    return this.run({ actor, noAudit: false }, fn);
  }

  static getStore(): AuditContextStore | undefined {
    return this.storage.getStore();
  }

  static getActor(): AuditActor | null {
    return this.storage.getStore()?.actor ?? null;
  }

  static isNoAudit(): boolean {
    return this.storage.getStore()?.noAudit ?? false;
  }

  static getActionOverride(): string | undefined {
    return this.storage.getStore()?.actionOverride;
  }

  static setMetadata(metadata: Record<string, unknown>): void {
    const store = this.storage.getStore();
    if (!store) return;
    store.metadata = {
      ...(store.metadata ?? {}),
      ...metadata,
    };
  }

  static getMetadata(): Record<string, unknown> | undefined {
    return this.storage.getStore()?.metadata;
  }

  static setReason(reason: string): void {
    const store = this.storage.getStore();
    if (!store) return;
    store.reason = reason;
  }

  static getReason(): string | undefined {
    return this.storage.getStore()?.reason;
  }
}

export function mergeContextMetadata(
  input?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const store = AuditContext.getStore();
  const metadata = {
    ...(store?.metadata ?? {}),
  };

  if (store?.reason !== undefined) {
    metadata.reason = store.reason;
  }

  Object.assign(metadata, input ?? {});

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
