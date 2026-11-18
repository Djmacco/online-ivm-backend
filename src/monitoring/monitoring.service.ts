import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

type JsonRow = Record<string, unknown>;
type SaleRecord = { entityId: string; data: Prisma.JsonValue };
type SaleItemRecord = { data: Prisma.JsonValue };
type Cursor = { soldAt: string; id: string };
type MovementCursor = { createdAt: string; id: string };
const record = (value: Prisma.JsonValue): JsonRow => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRow : {};
const num = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

@Injectable()
export class MonitoringService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(user: AuthUser) {
    if (user.kind !== 'account' || user.role !== 'ADMIN') throw new ForbiddenException({ code: 'ADMIN_ONLY', message: 'Only the business administrator can view company information.' });
    const businessId = user.businessId;
    const [products, openSessions, closedSessions] = await Promise.all([
      this.prisma.$queryRaw<SaleRecord[]>(Prisma.sql`
        SELECT "entityId", jsonb_build_object(
          'name', "data"->'name', 'sku', "data"->'sku', 'quantity', "data"->'quantity',
          'minimum_stock', "data"->'minimum_stock', 'unit', "data"->'unit'
        ) AS "data"
        FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'products' AND "deletedAt" IS NULL
      `),
      this.prisma.$queryRaw<SaleRecord[]>(Prisma.sql`
        SELECT "entityId", "data" FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'cash_sessions' AND "deletedAt" IS NULL
          AND "data"->>'status' = 'OPEN'
        ORDER BY "data"->>'opened_at' ASC LIMIT 100
      `),
      this.prisma.$queryRaw<SaleRecord[]>(Prisma.sql`
        SELECT "entityId", "data" FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'cash_sessions' AND "deletedAt" IS NULL
          AND "data"->>'status' = 'CLOSED'
        ORDER BY "data"->>'closed_at' DESC LIMIT 12
      `),
    ]);

    const stock = products.map(({ entityId, data }) => {
      const product = record(data);
      return {
        id: entityId, name: String(product.name ?? '—'), sku: String(product.sku ?? ''),
        quantity: num(product.quantity), minimumStock: Math.max(0, num(product.minimum_stock)), unit: String(product.unit ?? ''),
      };
    });
    const outOfStock = stock.filter((product) => product.quantity <= 0);
    const lowStock = stock.filter((product) => product.quantity > 0 && product.minimumStock > 0 && product.quantity <= product.minimumStock)
      .sort((a, b) => (a.quantity / a.minimumStock) - (b.quantity / b.minimumStock));
    const sessionRows = [...openSessions, ...closedSessions];
    const openIds = openSessions.map((session) => session.entityId);
    const openUsers = openSessions.map((session) => String(record(session.data).user_id ?? '')).filter(Boolean);
    const [openSales, customerPayments] = openIds.length ? await Promise.all([
      this.prisma.$queryRaw<SaleItemRecord[]>(Prisma.sql`
        SELECT "data" FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'sales' AND "deletedAt" IS NULL
          AND "data"->>'cash_session_id' IN (${Prisma.join(openIds)})
      `),
      openUsers.length ? this.prisma.$queryRaw<SaleItemRecord[]>(Prisma.sql`
        SELECT "data" FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'customer_payments' AND "deletedAt" IS NULL
          AND "data"->>'method' = 'CASH' AND "data"->>'user_id' IN (${Prisma.join(openUsers)})
      `) : Promise.resolve([]),
    ]) : [[], []];

    const now = new Date().toISOString();
    const sessions = sessionRows.map(({ entityId, data }) => {
      const session = record(data);
      const isOpen = session.status === 'OPEN';
      const sales = isOpen ? openSales.map((row) => record(row.data)).filter((sale) => sale.cash_session_id === entityId && sale.status === 'COMPLETED') : [];
      const cashSales = sales.filter((sale) => sale.payment_method === 'CASH').reduce((total, sale) => total + num(sale.amount_paid), 0);
      const cashCustomerPayments = isOpen ? customerPayments.map((row) => record(row.data)).filter((payment) =>
        payment.user_id === session.user_id && String(payment.paid_at ?? '') >= String(session.opened_at ?? '') && String(payment.paid_at ?? '') <= now,
      ).reduce((total, payment) => total + num(payment.amount), 0) : 0;
      const openingFloat = num(session.opening_float);
      return {
        id: entityId, cashier: String(session.user_name ?? '—'), openedAt: String(session.opened_at ?? ''),
        closedAt: typeof session.closed_at === 'string' ? session.closed_at : null,
        status: isOpen ? 'OPEN' : 'CLOSED', openingFloat,
        expectedCash: isOpen ? openingFloat + cashSales + cashCustomerPayments : num(session.expected_cash),
        countedCash: session.counted_cash == null ? null : num(session.counted_cash),
        difference: session.difference == null ? null : num(session.difference),
        salesCount: isOpen ? sales.length : null,
      };
    }).sort((a, b) => b.openedAt.localeCompare(a.openedAt));

