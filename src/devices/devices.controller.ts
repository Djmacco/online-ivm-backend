import { Controller, Delete, Get, Module, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, Permissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get() @Permissions('sync.manage')
  list(@CurrentUser() u: AuthUser) {
    return this.prisma.device.findMany({ where: { businessId: u.businessId }, orderBy: { lastSeenAt: 'desc' } });
  }

  /** Revoke a lost / stolen device: its sessions die immediately (JwtStrategy checks revokedAt on every request). */
  @Delete(':id') @Permissions('sync.manage')
  async revoke(@CurrentUser() u: AuthUser, @Param('id') id: string, @ClientIp() ip?: string) {
    const device = await this.prisma.device.findFirst({ where: { id, businessId: u.businessId } });
    if (!device) throw new NotFoundException('Device not found.');
    await this.prisma.$transaction([
      this.prisma.device.update({ where: { id }, data: { revokedAt: new Date() } }),
      this.prisma.refreshToken.updateMany({ where: { deviceId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ businessId: u.businessId, userId: u.id, deviceId: u.deviceId, action: 'device.revoked', entity: 'device', entityId: id, ip });
    return { success: true };
  }
}

@Module({ controllers: [DevicesController] })
export class DevicesModule {}
