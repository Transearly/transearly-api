import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { configSwagger } from './configs/api-docs.config';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { Request, Response } from 'express';

let cachedApp: NestExpressApplication;

async function createApp() {
  const logger = new Logger('NestApplication');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: true,
  });

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new ResponseInterceptor(reflector));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: '*',
  });

  configSwagger(app);
  app.useStaticAssets(join(__dirname, './served'));

  await app.init();
  logger.log(`✅ NestJS initialized`);
  return app;
}

/**
 * ✅ Handler cho Vercel (Serverless)
 */
export default async function handler(req: Request, res: Response) {
  if (!cachedApp) {
    cachedApp = await createApp();
  }
  const expressApp = cachedApp.getHttpAdapter().getInstance();
  return expressApp(req, res);
}

/**
 * ✅ Nếu chạy local => bật app.listen()
 */
if (!process.env.VERCEL) {
  (async () => {
    const app = await createApp();
    const port = process.env.PORT || 4000;
    await app.listen(port);
    console.log(`🚀 Server running at http://localhost:${port}/api-docs`);
  })();
}
