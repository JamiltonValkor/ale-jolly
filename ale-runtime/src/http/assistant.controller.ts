import {Controller, Get, Header, Inject, Req, UseGuards} from '@nestjs/common';
import {AssistantStateV1} from '../contracts/v1';
import {ASSISTANT_STATE_READER, type AssistantStateReader} from '../state/assistant-state';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';

/**
 * Controller base de `/assistants/me`. Toda ruta del usuario pasa por el token
 * web (401) y por la bandera (403/503). Las tareas siguientes agregan aquí, o en
 * controllers hermanos con los mismos guards: activación y callback OAuth
 * (OCB-007), proveedores e IA (OCB-010), sesiones y stream (OCB-011), y
 * stop/start/delete (OCB-012).
 */
@Controller('assistants')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class AssistantController {
  constructor(@Inject(ASSISTANT_STATE_READER) private readonly state: AssistantStateReader) {}

  @Get('me')
  @Header('Cache-Control', 'no-store')
  async me(@Req() request: AuthenticatedRequest): Promise<AssistantStateV1> {
    return AssistantStateV1.parse(await this.state.read(request.principal.userId));
  }
}
