/**
 * Integration harness: runs the REAL backend (all modules, guards, pipes) with an in-memory database so the
 * desktop app's own SyncEngine / CloudClient can be tested against it over HTTP.
 *   PORT, ENTITLEMENT_PRIVATE_KEY, JWT_SECRET come from the environment.
 *   STATE_FILE = JSON { premium: string[], tokens: { [deviceToken]: deviceId } } (re-read on every call → tests can flip Premium live)
 */
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { FakePrisma } from './fake-prisma';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const state = () => { try { return JSON.parse(readFileSync(process.env.STATE_FILE!, 'utf8')); } catch { return { premium: [], tokens: {} }; } };

class Db extends FakePrisma {
  user = { findUnique: async ({ where }: any) => ({ id: where.id, businessId: 'biz-1', email: 'owner@shop.cm', fullName: 'Owner', role: 'ADMIN', permissions: [], isActive: true }) };
  device = { findUnique: async ({ where }: any) => ({ id: where.id, businessId: 'biz-1', revokedAt: null }) };
  premiumDevice = {
    findUnique: async ({ where }: any) => {
      const hit = Object.entries(state().tokens as Record<string, string>).find(([t]) => sha(t) === where.tokenHash);
      return hit ? { deviceId: hit[1] } : null;
    },
  };
  subscription = {
    updateMany: async () => ({ count: 0 }),
    findFirst: async ({ where }: any) => (state().premium.includes(where.deviceId)
      ? { id: 's', userId: null, startedAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() + 20 * 86_400_000) } : null),
  };
  payment = { findFirst: async () => null, count: async () => 0 };
  auditLog = { create: async () => ({}) };
}

(async () => {
  const { AppModule } = await import('../src/app.module');
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(new Db()).compile();
  const app = mod.createNestApplication({ rawBody: true });
  app.enableCors({ origin: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(Number(process.env.PORT));
  console.log('READY');
})();