    return {
      stock: {
        productCount: stock.length, lowStockCount: lowStock.length, outOfStockCount: outOfStock.length,
        lowStock: lowStock.slice(0, 8), outOfStock: outOfStock.slice(0, 8),
      },
      cash: {
        openRegisterCount: sessions.filter((session) => session.status === 'OPEN').length,
        recentSessions: sessions.slice(0, 16),
      },
    };
  }

  async inventory(user: AuthUser, options: { from?: string; to?: string; cursor?: string; limit?: number; productOffset?: number; productLimit?: number }) {
    if (user.kind !== 'account' || user.role !== 'ADMIN') throw new ForbiddenException({ code: 'ADMIN_ONLY', message: 'Only the business administrator can view company inventory.' });
    const businessId = user.businessId;
    const from = this.dateBoundary(options.from, false);
    const to = this.dateBoundary(options.to, true);
    if (from && to && from >= to) throw new BadRequestException('The start date must be on or before the end date.');
    const limit = Math.min(100, Math.max(10, options.limit ?? 50));
    const productOffset = Math.min(1_000_000, Math.max(0, options.productOffset ?? 0));
    const productLimit = Math.min(200, Math.max(10, options.productLimit ?? 100));
    const cursor = options.cursor ? this.decodeMovementCursor(options.cursor) : null;
    const [productRows, movementRows, movementTotals] = await Promise.all([
      this.prisma.$queryRaw<Array<SaleRecord & { productCount: number }>>(Prisma.sql`
        SELECT "entityId", COUNT(*) OVER()::int AS "productCount", jsonb_build_object(
          'name', "data"->'name', 'sku', "data"->'sku', 'quantity', "data"->'quantity',
          'minimum_stock', "data"->'minimum_stock', 'unit', "data"->'unit', 'updated_at', "data"->'updated_at'
        ) AS "data"
        FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'products' AND "deletedAt" IS NULL
        ORDER BY lower("data"->>'name'), "entityId"
        LIMIT ${productLimit} OFFSET ${productOffset}
      `),
      this.prisma.$queryRaw<Array<{ entityId: string; data: Prisma.JsonValue; productName: string }>>(Prisma.sql`
        SELECT m."entityId", m."data", COALESCE(p."data"->>'name', m."data"->>'product_name', '—') AS "productName"
        FROM "SyncRecord" m
        LEFT JOIN "SyncRecord" p ON p."businessId" = m."businessId" AND p."entityType" = 'products'
          AND p."entityId" = m."data"->>'product_id' AND p."deletedAt" IS NULL
        WHERE m."businessId" = ${businessId}::uuid AND m."entityType" = 'stock_movements' AND m."deletedAt" IS NULL
          AND (${from}::text IS NULL OR m."data"->>'created_at' >= ${from})
          AND (${to}::text IS NULL OR m."data"->>'created_at' < ${to})
          AND (${cursor?.createdAt ?? null}::text IS NULL OR m."data"->>'created_at' < ${cursor?.createdAt ?? null}
            OR (m."data"->>'created_at' = ${cursor?.createdAt ?? null} AND m."entityId" < ${cursor?.id ?? null}))
        ORDER BY m."data"->>'created_at' DESC, m."entityId" DESC
        LIMIT ${limit + 1}
      `),
      this.prisma.$queryRaw<Array<{ received: number; removed: number; count: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(GREATEST(COALESCE(NULLIF("data"->>'quantity','')::double precision,0),0)),0)::double precision AS received,
          COALESCE(SUM(ABS(LEAST(COALESCE(NULLIF("data"->>'quantity','')::double precision,0),0))),0)::double precision AS removed,
          COUNT(*)::int AS count
        FROM "SyncRecord"
        WHERE "businessId" = ${businessId}::uuid AND "entityType" = 'stock_movements' AND "deletedAt" IS NULL
          AND (${from}::text IS NULL OR "data"->>'created_at' >= ${from})
          AND (${to}::text IS NULL OR "data"->>'created_at' < ${to})
      `),
    ]);

    const products = productRows.map(({ entityId, data }) => {
      const product = record(data);
      return {
        id: entityId, name: String(product.name ?? '—'), sku: String(product.sku ?? ''),
        quantity: num(product.quantity), minimumStock: Math.max(0, num(product.minimum_stock)),
        unit: String(product.unit ?? ''), updatedAt: String(product.updated_at ?? ''),
      };
    });
    const page = movementRows.slice(0, limit);
    const movements = page.map(({ entityId, data, productName }) => {
      const movement = record(data);
      return {
        id: entityId, productName, type: String(movement.type ?? 'ADJUSTMENT'), quantity: num(movement.quantity),
        createdAt: String(movement.created_at ?? ''), reason: String(movement.reason ?? ''),
        userName: String(movement.user_name ?? ''),
      };
    });
    const last = page.at(-1);
    const lastMovement = last ? record(last.data) : {};
    const productCount = productRows[0]?.productCount ?? 0;
    return {
      products,
      productCount,
      nextProductOffset: productOffset + products.length < productCount ? productOffset + products.length : null,
      movements,
      movementTotals: movementTotals[0] ?? { received: 0, removed: 0, count: 0 },
      nextCursor: movementRows.length > limit && last
        ? this.encodeMovementCursor({ createdAt: String(lastMovement.created_at ?? ''), id: last.entityId }) : null,
    };
  }

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

  private encodeMovementCursor(cursor: MovementCursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
  private decodeMovementCursor(token: string): MovementCursor {
    try {
      const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<MovementCursor>;
      if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.id !== 'string' || !value.id.length || value.id.length > 100) throw new Error();
      return { createdAt: value.createdAt, id: value.id };
    } catch { throw new BadRequestException('Invalid stock movement page cursor.'); }
  }
}
