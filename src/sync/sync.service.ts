import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ChangeDto } from './sync.dto';
import {
  canSeeTable, checkSaleUpdate, decodeRestoreToken, encodeRestoreToken, hiddenTables, IMMUTABLE_TABLES, isDeleted, isSyncTable, Json, MAX_ROW_BYTES,
  RESTORE_ORDER, RESTRICTED_TABLES, sanitizeRow, validateRestrictedRow, validRow,
} from './sync-rules';

export interface ServerRecord { entityType: string; entityId: string; version: number; deleted: boolean; data: Json }
export interface PushResult {
  opId: string; entityId: string;
  status: 'ACCEPTED' | 'DUPLICATE' | 'CONFLICT' | 'REJECTED';
  version?: number; serverRecord?: ServerRecord; error?: string;
}
type Tx = Prisma.TransactionClient;
/** DB-level filter so the pull cursor stays consistent while restricted tables are hidden from non-administrators. */
const hiddenFilter = (granted: readonly string[]) => { const h = hiddenTables(granted); return h.length ? { entityType: { notIn: h } } : {}; };
const rid = (businessId: string, entityType: string, entityId: string) => ({ businessId_entityType_entityId: { businessId, entityType, entityId } });

@Injectable()
export class SyncService {
  private readonly logger = new Logger('Sync');
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subs: SubscriptionsService,
    private readonly config: ConfigService,
  ) {}

  // ───────────────────────── PUSH ─────────────────────────
  /**
   * Changes are applied strictly in order, each in its own transaction. An unexpected failure aborts the whole
   * request with a 5xx: the desktop puts the batch back in its queue and replays it, and every already-applied
   * change comes back as DUPLICATE (opId ledger) – so nothing is lost and nothing is duplicated.
   */
  async push(user: AuthUser, changes: ChangeDto[], ip?: string): Promise<{ results: PushResult[] }> {
    // A browser can view the cloud mirror, but the LAN hub remains the write authority until the
    // desktop implements a bidirectional relay. Enforce this on the server, not just in the UI.
    if (user.kind === 'account') {
      const device = await this.prisma.device.findFirst({ where: { id: user.deviceId, businessId: user.businessId, revokedAt: null }, select: { platform: true } });
      if (device?.platform === 'WEB') {
        throw new HttpException({ code: 'WEB_READ_ONLY', message: 'Web devices are read-only until shop cloud relay is enabled.' }, HttpStatus.FORBIDDEN);
      }
    }
    const results: PushResult[] = [];
    for (const c of changes) results.push(await this.applyOne(user, c));
    const n = (s: PushResult['status']) => results.filter((r) => r.status === s).length;
    await this.audit.log({
      businessId: user.businessId, userId: user.id, deviceId: user.deviceId, action: 'sync.push', ip,
      metadata: { total: changes.length, accepted: n('ACCEPTED'), duplicate: n('DUPLICATE'), conflict: n('CONFLICT'), rejected: n('REJECTED') },
    });
    return { results };
  }

  private async applyOne(user: AuthUser, c: ChangeDto): Promise<PushResult> {
    const reject = (error: string): PushResult => ({ opId: c.opId, entityId: c.entityId, status: 'REJECTED', error });
    if (!isSyncTable(c.entityType)) return reject(`Unknown entity type "${c.entityType}".`);
    if (!validRow(c.data)) return reject('data must be an object.');
    if (c.data.id !== undefined && String(c.data.id) !== c.entityId) return reject('data.id must equal entityId.');
    if (Buffer.byteLength(JSON.stringify(c.data)) > MAX_ROW_BYTES) return reject('Record is too large to synchronise.');

    // Staff accounts / roles / shop settings: administrators only (never remembered, so a retry works after a role change).
    if (!canSeeTable(user.permissions, c.entityType)) {
      return { opId: c.opId, entityId: c.entityId, status: 'REJECTED', error: `Only an administrator can synchronise "${c.entityType}" (needs ${RESTRICTED_TABLES[c.entityType]}).` };
    }
    const businessId = user.businessId;
    const data = sanitizeRow(c.entityType, c.entityId, c.data);
    const deleted = isDeleted(c.operation, data);
    if (deleted && !data.deleted_at) data.deleted_at = data.updated_at ?? new Date().toISOString();
    const invalid = validateRestrictedRow(c.entityType, c.entityId, data, deleted);
    if (invalid) return reject(invalid);

    return this.prisma.$transaction(
      async (tx) => {
        // ONE writer per business at a time. This also guarantees that the `serverSeq` cursor becomes visible in
        // order (no row with a lower seq can commit after a higher one), so a pulling device can never skip a change.
        // Prisma cannot deserialize PostgreSQL's `void` return type. Keep the advisory lock
        // in a volatile CTE, but return a supported scalar to the client.
        await tx.$queryRaw`WITH business_lock AS (
          SELECT pg_advisory_xact_lock(hashtext(${businessId}))
        )
        SELECT 1 FROM business_lock`;

        const prev = await tx.syncOperation.findUnique({ where: { businessId_opId: { businessId, opId: c.opId } } });
        if (prev) return { ...(prev.result as unknown as PushResult), status: 'DUPLICATE' as const };

        const cur = await tx.syncRecord.findUnique({ where: rid(businessId, c.entityType, c.entityId) });
        const done = async (r: PushResult) => {
          await tx.syncOperation.create({ data: { businessId, opId: c.opId, deviceId: user.deviceId, result: r as unknown as Prisma.InputJsonValue } });
          return r;
        };

        // Immutable ledgers: same id = same record.
        if (IMMUTABLE_TABLES.has(c.entityType)) {
          if (cur) return done({ opId: c.opId, entityId: c.entityId, status: 'DUPLICATE', version: cur.version });
          await this.write(tx, user, c, 1, deleted, data);
          return done({ opId: c.opId, entityId: c.entityId, status: 'ACCEPTED', version: 1 });
        }

        const curVersion = cur?.version ?? 0;
        // baseVersion > 0 but the cloud has nothing (e.g. restored/new project): accept as the first version.
        if (cur && c.baseVersion !== curVersion) {
          // NOT remembered: the desktop re-sends the same opId on top of the version it now knows.
          return { opId: c.opId, entityId: c.entityId, status: 'CONFLICT', serverRecord: this.toRecord(cur) } as PushResult;
        }
        if (c.entityType === 'sales' && cur) {
          const err = checkSaleUpdate(cur.data as Json, data);
          if (err) return reject(err);
        }
        const version = curVersion + 1;
        await this.write(tx, user, c, version, deleted, data);
        return done({ opId: c.opId, entityId: c.entityId, status: 'ACCEPTED', version });
      },
      { timeout: 15_000 },
    );
  }

  private async write(tx: Tx, user: AuthUser, c: ChangeDto, version: number, deleted: boolean, data: Json) {
    const json = data as Prisma.InputJsonValue;
    await tx.syncRecord.upsert({
      where: rid(user.businessId, c.entityType, c.entityId),
      create: { businessId: user.businessId, entityType: c.entityType, entityId: c.entityId, version, data: json, deviceId: user.deviceId, deletedAt: deleted ? new Date() : null },
      update: { version, data: json, deviceId: user.deviceId, deletedAt: deleted ? new Date() : null },
    });
    await tx.syncChange.create({
      data: { businessId: user.businessId, entityType: c.entityType, entityId: c.entityId, version, operation: c.operation, deleted, data: json, deviceId: user.deviceId },
    });
  }

  private toRecord(r: { entityType: string; entityId: string; version: number; deletedAt: Date | null; data: unknown }): ServerRecord {
    return { entityType: r.entityType, entityId: r.entityId, version: r.version, deleted: !!r.deletedAt, data: r.data as Json };
  }

  // ───────────────────────── PULL ─────────────────────────
  /** Global, strictly increasing cursor. Includes the caller's own changes too (the desktop ignores equal versions). */
  async pull(user: AuthUser, since: bigint, limit: number) {
    const take = Math.min(Math.max(limit, 1), 500);
    const rows = await this.prisma.syncChange.findMany({
      where: { businessId: user.businessId, serverSeq: { gt: since }, ...hiddenFilter(user.permissions) },
      orderBy: { serverSeq: 'asc' },
      take: take + 1,
    });
    const page = rows.slice(0, take);
    return {
      records: page.map((r) => ({ entityType: r.entityType, entityId: r.entityId, version: r.version, deleted: r.deleted, data: r.data as Json, cursor: r.serverSeq.toString() })),
      nextCursor: (page.length ? page[page.length - 1].serverSeq : since).toString(),
      hasMore: rows.length > take,
    };
  }

  // ───────────────────────── RESTORE (free, read-only) ─────────────────────────
  /**
   * Snapshot of the CURRENT state of every record, for a brand-new computer (cursor-less, no history). Works WITHOUT Premium so an
   * owner whose PC died gets their own data back without paying again; uploading new changes (push) still needs Premium.
   *
   *  - Tables are sent parents-first (RESTORE_ORDER) and records within a table by id, so any page can be applied on its own.
   *  - Every page carries the same `snapshotCursor` = the change-log position when the restore started. After the last page the
   *    desktop stores it as its sync cursor, so a later (Premium) sync continues from there and nothing is missed or re-downloaded.
   *  - Free restores are time-boxed per device and capped per business (see authorizeRestore): a recovery tool, not a free mirror.
   */
  async restore(user: AuthUser, token: string | undefined, limit: number, ip?: string) {
    const take = Math.min(Math.max(limit, 1), 500);
    let cursor = null as ReturnType<typeof decodeRestoreToken>;
    if (token) {
      cursor = decodeRestoreToken(token);
      if (!cursor) throw new HttpException({ code: 'BAD_TOKEN', message: 'Invalid restore token.' }, HttpStatus.BAD_REQUEST);
    }
    const businessId = user.businessId;

    const anything = await this.prisma.syncRecord.findFirst({ where: { businessId }, select: { entityId: true } });
    if (!anything) return { records: [], next: null, hasMore: false, snapshotCursor: '0' }; // nothing in the cloud: nothing to restore, no grant used

    await this.authorizeRestore(user);
    const state = cursor ?? { c: await this.latestSeq(businessId), t: 0, id: '' };
    if (!cursor) await this.audit.log({ businessId, userId: user.id, deviceId: user.deviceId, action: 'sync.restore.start', ip, metadata: { snapshotCursor: state.c } });

    const records: Array<{ entityType: string; entityId: string; version: number; deleted: boolean; data: Json; cursor: string }> = [];
    while (records.length < take && state.t < RESTORE_ORDER.length) {
      const type = RESTORE_ORDER[state.t];
      if (!canSeeTable(user.permissions, type)) { state.t++; state.id = ''; continue; }
      const room = take - records.length;
      const rows = await this.prisma.syncRecord.findMany({
        where: { businessId, entityType: type, ...(state.id ? { entityId: { gt: state.id } } : {}) },
        orderBy: { entityId: 'asc' },
        take: room + 1,
      });
      const used = rows.slice(0, room);
      for (const r of used) records.push({ entityType: r.entityType, entityId: r.entityId, version: r.version, deleted: !!r.deletedAt, data: r.data as Json, cursor: state.c });
      if (rows.length > room) { state.id = used[used.length - 1].entityId; break; } // page full, more of this table to come
      state.t++; state.id = '';                                                    // table finished, next one
    }
    const hasMore = state.t < RESTORE_ORDER.length;
    if (!hasMore) await this.audit.log({ businessId, userId: user.id, deviceId: user.deviceId, action: 'sync.restore.complete', ip, metadata: { snapshotCursor: state.c } });
    return { records, next: hasMore ? encodeRestoreToken(state) : null, hasMore, snapshotCursor: state.c };
  }

  /**
   * Who may restore for free: a device with Premium always; any other device of a business that has data, for RESTORE_WINDOW_DAYS
   * (default 7) from its first restore call, and at most RESTORE_MAX_DEVICES (default 3) such devices per business per 30 days.
   * Failures use codes the desktop already understands: 402 = "Premium required", 429 = "try later".
   */
  private async authorizeRestore(user: AuthUser): Promise<void> {
    if (await this.subs.getActive(user.deviceId)) return;
    const now = new Date();
    const windowDays = Number(this.config.get('RESTORE_WINDOW_DAYS') ?? 7);
    const maxDevices = Number(this.config.get('RESTORE_MAX_DEVICES') ?? 3);
    const grant = await this.prisma.restoreGrant.findUnique({ where: { deviceId: user.deviceId } });
    if (!grant) {
      const recent = await this.prisma.restoreGrant.count({ where: { businessId: user.businessId, firstAt: { gt: new Date(now.getTime() - 30 * 86_400_000) } } });
      if (recent >= maxDevices) {
        throw new HttpException({ code: 'RESTORE_DEVICE_LIMIT', message: 'This business already restored its data on several computers recently. Contact support or subscribe to Premium.' }, HttpStatus.TOO_MANY_REQUESTS);
      }
      await this.prisma.restoreGrant.create({ data: { deviceId: user.deviceId, businessId: user.businessId } });
      return;
    }
    if (grant.businessId !== user.businessId) {
      throw new HttpException({ code: 'RESTORE_DEVICE_LIMIT', message: 'This computer was already used to restore another business.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (now.getTime() > grant.firstAt.getTime() + windowDays * 86_400_000) {
      throw new HttpException(
        { code: 'PREMIUM_REQUIRED', reason: 'RESTORE_WINDOW_EXPIRED', message: 'The free restore period for this computer has ended. Subscribe to Premium to keep syncing. Your local data is not affected.' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    await this.prisma.restoreGrant.update({ where: { deviceId: user.deviceId }, data: { lastAt: now } });
  }

  private async latestSeq(businessId: string): Promise<string> {
    const last = await this.prisma.syncChange.findFirst({ where: { businessId }, orderBy: { serverSeq: 'desc' }, select: { serverSeq: true } });
    return (last?.serverSeq ?? BigInt(0)).toString();
  }
}
