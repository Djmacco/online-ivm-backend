import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { effectivePermissions, RoleName } from '../rbac/permissions';

export interface AccessTokenPayload {
  sub: string; // user id
  bid: string; // business id
  did: string; // device id
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class PrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Re-reads the user on every request so deactivation / role changes / device revocation apply immediately. */
  async account(payload: AccessTokenPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || user.businessId !== payload.bid) throw new UnauthorizedException('Session is no longer valid.');
    const device = await this.prisma.device.findUnique({ where: { id: payload.did } });
    if (!device || device.revokedAt || device.businessId !== user.businessId) {
      throw new UnauthorizedException({ code: 'DEVICE_REVOKED', message: 'This device has been revoked.' });
    }
    return {
      kind: 'account', id: user.id, businessId: user.businessId, email: user.email, fullName: user.fullName,
      role: user.role as RoleName, deviceId: payload.did, permissions: effectivePermissions(user.role as RoleName, user.permissions),
    };
  }

  /** A paid device authenticating with the opaque token returned by POST /payments/notchpay/create. */
  async deviceToken(token: string): Promise<AuthUser | null> {
    if (token.length < 20 || token.length > 200) return null;
    const row = await this.prisma.premiumDevice.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row) return null;
    return {
      kind: 'device', id: `device:${row.deviceId}`, businessId: '', email: '', fullName: 'Device', role: 'STAFF',
      deviceId: row.deviceId, permissions: ['subscription.read', 'ai.store_scan'],
    };
  }
}
