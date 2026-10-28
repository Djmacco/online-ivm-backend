import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

type JsonRow = Record<string, unknown>;
type SaleRecord = { entityId: string; data: Prisma.JsonValue };
type SaleItemRecord = { data: Prisma.JsonValue };
type Cursor = { soldAt: string; id: string };
const record = (value: Prisma.JsonValue): JsonRow => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRow : {};
const num = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

@Injectable()
export class MonitoringService {
  constructor(private readonly prisma: PrismaService) {}

  async transactions(user: AuthUser, options: { from?: string; to?: string; paymentMethod?: string; search?: string; cursor?: string; limit?: number }) {
    if (user.kind !== 'account' || user.role !== 'ADMIN') throw new ForbiddenException({ code: 'ADMIN_ONLY', message: 'Only the business administrator can view company transactions.' });
    const from = this.dateBoundary(options.from, false);
    const to = this.dateBoundary(options.to, true);
    if (from && to && from >= to) throw new BadRequestException('The start date must be on or before the end date.');
    const cursor = options.cursor ? this.decodeCursor(options.cursor) : null;
    const limit = Math.min(Math.max(options.limit ?? 50, 10), 100);
    const businessId = user.businessId;
    const paymentMethod = options.paymentMethod?.trim().toUpperCase() || null;
    const search = options.search?.trim() || null;
    const searchPattern = search ? `%${search}%` : null;
    const cursorAt = cursor?.soldAt ?? null;
    const cursorId = cursor?.id ?? null;

    const [sales, aggregates, paymentBreakdown] = await Promise.all([
      this.prisma.$queryRaw<SaleRecord[]>(Prisma.sql`
        SELECT "entityId", "data" FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'sales' AND "deletedAt" IS NULL
          AND (${from}::text IS NULL OR "data"->>'sold_at' >= ${from})
          AND (${to}::text IS NULL OR "data"->>'sold_at' < ${to})
          AND (${paymentMethod}::text IS NULL OR upper("data"->>'payment_method') = ${paymentMethod})
          AND (${searchPattern}::text IS NULL OR "data"->>'receipt_no' ILIKE ${searchPattern}
            OR "data"->>'user_name' ILIKE ${searchPattern} OR "data"->>'customer_name' ILIKE ${searchPattern}
            OR EXISTS (SELECT 1 FROM "SyncRecord" AS line WHERE line."businessId" = ${businessId}::uuid
              AND line."entityType" = 'sale_items' AND line."deletedAt" IS NULL
              AND line."data"->>'sale_id' = "SyncRecord"."entityId"
              AND line."data"->>'product_name' ILIKE ${searchPattern}))
          AND (${cursorAt}::text IS NULL OR "data"->>'sold_at' < ${cursorAt}
            OR ("data"->>'sold_at' = ${cursorAt} AND "entityId" < ${cursorId}))
        ORDER BY "data"->>'sold_at' DESC, "entityId" DESC
        LIMIT ${limit + 1}
      `),
      this.prisma.$queryRaw<Array<{ count: number; completed: number; profit: number; cancelled: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count,
          COALESCE(SUM(CASE WHEN "data"->>'status' = 'COMPLETED' THEN COALESCE(NULLIF("data"->>'total','')::double precision,0) ELSE 0 END),0)::double precision AS completed,
          COALESCE(SUM(CASE WHEN "data"->>'status' = 'COMPLETED' THEN COALESCE(NULLIF("data"->>'total','')::double precision,0) - COALESCE(NULLIF("data"->>'cost_total','')::double precision,0) ELSE 0 END),0)::double precision AS profit,
          COUNT(*) FILTER (WHERE "data"->>'status' = 'CANCELLED')::int AS cancelled
        FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'sales' AND "deletedAt" IS NULL
          AND (${from}::text IS NULL OR "data"->>'sold_at' >= ${from})
          AND (${to}::text IS NULL OR "data"->>'sold_at' < ${to})
          AND (${paymentMethod}::text IS NULL OR upper("data"->>'payment_method') = ${paymentMethod})
          AND (${searchPattern}::text IS NULL OR "data"->>'receipt_no' ILIKE ${searchPattern}
            OR "data"->>'user_name' ILIKE ${searchPattern} OR "data"->>'customer_name' ILIKE ${searchPattern}
            OR EXISTS (SELECT 1 FROM "SyncRecord" AS line WHERE line."businessId" = ${businessId}::uuid
              AND line."entityType" = 'sale_items' AND line."deletedAt" IS NULL
              AND line."data"->>'sale_id' = "SyncRecord"."entityId"
              AND line."data"->>'product_name' ILIKE ${searchPattern}))
      `),
      this.prisma.$queryRaw<Array<{ paymentMethod: string; count: number; total: number }>>(Prisma.sql`
        SELECT COALESCE(NULLIF("data"->>'payment_method',''),'OTHER') AS "paymentMethod",
          COUNT(*)::int AS count,
          COALESCE(SUM(COALESCE(NULLIF("data"->>'total','')::double precision,0)),0)::double precision AS total
        FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'sales' AND "deletedAt" IS NULL
          AND "data"->>'status' = 'COMPLETED'
          AND (${from}::text IS NULL OR "data"->>'sold_at' >= ${from})
          AND (${to}::text IS NULL OR "data"->>'sold_at' < ${to})
          AND (${paymentMethod}::text IS NULL OR upper("data"->>'payment_method') = ${paymentMethod})
          AND (${searchPattern}::text IS NULL OR "data"->>'receipt_no' ILIKE ${searchPattern}
            OR "data"->>'user_name' ILIKE ${searchPattern} OR "data"->>'customer_name' ILIKE ${searchPattern}
            OR EXISTS (SELECT 1 FROM "SyncRecord" AS line WHERE line."businessId" = ${businessId}::uuid
              AND line."entityType" = 'sale_items' AND line."deletedAt" IS NULL
              AND line."data"->>'sale_id' = "SyncRecord"."entityId"
              AND line."data"->>'product_name' ILIKE ${searchPattern}))
        GROUP BY COALESCE(NULLIF("data"->>'payment_method',''),'OTHER') ORDER BY total DESC
      `),
    ]);

    const page = sales.slice(0, limit);
    const ids = page.map((row) => row.entityId);
    const items = ids.length ? await this.prisma.$queryRaw<SaleItemRecord[]>(Prisma.sql`
      SELECT "data" FROM "SyncRecord"
      WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'sale_items' AND "deletedAt" IS NULL
        AND "data"->>'sale_id' IN (${Prisma.join(ids)})
      ORDER BY "createdAt" ASC, "entityId" ASC
    `) : [];
    const bySale = new Map<string, JsonRow[]>();
    for (const itemRow of items) {
      const item = record(itemRow.data);
      const saleId = String(item.sale_id ?? '');
      if (!bySale.has(saleId)) bySale.set(saleId, []);
      bySale.get(saleId)!.push({
        productName: String(item.product_name ?? '—'), quantity: num(item.quantity), unitPrice: num(item.unit_price),
        discount: num(item.discount), lineTotal: num(item.line_total),
      });
    }

    const rows = page.map((row) => {
      const sale = record(row.data);
      const status = String(sale.status ?? 'COMPLETED');
      const total = num(sale.total);
      const cost = num(sale.cost_total);
      return {
        id: row.entityId, receiptNumber: String(sale.receipt_no ?? row.entityId), soldAt: String(sale.sold_at ?? ''),
        cashier: String(sale.user_name ?? '—'), customer: String(sale.customer_name ?? ''),
        paymentMethod: String(sale.payment_method ?? 'OTHER'), status, total,
        profit: status === 'COMPLETED' ? total - cost : 0, items: bySale.get(row.entityId) ?? [],
      };
    });
    const last = page.at(-1);
    const lastData = last ? record(last.data) : {};
    return {
      transactions: rows,
      summary: aggregates[0] ?? { count: 0, completed: 0, profit: 0, cancelled: 0 },
      paymentBreakdown,
      nextCursor: sales.length > limit && last ? this.encodeCursor({ soldAt: String(lastData.sold_at ?? ''), id: last.entityId }) : null,
      filters: { from: options.from ?? null, to: options.to ?? null, paymentMethod: paymentMethod ?? null, search: search ?? null },
    };
  }

  private dateBoundary(day: string | undefined, exclusiveEnd: boolean): string | null {
    if (!day) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!match) throw new BadRequestException('Dates must use YYYY-MM-DD format.');
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.toISOString().slice(0, 10) !== day) throw new BadRequestException('Enter a valid calendar date.');
    if (exclusiveEnd) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  }

  private encodeCursor(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
  private decodeCursor(token: string): Cursor {
    try {
      const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<Cursor>;
      if (typeof value.soldAt !== 'string' || !Number.isFinite(Date.parse(value.soldAt)) || typeof value.id !== 'string' || !value.id.length || value.id.length > 100) throw new Error();
      return { soldAt: value.soldAt, id: value.id };
    } catch { throw new BadRequestException('Invalid transaction page cursor.'); }
  }
}
