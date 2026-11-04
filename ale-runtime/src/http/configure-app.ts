import type {INestApplication} from '@nestjs/common';
import {json} from 'express';
import {SafeErrorFilter} from './error.filter';
import {MAX_META_RELAY_BODY_BYTES} from '../ai/meta-model';

/** Configuración HTTP compartida por main.ts y los tests e2e. */
export function configureApp(app: INestApplication): INestApplication {
  // Responses includes native tool schemas and context; unrelated public routes keep their existing bound.
  app.use('/meta-inference/v1/responses', json({limit: MAX_META_RELAY_BODY_BYTES, strict: true}));
  app.use(json({limit: 131072, strict: true}));
  app.useGlobalFilters(new SafeErrorFilter());
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
