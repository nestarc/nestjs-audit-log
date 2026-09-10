import {
  BadRequestException, Body, CanActivate, Controller, ExecutionContext,
  Get, Injectable, Param, Post, UseGuards,
} from '@nestjs/common';
import { AuditReason, AuditService } from '@nestarc/audit-log';
import { PrismaService } from './prisma.service';

// A fixed demo identity keeps the example focused on the Guard -> audit context flow.
// Replace this guard with your application's authentication and authorization.
@Injectable()
export class DemoIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = { id: 'demo-user' };
    return true;
  }
}

@Controller('users')
@UseGuards(DemoIdentityGuard)
export class UserController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Post()
  async create(@Body() data: { name: string; email: string; password: string }) {
    if (![data?.name, data?.email, data?.password].every(value => typeof value === 'string' && value.length > 0)) {
      throw new BadRequestException('name, email, and password are required strings');
    }
    return this.prisma.client.withAuditTransaction(tx => tx.user.create({
      data: { name: data.name, email: data.email, password: data.password },
      select: { id: true, name: true, email: true },
    }));
  }

  @Post(':id/review')
  @AuditReason('Profile reviewed')
  async review(@Param('id') id: string) {
    await this.audit.log({ action: 'user.reviewed', targetType: 'User', targetId: id });
    return { ok: true };
  }

  @Get(':id/audit')
  history(@Param('id') id: string) {
    return this.audit.query({
      tenantId: 'demo-tenant', targetType: 'User', targetId: id, includeTotal: false,
    });
  }
}
