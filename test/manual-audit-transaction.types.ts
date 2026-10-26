import {
  runManualAuditTransaction,
  type ManualAuditTransactionOptions,
} from '../src/services/manual-audit-transaction';
import type { ManualAuditLogInput } from '../src/interfaces/audit-entry.interface';
import type { AuditService } from '../src/services/audit.service';

interface Transaction {
  invoice: {
    update(args: { where: { id: string }; data: { approved: boolean } }): Promise<{ id: string }>;
  };
}

interface OverloadedPrismaClient {
  $transaction<T>(queries: Promise<T>[]): Promise<T[]>;
  $transaction<T>(callback: (tx: Transaction) => Promise<T>, options?: ManualAuditTransactionOptions): Promise<T>;
}

export function manualTransactionTypes(
  client: OverloadedPrismaClient,
  write: (input: ManualAuditLogInput, tx: Transaction) => Promise<void>,
) {
  const result: Promise<string> = runManualAuditTransaction(client, write, async ({ tx, log }) => {
    const invoice = await tx.invoice.update({ where: { id: 'invoice' }, data: { approved: true } });
    await log({ action: 'invoice.approved', targetId: invoice.id });
    // @ts-expect-error Generated transaction model input types are preserved.
    await tx.invoice.update({ where: { missing: true }, data: { approved: true } });
    // @ts-expect-error The transaction exposes no unrelated model.
    await tx.unknownModel.create({});
    // @ts-expect-error The writer is transaction-bound and takes no client argument.
    await log({ action: 'invoice.approved' }, client);
    // @ts-expect-error The result of a model call is not any.
    const wrong: number = invoice.id;
    return invoice.id + wrong;
  }, { timeout: 5_000, isolationLevel: 'Snapshot' });
  // @ts-expect-error A transaction host is required.
  void runManualAuditTransaction({}, write, async () => undefined);
  // @ts-expect-error Isolation levels are checked before database access.
  void runManualAuditTransaction(client, write, async () => undefined, { isolationLevel: 'unknown' });
  return result;
}

export function manualServiceTransactionTypes(audit: AuditService, client: OverloadedPrismaClient) {
  const result: Promise<string> = audit.withManualTransaction(client, async ({ tx, log }) => {
    const invoice = await tx.invoice.update({ where: { id: 'invoice' }, data: { approved: true } });
    await log({ action: 'invoice.approved', targetId: invoice.id });
    // @ts-expect-error Service wiring preserves the generated transaction input type.
    await tx.invoice.update({ where: { wrong: true }, data: { approved: true } });
    // @ts-expect-error A bound writer cannot be redirected to another client.
    await log({ action: 'invoice.approved' }, client);
    // @ts-expect-error Service callback result preserves the model result type.
    const wrong: number = invoice.id;
    return invoice.id + wrong;
  }, { maxWait: 2_000, timeout: 5_000 });
  return result;
}
