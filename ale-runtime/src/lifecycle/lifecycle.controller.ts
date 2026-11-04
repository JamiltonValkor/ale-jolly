import {Controller, Delete, Header, HttpCode, Inject, Post, Req, UseGuards} from '@nestjs/common';
import {AssistantStateV1} from '../contracts/v1';
import {AssistantFlagGuard} from '../http/assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from '../http/auth.guard';
import {LIFECYCLE_SERVICE, type LifecycleService} from './lifecycle.service';

/**
 * Desactivar, reactivar y borrar (OCB-012). Mismos guards que /assistants/me:
 * token web (401) y bandera (403/503). Las tres responden 200 con
 * `AssistantStateV1` (supuesto del BFF, OCF-002/006):
 * stop → stopped · start → activating · DELETE → deleting (luego none).
 * Sin asistente: stop/start → 404 NOT_FOUND; DELETE → 200 status=none.
 */
@Controller('assistants')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class LifecycleController {
  constructor(@Inject(LIFECYCLE_SERVICE) private readonly lifecycle: LifecycleService) {}

  @Post('me/stop')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async stop(@Req() request: AuthenticatedRequest): Promise<AssistantStateV1> {
    return AssistantStateV1.parse(await this.lifecycle.stop(request.principal.userId));
  }

  @Post('me/start')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async start(@Req() request: AuthenticatedRequest): Promise<AssistantStateV1> {
    return AssistantStateV1.parse(await this.lifecycle.start(request.principal.userId));
  }

  @Delete('me')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async remove(@Req() request: AuthenticatedRequest): Promise<AssistantStateV1> {
    return AssistantStateV1.parse(await this.lifecycle.remove(request.principal.userId));
  }
}
