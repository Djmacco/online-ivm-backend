import { ConflictException, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { effectivePermissions, RoleName } from '../rbac/permissions';
import { ChangePasswordDto, DeviceInfoDto, LoginDto, RegisterDto, ResetPasswordDto } from './auth.dto';
import { MailService } from './mail.service';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const BCRYPT_ROUNDS = 12;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
// Used to equalise timing when the e-mail is unknown (prevents user enumeration by response time).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  // ───────────── Register ─────────────
  async register(dto: RegisterDto, ip?: string) {
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('An account with this e-mail already exists.');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const { user, business } = await this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({ data: { name: (dto.businessName ?? `${dto.fullName}'s business`).trim() } });
      const user = await tx.user.create({
        data: { businessId: business.id, email, passwordHash, fullName: dto.fullName.trim(), role: 'ADMIN' },
      });
      return { user, business };
    });
    await this.registerDevice(user.id, business.id, dto);
    await this.audit.log({ businessId: business.id, userId: user.id, deviceId: dto.deviceId, action: 'auth.register', entity: 'user', entityId: user.id, ip });
    return this.buildSession(user, business.id, business.name, dto.deviceId);
  }

  // ───────────── Login ─────────────
  async login(dto: LoginDto, ip?: string) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email }, include: { business: true } });
    if (!user || !user.isActive) {
      await bcrypt.compare(dto.password, DUMMY_HASH);
      await this.audit.log({ action: 'auth.login_failed', ip, metadata: { reason: 'unknown_or_inactive' } });
      throw new UnauthorizedException('Invalid e-mail or password.');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.log({ businessId: user.businessId, userId: user.id, action: 'auth.login_blocked_locked', ip });
      throw new ForbiddenException({ code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again later.', lockedUntil: user.lockedUntil });
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      await this.audit.log({ businessId: user.businessId, userId: user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', ip });
      throw new UnauthorizedException('Invalid e-mail or password.');
    }
    await this.registerDevice(user.id, user.businessId, dto);
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await this.audit.log({ businessId: user.businessId, userId: user.id, deviceId: dto.deviceId, action: 'auth.login', ip });
    return this.buildSession(user, user.businessId, user.business.name, dto.deviceId);
  }

  // ───────────── Refresh (rotation + reuse detection) ─────────────
  async refresh(refreshToken: string, deviceId?: string, ip?: string) {
    let payload: { sub: string; did: string; fam: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, { secret: this.config.getOrThrow('JWT_REFRESH_SECRET') });
    } catch {
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!stored) throw new UnauthorizedException('Refresh token is invalid or expired.');
    if (stored.revokedAt) {
      // A rotated token was presented again => assume theft, kill the whole family.
      await this.prisma.refreshToken.updateMany({ where: { familyId: stored.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log({ userId: stored.userId, deviceId: stored.deviceId, action: 'auth.refresh_reuse_detected', ip });
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }
    if (stored.expiresAt < new Date() || (deviceId && deviceId !== stored.deviceId)) throw new UnauthorizedException('Refresh token is invalid or expired.');

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId }, include: { business: true } });
    const device = await this.prisma.device.findUnique({ where: { id: stored.deviceId } });
    if (!user || !user.isActive || !device || device.revokedAt) throw new UnauthorizedException('Session is no longer valid.');

    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    await this.prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    return this.buildSession(user, user.businessId, user.business.name, device.id, stored.familyId);
  }

  async logout(refreshToken: string, actor?: AuthUser, ip?: string) {
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (stored) {
      await this.prisma.refreshToken.updateMany({ where: { familyId: stored.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log({ businessId: actor?.businessId, userId: stored.userId, deviceId: stored.deviceId, action: 'auth.logout', ip });
    }
    return { success: true };
  }

  // ───────────── Password flows ─────────────
  async forgotPassword(emailRaw: string, ip?: string) {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && user.isActive) {
      const token = randomBytes(32).toString('base64url');
      await this.prisma.passwordReset.create({
        data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) },
      });
      await this.mail.sendPasswordReset(email, token);
      await this.audit.log({ businessId: user.businessId, userId: user.id, action: 'auth.password_reset_requested', ip });
    }
    // Same response either way: no account enumeration.
    return { success: true, message: 'If this e-mail exists, a reset link has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDto, ip?: string) {
    const reset = await this.prisma.passwordReset.findUnique({ where: { tokenHash: sha256(dto.token) } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) throw new UnauthorizedException('Reset token is invalid or expired.');
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    const user = await this.prisma.$transaction(async (tx) => {
      await tx.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } });
      const user = await tx.user.update({ where: { id: reset.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
      await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return user;
    });
    await this.audit.log({ businessId: user.businessId, userId: user.id, action: 'auth.password_reset', ip });
    return { success: true };
  }

  async changePassword(actor: AuthUser, dto: ChangePasswordDto, ip?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) throw new UnauthorizedException('Current password is incorrect.');
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      // Sign out every other device.
      this.prisma.refreshToken.updateMany({ where: { userId: user.id, deviceId: { not: actor.deviceId }, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ businessId: actor.businessId, userId: actor.id, deviceId: actor.deviceId, action: 'auth.password_changed', ip });
    return { success: true };
  }

  async me(actor: AuthUser) {
    const business = await this.prisma.business.findUniqueOrThrow({ where: { id: actor.businessId } });
    return { user: this.publicUser(actor), business: { id: business.id, name: business.name } };
  }

  // ───────────── helpers ─────────────
  private async registerDevice(userId: string, businessId: string, d: DeviceInfoDto) {
    const existing = await this.prisma.device.findUnique({ where: { id: d.deviceId } });
    if (existing) {
      if (existing.businessId !== businessId) throw new ForbiddenException('This device is registered to another business.');
      if (existing.revokedAt) throw new ForbiddenException({ code: 'DEVICE_REVOKED', message: 'This device has been revoked by an administrator.' });
      await this.prisma.device.update({
        where: { id: d.deviceId },
        data: { userId, name: d.deviceName, platform: d.platform, appVersion: d.appVersion, lastSeenAt: new Date() },
      });
      return;
    }
    await this.prisma.device.create({
      data: { id: d.deviceId, businessId, userId, name: d.deviceName, platform: d.platform, appVersion: d.appVersion },
    });
  }

  private async buildSession(
    user: { id: string; email: string; fullName: string; role: string; permissions: string[]; businessId: string },
    businessId: string,
    businessName: string,
    deviceId: string,
    familyId: string = randomUUID(),
  ) {
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    const refreshDays = Number(this.config.get('JWT_REFRESH_TTL_DAYS') ?? 30);
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, bid: businessId, did: deviceId },
      { secret: this.config.getOrThrow('JWT_SECRET'), expiresIn: accessTtl },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, did: deviceId, fam: familyId, jti: randomUUID() },
      { secret: this.config.getOrThrow('JWT_REFRESH_SECRET'), expiresIn: `${refreshDays}d` },
    );
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        deviceId,
        familyId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + refreshDays * 86_400_000),
      },
    });
    const role = user.role as RoleName;
    return {
      accessToken,
      refreshToken,
      accessTokenTtl: accessTtl,
      user: this.publicUser({ kind: 'account', id: user.id, email: user.email, fullName: user.fullName, role, businessId, deviceId, permissions: effectivePermissions(role, user.permissions) }),
      business: { id: businessId, name: businessName },
    };
  }

  private publicUser(u: AuthUser) {
    return { id: u.id, email: u.email, fullName: u.fullName, role: u.role, permissions: u.permissions, businessId: u.businessId };
  }
}
