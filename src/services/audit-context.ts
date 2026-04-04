import { AsyncLocalStorage } from 'async_hooks';
import { AuditActor } from '../interfaces/actor.interface';

export interface AuditContextStore {
  actor: AuditActor | null;
  noAudit: boolean;
  actionOverride?: string;
  /** @internal Recursion guard for transactional audit extension */
  _auditBypass?: boolean;
}

export class AuditContext {
  private static readonly storage = new AsyncLocalStorage<AuditContextStore>();

  static run<T>(store: AuditContextStore, fn: () => T): T {
    return this.storage.run(store, fn);
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

  static isAuditBypass(): boolean {
    return this.storage.getStore()?._auditBypass ?? false;
  }
}
