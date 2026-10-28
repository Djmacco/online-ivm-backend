import { Body, Controller, Delete, ForbiddenException, Get, Header, Module, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PaymentsSettler } from '../payments/payments.settler';
import { AllowDeviceToken, CurrentUser, OptionalAuth, Permissions, Public } from '../common/decorators';
import { AuthUser } from '../common/types';
import { SubscriptionsService } from './subscriptions.service';
import { ShareDevicesDto } from './subscriptions.dto';

@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService, private readonly settler: PaymentsSettler) {}

  /** Current one-time shop trial status for the signed-in main PC. */
  @ApiBearerAuth() @Get('trial') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  trialStatus(@CurrentUser() user: AuthUser) {
    return this.subs.trialStatus(user);
  }

  /** Explicitly start the shop's one 30-minute two-way cloud sync trial. */
  @ApiBearerAuth() @Permissions('subscription.manage') @Post('trial/sync') @Throttle({ default: { limit: 5, ttl: 60_000 } })
  startSyncTrial(@CurrentUser() user: AuthUser) {
    return this.subs.startSyncTrial(user);
  }

  /**
   * Authorised by ANY of: the unguessable payment `reference` (+ matching deviceId), the device token, or an account JWT.
   * Polled by the desktop every 4 s after a payment and silently every 15 min (renewal / revocation).
   */
  @ApiBearerAuth() @OptionalAuth() @Get('status') @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async status(@CurrentUser() user: AuthUser | undefined, @Query('deviceId') deviceId?: string, @Query('reference') reference?: string) {
    let device: string;
    if (user) {
      if (deviceId && deviceId !== user.deviceId) throw new ForbiddenException({ code: 'DEVICE_MISMATCH', message: 'deviceId does not match the token.' });
      device = user.deviceId;
    } else if (reference && deviceId) {
      device = deviceId; // proven by knowing the secret reference that belongs to this device (checked below)
      const owns = await this.settler.referenceBelongsToDevice(reference, deviceId);
      if (!owns) throw new UnauthorizedException('Unknown payment reference.');
    } else {
      throw new UnauthorizedException('Authentication required.');
    }
    if (reference) await this.settler.settleIfPending(reference, device); // re-verifies with Notch Pay before answering
    return this.subs.statusFor(device, reference);
  }

  /** Ed25519 PUBLIC key as hex (what the desktop embeds as VITE_ENTITLEMENT_PUBLIC_KEY). Safe to publish. */
  @Public() @Get('public-key') @Header('Cache-Control', 'public, max-age=3600')
  publicKey() {
    return { algorithm: 'Ed25519', format: 'hex', publicKey: this.subs.publicKeyHex() };
  }

  /** The paid main PC can share its active plan with at most nine paired devices. */
  @ApiBearerAuth() @AllowDeviceToken() @Post('share') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  share(@CurrentUser() user: AuthUser, @Body() dto: ShareDevicesDto) {
    return this.subs.shareDevices(user.deviceId, dto.deviceIds);
  }

  /** A shop administrator may authorize this signed-in browser device for the shop's existing paid plan. */
  @ApiBearerAuth() @Permissions('subscription.manage') @Post('share/web') @Throttle({ default: { limit: 5, ttl: 60_000 } })
  shareWebDevice(@CurrentUser() user: AuthUser) {
    return this.subs.shareWebDevice(user);
  }

  /** Stop sharing with a device removed from the shop network. Only the original owner can remove its share. */
  @ApiBearerAuth() @AllowDeviceToken() @Delete('share/:deviceId') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async unshare(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string) {
    return { success: await this.subs.unshareDevice(user.deviceId, deviceId) };
  }
}

@Module({ controllers: [SubscriptionsController], providers: [SubscriptionsService, PaymentsSettler], exports: [SubscriptionsService, PaymentsSettler] })
export class SubscriptionsModule {}
