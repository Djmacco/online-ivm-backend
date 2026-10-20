import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Module, Query } from '@nestjs/common';
import { Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ClientIp, CurrentUser, RequireFeature } from '../common/decorators';
import { Feature } from '../common/features';
import { AuthUser } from '../common/types';
import { SubscriptionsModule } from '../subscriptions/subscriptions.controller';
import { PullQueryDto, PushDto, RestoreQueryDto } from './sync.dto';
import { SyncService } from './sync.service';

/** Account JWT only. push/pull need Premium (CLOUD_SYNC, enforced server-side for the calling DEVICE); restore is free but time-boxed. */
@ApiTags('sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @RequireFeature(Feature.CLOUD_SYNC) @Post('push') @HttpCode(200) @Throttle({ default: { limit: 60, ttl: 60_000 } })
  push(@CurrentUser() user: AuthUser, @Body() dto: PushDto, @ClientIp() ip?: string) {
    if (dto.deviceId !== user.deviceId) throw new ForbiddenException({ code: 'DEVICE_MISMATCH', message: 'deviceId does not match the signed-in device.' });
    return this.sync.push(user, dto.changes, ip);
  }

  @RequireFeature(Feature.CLOUD_SYNC) @Get('pull') @Throttle({ default: { limit: 120, ttl: 60_000 } })
  pull(@CurrentUser() user: AuthUser, @Query() q: PullQueryDto) {
    const since = q.since ?? '0';
    if (!/^\d{1,18}$/.test(since)) throw new BadRequestException('since must be a numeric cursor.');
    if (q.deviceId && q.deviceId !== user.deviceId) throw new ForbiddenException({ code: 'DEVICE_MISMATCH', message: 'deviceId does not match the signed-in device.' });
    const limit = parseInt(q.limit ?? '200', 10);
    return this.sync.pull(user, BigInt(since), Number.isFinite(limit) ? limit : 200);
  }

  /**
   * FREE restore of the current state for a new/replacement computer (no Premium needed, time-boxed). Page through it with `after`
   * until `hasMore` is false, then keep `snapshotCursor` as the sync cursor.
   */
  @Get('restore') @Throttle({ default: { limit: 60, ttl: 60_000 } })
  restore(@CurrentUser() user: AuthUser, @Query() q: RestoreQueryDto, @ClientIp() ip?: string) {
    if (q.deviceId && q.deviceId !== user.deviceId) throw new ForbiddenException({ code: 'DEVICE_MISMATCH', message: 'deviceId does not match the signed-in device.' });
    const limit = parseInt(q.limit ?? '200', 10);
    return this.sync.restore(user, q.after || undefined, Number.isFinite(limit) ? limit : 200, ip);
  }
}

@Module({ imports: [SubscriptionsModule], controllers: [SyncController], providers: [SyncService], exports: [SyncService] })
export class SyncModule {}
