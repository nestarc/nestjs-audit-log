export interface PrismaModuleLike {
  Prisma: {
    defineExtension: (extension: any) => any;
    sql?: (strings: TemplateStringsArray | readonly string[], ...values: any[]) => unknown;
    raw?: (value: string) => unknown;
    join?: (
      values: readonly any[],
      separator?: string,
      prefix?: string,
      suffix?: string,
    ) => unknown;
    empty?: unknown;
    dmmf?: {
      datamodel?: {
        models?: ReadonlyArray<{
          name: string;
          dbName?: string | null;
          schema?: string | null;
          kind?: string;
          fields?: ReadonlyArray<{
            name: string;
            type?: string;
            dbName?: string | null;
            kind?: string;
            isUpdatedAt?: boolean;
          }>;
        }>;
      };
    };
  };
}

export function resolvePrismaNamespace(
  options: { prismaModule?: PrismaModuleLike },
): PrismaModuleLike['Prisma'] {
  if (options.prismaModule) {
    if (typeof options.prismaModule.Prisma?.defineExtension !== 'function') {
      throw new Error(
        '[@nestarc/audit-log] prismaModule.Prisma.defineExtension is not a function. ' +
          'Pass the generated Prisma namespace, e.g. prismaModule: { Prisma }.',
      );
    }
    return options.prismaModule.Prisma;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@prisma/client').Prisma;
  } catch (cause) {
    const error = new Error(
      '[@nestarc/audit-log] Could not load @prisma/client. If your Prisma client is ' +
        'generated to a custom output path, pass it via the prismaModule option: ' +
        'createAuditExtension({ prismaModule: { Prisma } }).',
    );
    (error as Error & { cause?: unknown }).cause = cause;
    throw error;
  }
}
