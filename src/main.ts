import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: needed to verify the Notch Pay webhook signature over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const prod = process.env.NODE_ENV === 'production';

  app.set('trust proxy', 1); // correct client IP behind the hosting proxy (rate limiting, audit)
  app.use(helmet());
  app.useBodyParser('json', { limit: '10mb' }); // 10 MB: shelf photos for AI store scanning
  // The Tauri webview calls this API with fetch(), so CORS must allow its origins (X-Device-Id is reflected automatically).
  const origins = (process.env.CORS_ORIGINS ?? 'tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420,http://localhost:5173,https://stockai-online.vercel.app')
    .split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins, credentials: false /* bearer tokens, no cookies */ });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  if (!prod || process.env.SWAGGER === 'true') {
    const doc = new DocumentBuilder()
      .setTitle('Inventory Management System – Cloud API')
      .setDescription('Auth, RBAC, Cloud Sync (Premium), subscriptions & Notch Pay, AI services.')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on :${port} (${prod ? 'production' : 'development'})`);
}
bootstrap();
