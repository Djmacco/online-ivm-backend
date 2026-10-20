import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { sha256 } from '../auth/principal.service';
import { FeatureName, PREMIUM_FEATURES } from '../common/features';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { publicKeyHexFromPrivate, signEntitlement } from './entitlement';

export type SubscriptionState = 'NONE' | 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'FAILED';
export interface SubscriptionStatusDto { status: SubscriptionState; entitlement: string | null; expiresAt: string | null }
export interface SharedDeviceDto {
  deviceId: string;
  status: 'SHARED' | 'ALREADY_SHARED' | 'OWN_SUBSCRIPTION' | 'INVALID';
  entitlement: string | null;
  deviceToken: string | null;
  expiresAt: string | null;
}

const SYNC_TRIAL_MS = 30 * 60_000;
const SCAN_CLAIM_STALE_MS = 5 * 60_000;

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  /** The device's currently valid Premium subscription (latest expiry), or null. Expiry is evaluated on read. */
  async getActive(deviceId: string, now = new Date()) {
    await this.prisma.subscription.updateMany({ where: { deviceId, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
    return this.prisma.subscription.findFirst({
      where: { deviceId, status: 'ACTIVE', plan: 'PREMIUM', expiresAt: { gt: now } },
      orderBy: { expiresAt: 'desc' },
    });
  }

  /** A shop member inherits the owner's current subscription, but receives an entitlement for their own device id. */
  async getActiveFor(deviceId: string, now = new Date()) {
    const own = await this.getActive(deviceId, now);
    if (own) return own;
    const share = await this.prisma.premiumShare.findUnique({ where: { memberDeviceId: deviceId } });
    return share ? this.getActive(share.ownerDeviceId, now) : null;
  }

  /** Used by FeatureGuard – Premium, or the single server-enforced shop trial. */
  async hasFeature(deviceId: string, feature: FeatureName, businessId?: string): Promise<boolean> {
    if (!PREMIUM_FEATURES.includes(feature)) return false;
    if (await this.getActiveFor(deviceId)) return true;
    if (!businessId) return false;
    const trial = await this.prisma.businessTrial.findUnique({ where: { businessId } });
    if (trial && trial.deviceId !== deviceId) return false;
    if (feature === 'CLOUD_SYNC') return !!trial?.syncExpiresAt && trial.syncExpiresAt > new Date();
    if (!await this.isMainDevice(businessId, deviceId)) return false;
    if (!trial) return true;
    return trial.scanStatus === 'AVAILABLE' || (trial.scanStatus === 'IN_PROGRESS' && !!trial.scanClaimedAt && trial.scanClaimedAt.getTime() < Date.now() - SCAN_CLAIM_STALE_MS);
  }

  /** Public trial state for the account's main PC; no email/device can reset a consumed shop trial. */
  async trialStatus(user: AuthUser) {
    if (user.kind !== 'account') throw new ForbiddenException('The introductory trial is available to the shop main PC account.');
    const mainDevice = await this.isMainDevice(user.businessId, user.deviceId);
    const [trial, paid] = await Promise.all([
      this.prisma.businessTrial.findUnique({ where: { businessId: user.businessId } }),
      this.getActiveFor(user.deviceId),
    ]);
    const sameTrialDevice = !trial || trial.deviceId === user.deviceId;
    const scanAvailable = mainDevice && sameTrialDevice && (!trial || trial.scanStatus === 'AVAILABLE' || (trial.scanStatus === 'IN_PROGRESS' && !!trial.scanClaimedAt && trial.scanClaimedAt.getTime() < Date.now() - SCAN_CLAIM_STALE_MS));
    const syncAvailable = mainDevice && sameTrialDevice && (!trial || !trial.syncStartedAt);
    return {
      eligible: mainDevice && sameTrialDevice && !paid && (syncAvailable || scanAvailable),
      mainDevice,
      premium: !!paid,
      sync: { available: !paid && syncAvailable, startedAt: trial?.syncStartedAt?.toISOString() ?? null, expiresAt: trial?.syncExpiresAt?.toISOString() ?? null },
      scan: { available: !paid && scanAvailable, used: trial?.scanStatus === 'USED' },
    };
  }

  /** The primary registered computer starts one 30-minute two-way upload/sync window for the shop. */
  async startSyncTrial(user: AuthUser) {
    if (user.kind !== 'account' || !await this.isMainDevice(user.businessId, user.deviceId)) {
      throw new ForbiddenException({ code: 'TRIAL_MAIN_DEVICE_ONLY', message: 'The free trial can only be started from the shop main PC.' });
    }
    if (await this.getActiveFor(user.deviceId)) return { premium: true, expiresAt: null };
    const trial = await this.getOrCreateTrial(user);
    if (trial.syncStartedAt) throw new ConflictException({ code: 'TRIAL_ALREADY_USED', message: 'This shop has already used its free cloud sync window.' });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SYNC_TRIAL_MS);
    const result = await this.prisma.businessTrial.updateMany({
      where: { businessId: user.businessId, deviceId: user.deviceId, syncStartedAt: null },
      data: { syncStartedAt: now, syncExpiresAt: expiresAt },
    });
    if (!result.count) throw new ConflictException({ code: 'TRIAL_ALREADY_USED', message: 'This shop has already used its free cloud sync window.' });
    await this.prisma.auditLog.create({ data: { businessId: user.businessId, userId: user.id, deviceId: user.deviceId, action: 'trial.sync.started' } });
    return { premium: false, startedAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
  }

  /** Reserve the shop's one scan; it is consumed only after a successful analysis. */
  async beginTrialScan(user: AuthUser): Promise<string | null> {
    if (await this.getActiveFor(user.deviceId)) return null;
    if (user.kind !== 'account' || !await this.isMainDevice(user.businessId, user.deviceId)) {
      throw this.trialScanRequired();
    }
    await this.getOrCreateTrial(user);
    const claimId = randomUUID();
    const staleBefore = new Date(Date.now() - SCAN_CLAIM_STALE_MS);
    const claimed = await this.prisma.businessTrial.updateMany({
      where: {
        businessId: user.businessId, deviceId: user.deviceId,
        OR: [{ scanStatus: 'AVAILABLE' }, { scanStatus: 'IN_PROGRESS', scanClaimedAt: { lt: staleBefore } }],
      },
      data: { scanStatus: 'IN_PROGRESS', scanClaimId: claimId, scanClaimedAt: new Date() },
    });
    if (!claimed.count) throw this.trialScanRequired();
    return claimId;
  }

  async finishTrialScan(user: AuthUser, claimId: string, succeeded: boolean) {
    if (user.kind !== 'account') return;
    await this.prisma.businessTrial.updateMany({
      where: { businessId: user.businessId, deviceId: user.deviceId, scanStatus: 'IN_PROGRESS', scanClaimId: claimId },
      data: { scanStatus: succeeded ? 'USED' : 'AVAILABLE', scanClaimId: null, scanClaimedAt: null },
    });
  }

  private trialScanRequired() {
    return new HttpException({ code: 'PREMIUM_REQUIRED', feature: 'AI_STORE_SCAN', reason: 'TRIAL_SCAN_USED', message: 'The shop has used its free shelf scan. Subscribe to Premium for more scans.' }, HttpStatus.PAYMENT_REQUIRED);
  }

  private async isMainDevice(businessId: string, deviceId: string): Promise<boolean> {
    const first = await this.prisma.device.findFirst({ where: { businessId, revokedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
    return first?.id === deviceId;
  }

  private async getOrCreateTrial(user: AuthUser) {
    let trial = await this.prisma.businessTrial.findUnique({ where: { businessId: user.businessId } });
    if (trial) {
      if (trial.deviceId !== user.deviceId) throw new ForbiddenException({ code: 'TRIAL_MAIN_DEVICE_ONLY', message: 'This shop trial is already tied to its main PC.' });
      return trial;
    }
    try {
      return await this.prisma.businessTrial.create({ data: { businessId: user.businessId, deviceId: user.deviceId } });
    } catch {
      trial = await this.prisma.businessTrial.findUnique({ where: { businessId: user.businessId } });
      if (!trial || trial.deviceId !== user.deviceId) throw new ForbiddenException({ code: 'TRIAL_ALREADY_USED', message: 'This shop or computer has already used an introductory trial.' });
      return trial;
    }
  }

  /** A paying device shares its active Premium with up to nine paired shop PCs. */
  async shareDevices(ownerDeviceId: string, deviceIds: string[]): Promise<SharedDeviceDto[]> {
    const unique = [...new Set(deviceIds)];
    const owner = await this.getActive(ownerDeviceId);
    if (!owner || await this.prisma.premiumShare.findUnique({ where: { memberDeviceId: ownerDeviceId } })) {
      return unique.map((deviceId) => ({ deviceId, status: 'INVALID', entitlement: null, deviceToken: null, expiresAt: null }));
    }
    const currentCount = await this.prisma.premiumShare.count({ where: { ownerDeviceId } });
    let slots = Math.max(0, 9 - currentCount);
    const results: SharedDeviceDto[] = [];
    for (const deviceId of unique) {
      if (!deviceId || deviceId === ownerDeviceId || deviceId.length > 100) {
        results.push({ deviceId, status: 'INVALID', entitlement: null, deviceToken: null, expiresAt: null }); continue;
      }
      if (await this.getActive(deviceId)) {
        results.push({ deviceId, status: 'OWN_SUBSCRIPTION', entitlement: null, deviceToken: null, expiresAt: null }); continue;
      }
      const prior = await this.prisma.premiumShare.findUnique({ where: { memberDeviceId: deviceId } });
      if (prior && prior.ownerDeviceId !== ownerDeviceId) {
        results.push({ deviceId, status: 'INVALID', entitlement: null, deviceToken: null, expiresAt: null }); continue;
      }
      if (!prior && slots <= 0) {
        results.push({ deviceId, status: 'INVALID', entitlement: null, deviceToken: null, expiresAt: null }); continue;
      }
      await this.prisma.premiumShare.upsert({
        where: { memberDeviceId: deviceId },
        create: { ownerDeviceId, memberDeviceId: deviceId },
        update: { ownerDeviceId },
      });
      if (!prior) slots--;
      const token = await this.ensureSharedDeviceToken(deviceId);
      results.push({
        deviceId, status: prior ? 'ALREADY_SHARED' : 'SHARED',
        entitlement: this.issueEntitlement(deviceId, owner), deviceToken: token,
        expiresAt: owner.expiresAt.toISOString(),
      });
    }
    return results;
  }

  /** Remove a member only when the caller is the recorded owner. */
  async unshareDevice(ownerDeviceId: string, memberDeviceId: string): Promise<boolean> {
    const r = await this.prisma.premiumShare.deleteMany({ where: { ownerDeviceId, memberDeviceId } });
    return r.count > 0;
  }

  /** Return a token only when first created. Existing devices retain their opaque token. */
  private async ensureSharedDeviceToken(deviceId: string): Promise<string | null> {
    if (await this.prisma.premiumDevice.findUnique({ where: { deviceId } })) return null;
    const token = randomBytes(32).toString('base64url');
    try {
      await this.prisma.premiumDevice.create({ data: { deviceId, tokenHash: sha256(token) } });
      return token;
    } catch {
      return null;
    }
  }

  /**
   * Contract: GET /subscriptions/status → { status, entitlement?, expiresAt? }.
   * When ACTIVE a freshly signed, device-bound entitlement is returned (renewal / revocation are picked up by the app's
   * silent 15-minute poll). `reference` lets the app follow one specific payment.
   */
  async statusFor(deviceId: string, reference?: string): Promise<SubscriptionStatusDto> {
    const active = await this.getActiveFor(deviceId);
    if (active) return { status: 'ACTIVE', entitlement: this.issueEntitlement(deviceId, active), expiresAt: active.expiresAt.toISOString() };

    if (reference) {
      const p = await this.prisma.payment.findFirst({ where: { reference, deviceId } });
      if (p?.status === 'PENDING') return { status: 'PENDING', entitlement: null, expiresAt: null };
      if (p && (p.status === 'FAILED' || p.status === 'CANCELED')) return { status: 'FAILED', entitlement: null, expiresAt: null };
    }
    const last = await this.prisma.subscription.findFirst({ where: { deviceId }, orderBy: { expiresAt: 'desc' } });
    if (last) return { status: 'EXPIRED', entitlement: null, expiresAt: last.expiresAt.toISOString() };
    return { status: 'NONE', entitlement: null, expiresAt: null };
  }

  issueEntitlement(deviceId: string, sub: { userId: string | null; startedAt: Date; expiresAt: Date }): string {
    return signEntitlement(
      { userId: sub.userId ?? deviceId, deviceId, features: [...PREMIUM_FEATURES], startedAt: sub.startedAt.toISOString(), expiresAt: sub.expiresAt.toISOString() },
      this.config.getOrThrow<string>('ENTITLEMENT_PRIVATE_KEY'),
    );
  }

  publicKeyHex(): string {
    return publicKeyHexFromPrivate(this.config.getOrThrow<string>('ENTITLEMENT_PRIVATE_KEY'));
  }
  price(): number { return Number(this.config.get('PREMIUM_PRICE_XAF') ?? 3900); }
  periodDays(): number { return Number(this.config.get('PREMIUM_PERIOD_DAYS') ?? 30); }

  /**
   * Called ONLY by the payments service after the transaction was verified server-side with Notch Pay.
   * Renewals stack: paying while active extends from max(now, current expiry) – no days are lost.
   */
  async activate(tx: Prisma.TransactionClient, p: { deviceId: string; transactionId: string; amount: number; currency: string }) {
    const existing = await tx.subscription.findUnique({ where: { transactionId: p.transactionId } });
    if (existing) return existing; // idempotent: webhook replays / polling cannot double-credit
    const now = new Date();
    const current = await tx.subscription.findFirst({ where: { deviceId: p.deviceId, status: 'ACTIVE', expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' } });
    const startedAt = current ? current.expiresAt : now;
    const expiresAt = new Date(startedAt.getTime() + this.periodDays() * 86_400_000);
    return tx.subscription.create({
      data: { deviceId: p.deviceId, plan: 'PREMIUM', price: p.amount, currency: p.currency, status: 'ACTIVE', provider: 'NOTCHPAY', transactionId: p.transactionId, startedAt, expiresAt },
    });
  }
}
