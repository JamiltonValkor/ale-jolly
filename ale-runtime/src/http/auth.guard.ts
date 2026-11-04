import {Injectable, type CanActivate, type ExecutionContext} from '@nestjs/common';
import type {Request} from 'express';
import type {Principal} from '../domain/ports';
import {IdentityVerifier} from '../security/identity';

// Copiado de 9282e1b:src/http/auth.guard.ts:1-15.
export type AuthenticatedRequest = Request & {principal: Principal};
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly identity: IdentityVerifier) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.principal = await this.identity.verify(request.headers.authorization);
    return true;
  }
}
