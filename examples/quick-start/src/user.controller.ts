import {
  BadRequestException, Body, CanActivate, Controller, ExecutionContext,
  ForbiddenException, Get, Injectable, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { AuditReason, AuditService } from '@nestarc/audit-log';
import { PrismaService } from './prisma.service';
import { tenantScope } from './audit-options';

interface DemoRequest { user: { id: string; tenantId: string; permissions: string[] } }

function authorizedTenant(req: DemoRequest, permission: string): string {
  const tenantId = tenantScope.getStore()?.tenantId;
  if (!tenantId || req.user.tenantId !== tenantId || !req.user.permissions.includes(permission)) {
    throw new ForbiddenException();
  }
  return tenantId;
}

// A fixed demo identity keeps the example focused on the Guard -> audit context flow.
// Replace this guard with your application's authentication and authorization.
@Injectable()
export class DemoIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = { id: 'demo-user', tenantId: 'demo-tenant',
      permissions: ['users:write', 'audit:read'] };
    return true;
  }
}

@Controller('users')
@UseGuards(DemoIdentityGuard)
export class UserController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Post()
  async create(@Req() req: DemoRequest, @Body() data: { name: string; email: string; password: string }) {
    if (![data?.name, data?.email, data?.password].every(value => typeof value === 'string' && value.length > 0)) {
      throw new BadRequestException('name, email, and password are required strings');
    }
    const tenantId = authorizedTenant(req, 'users:write');
    return this.prisma.client.withAuditTransaction(tx => tx.user.create({
      data: { name: data.name, email: data.email, password: data.password, tenantId },
      select: { id: true, name: true, email: true },
    }));
  }

  @Post(':id/role')
  async changeRole(@Req() req: DemoRequest, @Param('id') id: string, @Body() data: { role: string }) {
    const tenantId = authorizedTenant(req, 'users:write');
    if (!['member', 'admin'].includes(data?.role)) throw new BadRequestException('role must be member or admin');
    return this.prisma.client.withAuditTransaction(tx => tx.user.update({
      where: { id, tenantId }, data: { role: data.role }, select: { id: true, role: true },
    }));
  }

  @Post(':id/review')
  @AuditReason('Profile reviewed')
  async review(@Req() req: DemoRequest, @Param('id') id: string) {
    const tenantId = authorizedTenant(req, 'users:write');
    await this.prisma.base.user.findUniqueOrThrow({ where: { id, tenantId } });
    await this.audit.log({ action: 'user.reviewed', targetType: 'User', targetId: id });
    return { ok: true };
  }

  @Get(':id/audit')
  history(@Req() req: DemoRequest, @Param('id') id: string) {
    const tenantId = authorizedTenant(req, 'audit:read');
    return this.audit.query({
      tenantId, targetType: 'User', targetId: id, includeTotal: false,
    });
  }
}
