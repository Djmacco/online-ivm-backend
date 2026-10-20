import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { mapNotchStatus } from './notchpay.util';

export type PaymentOutcome = 'PENDING' | 'COMPLETE' | 'FAILED' | 'CANCELED';

/**
 * THE trust boundary for money. Premium is granted only here, and only after the transaction has been
 * re-fetched from Notch Pay with our secret key. Neither the desktop nor a webhook body is trusted.
 */
@Injectable()
export class PaymentsSettler {
  private readonly logger = new Logger('Payments');
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly subs: SubscriptionsService,
    private readonly audit: AuditService,
  ) {}

  async referenceBelongsToDevice(reference: string, deviceId: string): Promise<boolean> {
    return !!(await this.prisma.payment.findFirst({ where: { reference, deviceId }, select: { id: true } }));
  }

  /** Polling path: only touches Notch Pay while the payment is still PENDING. */
  async settleIfPending(reference: string, deviceId: string): Promise<void> {
    const p = await this.prisma.payment.findFirst({ where: { reference, deviceId } });
    if (p?.status === 'PENDING') await this.verifyAndSettle(p.reference);
  }

  /** Idempotent: replays / double webhooks / polling races cannot extend the subscription twice. */
  async verifyAndSettle(candidateRef: string): Promise<PaymentOutcome> {
    const payment = await this.prisma.payment.findFirst({ where: { OR: [{ reference: candidateRef }, { notchReference: candidateRef }] } });
    if (!payment) throw new NotFoundException('Unknown payment reference.');
    if (payment.status !== 'PENDING') return payment.status;

    let tx: any;
    try {
      const res = await this.notch<any>('GET', `/payments/${encodeURIComponent(payment.notchReference ?? payment.reference)}`, undefined, 'secret');
      tx = res?.transaction;
    } catch (e) {
      this.logger.warn(`Verification call failed for ${payment.reference}: ${(e as Error).message}`);
      return 'PENDING'; // retried on the next poll / webhook
    }
    if (!tx) return 'PENDING';

    const status = mapNotchStatus(tx.status);
    if (status === 'complete') {
      const amountOk = Number(tx.amount) === payment.amount;
      const currencyOk = String(tx.currency ?? payment.currency).toUpperCase() === payment.currency;
      const refOk = [tx.trxref, tx.merchant_reference, tx.reference].some((r) => r && (r === payment.reference || r === payment.notchReference));
      if (!amountOk || !currencyOk || !refOk) {
        await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', rawProviderState: { mismatch: true, amount: tx.amount, currency: tx.currency } } });
        await this.audit.log({ deviceId: payment.deviceId, action: 'payment.verification_mismatch', entity: 'payment', entityId: payment.id, metadata: { amountOk, currencyOk, refOk } });
        this.logger.error(`SECURITY: payment ${payment.reference} verification mismatch – Premium NOT granted`);
        return 'FAILED';
      }
      // Atomic claim: only one caller flips PENDING→COMPLETE and activates the subscription.
      const activated = await this.prisma.$transaction(async (db) => {
        const claim = await db.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'COMPLETE', completedAt: new Date(), rawProviderState: { status: tx.status, completed_at: tx.completed_at ?? null } },
        });
        if (claim.count === 0) return false;
        await this.subs.activate(db, { deviceId: payment.deviceId, amount: payment.amount, currency: payment.currency, transactionId: payment.notchReference ?? payment.reference });
        return true;
      });
      if (activated) await this.audit.log({ deviceId: payment.deviceId, action: 'subscription.activated', entity: 'payment', entityId: payment.id, metadata: { amount: payment.amount, provider: 'NOTCHPAY' } });
      return 'COMPLETE';
    }
    if (status === 'failed' || status === 'canceled') {
      const next = status === 'failed' ? 'FAILED' : 'CANCELED';
      await this.prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: next } });
      await this.audit.log({ deviceId: payment.deviceId, action: `payment.${next.toLowerCase()}`, entity: 'payment', entityId: payment.id });
      return next;
    }
    return 'PENDING';
  }

  /** Webhook entry: collect every reference in the event and verify each against Notch Pay. */
  async handleWebhook(event: any): Promise<void> {
    const d = event?.data ?? event?.transaction ?? event ?? {};
    const refs = [d.merchant_reference, d.trxref, d.reference, d.transaction?.reference, d.transaction?.trxref].filter((r): r is string => typeof r === 'string' && r.length > 0);
    for (const ref of new Set(refs)) {
      try { await this.verifyAndSettle(ref); return; } catch (e) { if (!(e instanceof NotFoundException)) throw e; }
    }
    this.logger.warn(`Webhook for unknown payment (refs: ${refs.join(',') || 'none'})`);
  }

  // ───────────── Notch Pay HTTP ─────────────
  async notch<T>(method: 'GET' | 'POST', path: string, body: unknown, key: 'public' | 'secret'): Promise<T> {
    const base = this.config.get<string>('NOTCHPAY_API_URL') ?? 'https://api.notchpay.co';
    const pub = this.config.getOrThrow<string>('NOTCHPAY_PUBLIC_KEY');
    const apiKey = key === 'secret' ? this.config.get<string>('NOTCHPAY_SECRET_KEY') || pub : pub;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Notch Pay ${method} ${path} → ${res.status} ${json?.message ?? ''}`);
    return json as T;
  }
}
