import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, Permissions } from '../common/decorators';
import { AuthUser } from '../common/types';
import { MonitoringService } from './monitoring.service';

class TransactionQuery {
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsString() @MaxLength(40) @Matches(/^[a-zA-Z0-9_-]+$/) paymentMethod?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsString() @MaxLength(300) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(100) limit?: number;
}

@ApiTags('company monitoring')
@ApiBearerAuth()
@Controller('company')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  /** Read-only transaction monitor for the business administrator's web dashboard. */
  @Permissions('sales.read')
  @Get('transactions')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  transactions(@CurrentUser() user: AuthUser, @Query() query: TransactionQuery) {
    return this.monitoring.transactions(user, query);
  }
}
