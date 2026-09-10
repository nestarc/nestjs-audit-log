import { Module } from '@nestjs/common';
import { AuditLogModule } from '@nestarc/audit-log';
import { PrismaModule } from './prisma.module';
import { PrismaService, sharedAuditOptions } from './prisma.service';
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
export class AppModule {}
