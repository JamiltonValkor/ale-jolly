import {Inject, Injectable, type CanActivate, type ExecutionContext} from '@nestjs/common';
import {assistantNotEnabled} from '../domain/errors';
import type {AssistantFlag} from '../domain/ports';
import type {AuthenticatedRequest} from './auth.guard';

export const ASSISTANT_FLAG = Symbol('ASSISTANT_FLAG');

/** Va después de AuthGuard: sin bandera → 403; PostHog sin respuesta booleana → 503. */
@Injectable()
export class AssistantFlagGuard implements CanActivate {
  constructor(@Inject(ASSISTANT_FLAG) private readonly flag: AssistantFlag) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!(await this.flag.isEnabled(request.principal.userId))) throw assistantNotEnabled();
    return true;
  }
}
