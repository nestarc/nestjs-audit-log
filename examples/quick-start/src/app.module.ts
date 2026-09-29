import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuditLogModule } from '@nestarc/audit-log';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';
import { sharedAuditOptions, tenantScope } from './audit-options';
import { DemoIdentityGuard, UserController } from './user.controller';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        ...sharedAuditOptions,
        prisma: prisma.base,
        actorExtractionStage: 'interceptor',
        actorExtractor: req => ({
          id: req.user?.id ?? null,
          type: req.user ? 'user' : 'system',
          ip: req.ip,
        }),
      }),
    }),
  ],
  controllers: [UserController],
  providers: [DemoIdentityGuard],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Demo only: production must resolve an authorized tenant from authenticated identity.
    consumer.apply((_req: unknown, _res: unknown, next: () => void) =>
      tenantScope.run({ tenantId: 'demo-tenant' }, next),
    ).forRoutes(UserController);
  }
}
