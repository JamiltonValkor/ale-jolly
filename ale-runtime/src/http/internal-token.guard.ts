import {Inject, Injectable, type CanActivate, type ExecutionContext} from '@nestjs/common';
import {timingSafeEqual} from 'node:crypto';
import type {Request} from 'express';
import {serviceUnavailable, unauthorized} from '../domain/errors';

export const INTERNAL_API_TOKEN = Symbol('INTERNAL_API_TOKEN');

/** Petición interna ya autenticada: `x-user-id` lo asserta el MCP, que verificó la propiedad. */
export type InternalRequest = Request & {internalUserId: string};

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

/**
 * Rutas `/internal/…` que solo llama el MCP (ORQA cliente, OSB-013).
 * Envoy niega `/internal` en el borde y quita `x-internal-api-token`; aquí se
 * exige el token en tiempo constante y un `x-user-id` válido. Sin token
 * configurado, las rutas responden 503.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(INTERNAL_API_TOKEN) private readonly token: string) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.token) throw serviceUnavailable();
    const request = context.switchToHttp().getRequest<InternalRequest>();
    const presented = request.headers['x-internal-api-token'];
    const userId = request.headers['x-user-id'];
    if (typeof presented !== 'string' || !safeEqual(presented, this.token)) throw unauthorized();
    if (typeof userId !== 'string' || !USER_ID.test(userId)) throw unauthorized();
    request.internalUserId = userId;
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
