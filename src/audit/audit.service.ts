import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  businessId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

const SENSITIVE = /pass(word)?|token|secret|authorization|signature|key/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  constructor(private readonly prisma: PrismaService) {}

  /** Never throws: an audit failure must not break the business operation (it is logged loudly instead). */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          businessId: entry.businessId || null,
          userId: entry.userId && !entry.userId.startsWith('device:') ? entry.userId : null,
          deviceId: entry.deviceId ?? null,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId,
          ip: entry.ip,
          metadata: entry.metadata ? (redact(entry.metadata) as any) : undefined,
        },
      });
      this.logger.log(`${entry.action} user=${entry.userId ?? '-'} entity=${entry.entity ?? '-'}:${entry.entityId ?? '-'}`);
    } catch (e) {
      this.logger.error(`Failed to write audit log for ${entry.action}: ${(e as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
