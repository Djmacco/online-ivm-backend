import { BadGatewayException, BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { sha256 } from '../auth/principal.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { normalizeCameroonPhone } from './notchpay.util';
import { CreatePaymentDto } from './payments.dto';
import { PaymentsSettler } from './payments.settler';

const CHANNEL = { MTN_MOMO: 'cm.mtn', ORANGE_MONEY: 'cm.orange' } as const;
const MAX_ATTEMPTS_PER_DEVICE = 5; // per 10 minutes

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly subs: SubscriptionsService,
    private readonly settler: PaymentsSettler,
    private readonly audit: AuditService,
  ) {}

  /**
   * Public (no account). Starts a Notch Pay mobile-money charge: the customer receives the PIN prompt on their phone.
   * The PRICE is decided here, never by the client.
   */
  async create(dto: CreatePaymentDto, ip?: string) {
    const phone = normalizeCameroonPhone(dto.phone);
    if (!phone) throw new BadRequestException('Enter a valid Cameroonian mobile number (6XXXXXXXX).');

    const recent = await this.prisma.payment.count({ where: { deviceId: dto.deviceId, createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } });
    if (recent >= MAX_ATTEMPTS_PER_DEVICE) throw new HttpException('Too many payment attempts. Please wait a few minutes.', HttpStatus.TOO_MANY_REQUESTS);

    const amount = this.subs.price();
    const reference = `IMS-${randomBytes(16).toString('hex')}`.toUpperCase(); // 128-bit: unguessable, doubles as the polling secret
    const payment = await this.prisma.payment.create({ data: { deviceId: dto.deviceId, reference, provider: dto.provider, amount, currency: 'XAF', phone } });

    try {
      const init = await this.settler.notch<any>('POST', '/payments', {
        amount, currency: 'XAF', reference,
        description: 'StockFlow AI Premium – 1 month',
        customer: { name: 'StockFlow customer', email: this.config.get<string>('PAYMENT_CUSTOMER_EMAIL') ?? 'payments@stockflow.invalid', phone },
        callback: `${this.config.get('PUBLIC_API_URL') ?? ''}/payments/notchpay/callback`,
        metadata: { paymentId: payment.id },
      }, 'public');
      const notchReference: string | undefined = init?.transaction?.reference;
      if (!notchReference) throw new Error('Notch Pay did not return a transaction reference');
      await this.prisma.payment.update({ where: { id: payment.id }, data: { notchReference } });

      // Triggers the MoMo / Orange Money PIN prompt on the customer's phone.
      await this.settler.notch('POST', `/payments/${encodeURIComponent(notchReference)}`, { channel: CHANNEL[dto.provider], data: { phone, account_number: phone } }, 'public');

      const deviceToken = await this.ensureDeviceToken(dto.deviceId);
      await this.audit.log({ deviceId: dto.deviceId, action: 'payment.initiated', entity: 'payment', entityId: payment.id, ip, metadata: { amount, provider: dto.provider } });
      return {
        reference, status: 'PENDING' as const,
        message: 'Approve the payment on your phone. Premium activates automatically.',
        authorizationUrl: init?.authorization_url ?? undefined,
        ...(deviceToken ? { deviceToken } : {}),
      };
    } catch (e) {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
      this.logger.error(`Payment initiation failed (${payment.id}): ${(e as Error).message}`);
      throw new BadGatewayException('Could not start the payment. Nothing was charged. Please try again.');
    }
  }

  /** The long-lived secret is returned ONCE (first payment from this device) and only its hash is stored. */
  private async ensureDeviceToken(deviceId: string): Promise<string | null> {
    if (await this.prisma.premiumDevice.findUnique({ where: { deviceId } })) return null;
    const token = randomBytes(32).toString('base64url');
    try {
      await this.prisma.premiumDevice.create({ data: { deviceId, tokenHash: sha256(token) } });
      return token;
    } catch {
      return null; // lost a race with a parallel request – the other one returned the token
    }
  }
}
