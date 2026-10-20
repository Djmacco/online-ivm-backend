/** Minimal in-memory Prisma double covering exactly what SyncService uses. */
export class FakePrisma {
  records = new Map<string, any>();
  changes: any[] = [];
  ops = new Map<string, any>();
  private seq = 0;

  private k = (w: any) => Object.values(w).join('|');

  syncRecord = {
    findUnique: async ({ where }: any) => {
      const w = where.businessId_entityType_entityId;
      return this.records.get(`${w.businessId}|${w.entityType}|${w.entityId}`) ?? null;
    },
    findFirst: async ({ where }: any) => [...this.records.values()].find((r) => r.businessId === where.businessId) ?? null,
    findMany: async ({ where, orderBy, take }: any) => {
      const rows = [...this.records.values()].filter((r) => r.businessId === where.businessId && r.entityType === where.entityType && (!where.entityId?.gt || r.entityId > where.entityId.gt));
      rows.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
      void orderBy;
      return rows.slice(0, take);
    },
    upsert: async ({ where, create, update }: any) => {
      const w = where.businessId_entityType_entityId;
      const key = `${w.businessId}|${w.entityType}|${w.entityId}`;
      const prev = this.records.get(key);
      const row = prev ? { ...prev, ...update, updatedAt: new Date() } : { ...create, createdAt: new Date(), updatedAt: new Date() };
      this.records.set(key, row);
      return row;
    },
  };
  syncChange = {
    create: async ({ data }: any) => {
      const row = { ...data, serverSeq: BigInt(++this.seq), createdAt: new Date() };
      this.changes.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => {
      const w = where.businessId_entityType_entityId_version;
      return this.changes.find((c) => c.businessId === w.businessId && c.entityType === w.entityType && c.entityId === w.entityId && c.version === w.version) ?? null;
    },
    findMany: async ({ where, take }: any) =>
      this.changes.filter((c) => c.businessId === where.businessId && c.serverSeq > where.serverSeq.gt && !(where.entityType?.notIn ?? []).includes(c.entityType)).slice(0, take),
    findFirst: async ({ where }: any) => [...this.changes].reverse().find((c) => c.businessId === where.businessId) ?? null,
  };
  syncOperation = {
    findUnique: async ({ where }: any) => this.ops.get(`${where.businessId_opId.businessId}|${where.businessId_opId.opId}`) ?? null,
    create: async ({ data }: any) => { this.ops.set(`${data.businessId}|${data.opId}`, data); return data; },
  };

  grants = new Map<string, any>();
  restoreGrant = {
    findUnique: async ({ where }: any) => this.grants.get(where.deviceId) ?? null,
    count: async ({ where }: any) => [...this.grants.values()].filter((g) => g.businessId === where.businessId && g.firstAt > where.firstAt.gt).length,
    create: async ({ data }: any) => { const g = { firstAt: new Date(), lastAt: new Date(), ...data }; this.grants.set(data.deviceId, g); return g; },
    update: async ({ where, data }: any) => Object.assign(this.grants.get(where.deviceId), data),
  };

  // The subscription service consults this relation even when a device has no shared Premium plan.
  // Keep the default test double explicit so guard tests exercise the real 402 path, not a fake-DB 500.
  premiumShare = {
    findUnique: async () => null,
    count: async () => 0,
    upsert: async ({ create }: any) => create,
    deleteMany: async () => ({ count: 0 }),
  };

  $queryRaw = async () => [];
  $transaction = async (cb: (tx: any) => Promise<any>) => cb(this);
}

export const fakeAudit = { log: async () => undefined } as any;
