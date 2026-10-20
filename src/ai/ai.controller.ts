import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AllowDeviceToken, ClientIp, CurrentUser, Permissions, RequireFeature } from '../common/decorators';
import { Feature } from '../common/features';
import { AuthUser } from '../common/types';
import { AssistantExecuteDto, StoreScanDto } from './ai.dto';
import { AiService } from './ai.service';
import { createLlmProvider } from './llm.factory';
import { LLM_PROVIDER } from './llm.types';
import { SubscriptionsModule } from '../subscriptions/subscriptions.controller';

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** FREE. Cloud LLM for the assistant/voice features; tools run on the desktop, writes need user confirmation. */
  @Post('execute') @HttpCode(200) @Permissions('ai.use') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  execute(@CurrentUser() user: AuthUser, @Body() dto: AssistantExecuteDto, @ClientIp() ip?: string) {
    return this.ai.assistant(user, dto, ip);
  }

  /** PREMIUM (AI_STORE_SCAN) for the calling device. Account JWT or device token. Returns detections only. */
  @AllowDeviceToken() @Post('store-scan') @HttpCode(200) @RequireFeature(Feature.AI_STORE_SCAN) @Permissions('ai.store_scan') @Throttle({ default: { limit: 6, ttl: 60_000 } })
  storeScan(@CurrentUser() user: AuthUser, @Body() dto: StoreScanDto, @ClientIp() ip?: string) {
    return this.ai.storeScan(user, dto, ip);
  }
}

@Module({
  imports: [SubscriptionsModule],
  controllers: [AiController],
  providers: [
    // AI_PROVIDER = gemini (default) | anthropic. Built once from the environment.
    { provide: LLM_PROVIDER, inject: [ConfigService], useFactory: (c: ConfigService) => createLlmProvider((k) => c.get<string>(k)) },
    AiService,
  ],
})
export class AiModule {}
