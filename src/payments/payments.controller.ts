import { Body, Controller, Get, Header, HttpCode, Logger, Module, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ClientIp, Public } from '../common/decorators';
import { SubscriptionsModule } from '../subscriptions/subscriptions.controller';
import { verifyNotchSignature } from './notchpay.util';
import { CreatePaymentDto } from './payments.dto';
import { PaymentsService } from './payments.service';
import { PaymentsSettler } from './payments.settler';

@ApiTags('payments')
@Controller('payments/notchpay')
export class PaymentsController {
  private readonly logger = new Logger('NotchPayWebhook');
  constructor(private readonly payments: PaymentsService, private readonly settler: PaymentsSettler, private readonly config: ConfigService) {}

  /** PUBLIC – the customer never creates an account to subscribe. Rate-limited per IP and per device. */
  @Public() @Post('create') @HttpCode(201) @Throttle({ default: { limit: 8, ttl: 60_000 } })
  create(@Body() dto: CreatePaymentDto, @ClientIp() ip?: string) {
    return this.payments.create(dto, ip);
  }

  /**
   * Notch Pay → backend. Public, signature-checked, and NEVER trusted for the outcome:
   * the transaction is re-fetched from Notch Pay (amount, currency, status, reference) before anything is granted.
   */
  @Public() @Post('webhook') @HttpCode(200) @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async webhook(@Req() req: { rawBody?: Buffer; headers: Record<string, any>; body: any }) {
    const hashKey = this.config.get<string>('NOTCHPAY_HASH_KEY') ?? '';
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (!verifyNotchSignature(raw, req.headers['x-notch-signature'], hashKey)) {
      this.logger.warn('Rejected webhook with invalid signature');
      throw new UnauthorizedException('Invalid signature');
    }
    await this.settler.handleWebhook(req.body);
    return { received: true };
  }

  /** Browser landing page after hosted checkout (informational only; the status is verified server-side). */
  @Public() @Get('callback') @Header('Content-Type', 'text/html; charset=utf-8')
  callback(@Query('status') status?: string) {
    const ok = status !== 'canceled' && status !== 'failed';
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StockFlow AI</title><body style="font-family:system-ui;text-align:center;padding:3rem"><h2>${ok ? 'Merci / Thank you' : 'Paiement annulé / Payment cancelled'}</h2><p>Retournez à l’application / Return to the app.</p></body>`;
  }
}

@Module({ imports: [SubscriptionsModule], controllers: [PaymentsController], providers: [PaymentsService] })
export class PaymentsModule {}
