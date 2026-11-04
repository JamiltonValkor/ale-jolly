import {Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Response} from 'express';
import {ZodError} from 'zod';
import {ErrorResponseV1, type ErrorCodeV1} from '../contracts/v1';
import {ServiceError} from '../domain/errors';

/**
 * Toda respuesta de error es `ErrorResponseV1` con un código fijo. Nunca se
 * devuelve ni se registra el mensaje de una dependencia (puede traer tokens).
 */
@Catch()
export class SafeErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(error: unknown, host: ArgumentsHost): void {
    let status = 503;
    let code: ErrorCodeV1 = 'SERVICE_UNAVAILABLE';
    if (error instanceof ServiceError) {status = error.status; code = error.code;}
    else if (error instanceof ZodError) {status = 400; code = 'INVALID_REQUEST';}
    else if (error instanceof Error && 'type' in error && error.type === 'entity.too.large' && 'status' in error && error.status === 413) {status = 413; code = 'INVALID_REQUEST';}
    else if (error instanceof HttpException && [400, 413, 415].includes(error.getStatus())) {status = error.getStatus(); code = 'INVALID_REQUEST';}
    else if (error instanceof HttpException && error.getStatus() === 404) {status = 404; code = 'NOT_FOUND';}
    const requestId = randomUUID();
    if (status >= 500) this.logger.warn(`${code} request_id=${requestId} kind=${error instanceof Error ? error.name : typeof error}`);
    host.switchToHttp().getResponse<Response>()
      .status(status)
      .setHeader('Cache-Control', 'no-store')
      .json(ErrorResponseV1.parse({code, request_id: requestId}));
  }
}
