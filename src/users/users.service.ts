import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { effectivePermissions, isValidPermission, RoleName } from '../rbac/permissions';
import { CreateUserDto, UpdateUserDto } from './users.dto';

const SELECT = { id: true, email: true, fullName: true, role: true, permissions: true, isActive: true, lastLoginAt: true, createdAt: true } as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(actor: AuthUser) {
    const users = await this.prisma.user.findMany({ where: { businessId: actor.businessId }, select: SELECT, orderBy: { createdAt: 'asc' } });
    return users.map((u) => ({ ...u, effectivePermissions: effectivePermissions(u.role as RoleName, u.permissions) }));
  }

  async create(actor: AuthUser, dto: CreateUserDto, ip?: string) {
    this.assertPermissionList(dto.permissions);
    this.assertCanGrantRole(actor, dto.role);
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('An account with this e-mail already exists.');
    const user = await this.prisma.user.create({
      data: {
        businessId: actor.businessId, email, fullName: dto.fullName.trim(), role: dto.role,
        passwordHash: await bcrypt.hash(dto.password, 12), permissions: dto.permissions ?? [],
      },
      select: SELECT,
    });
    await this.audit.log({ businessId: actor.businessId, userId: actor.id, deviceId: actor.deviceId, action: 'user.created', entity: 'user', entityId: user.id, ip, metadata: { role: dto.role } });
    return user;
  }

  async update(actor: AuthUser, id: string, dto: UpdateUserDto, ip?: string) {
    const target = await this.prisma.user.findFirst({ where: { id, businessId: actor.businessId } });
    if (!target) throw new NotFoundException('User not found.');
    this.assertPermissionList(dto.permissions);
    if (dto.role) this.assertCanGrantRole(actor, dto.role);
    if (target.role === 'ADMIN' && actor.role !== 'ADMIN') throw new ForbiddenException('Only an administrator can modify an administrator.');

    const demoting = (dto.role && dto.role !== 'ADMIN') || dto.isActive === false;
    if (target.role === 'ADMIN' && demoting) await this.assertAnotherAdminExists(actor.businessId, target.id);

    const user = await this.prisma.user.update({
      where: { id },
      data: {
        fullName: dto.fullName?.trim(), role: dto.role, permissions: dto.permissions, isActive: dto.isActive,
        ...(dto.newPassword ? { passwordHash: await bcrypt.hash(dto.newPassword, 12), failedLoginCount: 0, lockedUntil: null } : {}),
      },
      select: SELECT,
    });
    if (dto.isActive === false || dto.newPassword) {
      await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    const changed = Object.keys(dto).filter((k) => k !== 'newPassword');
    await this.audit.log({
      businessId: actor.businessId, userId: actor.id, deviceId: actor.deviceId, ip,
      action: dto.permissions || dto.role ? 'user.permissions_changed' : 'user.updated',
      entity: 'user', entityId: id, metadata: { changed, passwordChanged: !!dto.newPassword, role: dto.role },
    });
    return user;
  }

  /** Users are deactivated, never hard-deleted, so audit history and synced records keep their author. */
  async deactivate(actor: AuthUser, id: string, ip?: string) {
    if (id === actor.id) throw new BadRequestException('You cannot deactivate your own account.');
    return this.update(actor, id, { isActive: false }, ip);
  }

  private assertPermissionList(perms?: string[]) {
    const bad = (perms ?? []).filter((p) => !isValidPermission(p));
    if (bad.length) throw new BadRequestException({ message: 'Unknown permissions', unknown: bad });
  }
  private assertCanGrantRole(actor: AuthUser, role: string) {
    if (role === 'ADMIN' && actor.role !== 'ADMIN') throw new ForbiddenException('Only an administrator can grant the ADMIN role.');
  }
  private async assertAnotherAdminExists(businessId: string, excludeId: string) {
    const others = await this.prisma.user.count({ where: { businessId, role: 'ADMIN', isActive: true, id: { not: excludeId } } });
    if (others === 0) throw new BadRequestException('The business must keep at least one active administrator.');
  }
}
