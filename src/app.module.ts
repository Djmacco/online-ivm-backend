import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AiModule } from './ai/ai.controller';
import { AuditApiModule } from './audit/audit.controller';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { AuthGuard, FeatureGuard, PermissionsGuard } from './common/guards';
import { validateEnv } from './config/env';
import { DevicesModule } from './devices/devices.controller';
import { HealthModule } from './health/health.controller';
import { PaymentsModule } from './payments/payments.controller';
import { PrismaModule } from './prisma/prisma.service';
import { SubscriptionsModule } from './subscriptions/subscriptions.controller';
import { SyncModule } from './sync/sync.controller';
import { UsersModule } from './users/users.controller';
import { MonitoringModule } from './monitoring/monitoring.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    JwtModule.register({ global: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule, AuditModule, AuditApiModule,
    AuthModule, UsersModule, DevicesModule,
    SubscriptionsModule, PaymentsModule,
    SyncModule, MonitoringModule,
    AiModule, HealthModule,
  ],
  providers: [
    // Order matters: rate-limit → authenticate → RBAC → Premium entitlement.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
  ],
})
export class AppModule {}
