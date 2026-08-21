import { PrismaModuleLike } from '../prisma/prisma-namespace';
import { resolvePrismaNamespace } from '../prisma/prisma-namespace';
import { validateAuditTableName } from '../sql/table-name';
import {
  AuditStreamCheckpointStore,
  AuditStreamDeadLetter,
  AuditStreamDeadLetterStore,
  AuditStreamState,
} from './audit-stream';

export interface PostgresAuditStreamStoreOptions {
  prisma: any;
  prismaModule?: PrismaModuleLike;
  checkpointTable?: string;
  deadLetterTable?: string;
}

export interface AuditStreamStoreSQLOptions {
  checkpointTable?: string;
  deadLetterTable?: string;
}

export class PostgresAuditStreamStore
  implements AuditStreamCheckpointStore, AuditStreamDeadLetterStore
{
  private readonly Prisma: ReturnType<typeof resolvePrismaNamespace>;
  private readonly checkpointTable: unknown;
  private readonly deadLetterTable: unknown;

  constructor(private readonly options: PostgresAuditStreamStoreOptions) {
    this.Prisma = resolvePrismaNamespace({ prismaModule: options.prismaModule });
    this.checkpointTable = this.Prisma.raw!(
      validateAuditTableName(options.checkpointTable ?? 'audit_log_stream_checkpoints'),
    );
    this.deadLetterTable = this.Prisma.raw!(
      validateAuditTableName(options.deadLetterTable ?? 'audit_log_stream_dead_letters'),
    );
  }

  async load(streamId: string): Promise<AuditStreamState | null> {
    const rows = await this.options.prisma.$queryRaw(
      this.Prisma.sql!`
        SELECT checkpoint, high_watermark AS "highWatermark"
        FROM ${this.checkpointTable}
        WHERE stream_id = ${streamId}
      `,
    ) as AuditStreamState[];
    return rows[0] ?? null;
  }

  async save(streamId: string, state: AuditStreamState): Promise<void> {
    await this.options.prisma.$executeRaw(
      this.Prisma.sql!`
        INSERT INTO ${this.checkpointTable}
          (stream_id, checkpoint, high_watermark, updated_at)
        VALUES (${streamId}, ${state.checkpoint}, ${state.highWatermark}, now())
        ON CONFLICT (stream_id) DO UPDATE SET
          checkpoint = EXCLUDED.checkpoint,
          high_watermark = EXCLUDED.high_watermark,
          updated_at = now()
      `,
    );
  }

  async write(deadLetter: AuditStreamDeadLetter): Promise<void> {
    const error = JSON.stringify({
      name: deadLetter.error.name,
      message: deadLetter.error.message,
      terminal: deadLetter.error.terminal,
      status: deadLetter.error.status ?? null,
      retryAfterMs: deadLetter.error.retryAfterMs ?? null,
    });
    const entries = JSON.stringify(deadLetter.entries);
    await this.options.prisma.$executeRaw(
      this.Prisma.sql!`
        INSERT INTO ${this.deadLetterTable}
          (stream_id, batch_id, checkpoint, high_watermark, entries, error)
        VALUES (
          ${deadLetter.streamId}, ${deadLetter.batchId}, ${deadLetter.checkpoint},
          ${deadLetter.highWatermark}, ${entries}::jsonb, ${error}::jsonb
        )
        ON CONFLICT (stream_id, batch_id) DO NOTHING
      `,
    );
  }
}

export function getAuditStreamStoreStatements(
  options: AuditStreamStoreSQLOptions = {},
): string[] {
  const checkpointTable = validateAuditTableName(
    options.checkpointTable ?? 'audit_log_stream_checkpoints',
  );
  const deadLetterTable = validateAuditTableName(
    options.deadLetterTable ?? 'audit_log_stream_dead_letters',
  );
  return [
    `CREATE TABLE IF NOT EXISTS ${checkpointTable} (
  stream_id text PRIMARY KEY,
  checkpoint text NULL,
  high_watermark text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE TABLE IF NOT EXISTS ${deadLetterTable} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_id text NOT NULL,
  batch_id text NOT NULL,
  checkpoint text NOT NULL,
  high_watermark text NOT NULL,
  entries jsonb NOT NULL,
  error jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, batch_id)
)`,
  ];
}

export async function applyAuditStreamStoreSchema(
  prisma: any,
  options: AuditStreamStoreSQLOptions = {},
): Promise<void> {
  for (const statement of getAuditStreamStoreStatements(options)) {
    await prisma.$executeRawUnsafe(statement);
  }
}
