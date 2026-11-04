import {Body, Controller, Get, Header, HttpCode, Inject, Optional, Put, Req, UseGuards} from '@nestjs/common';
import {AI_CONFIG_SERVICE, type AiConfigService} from '../ai/ai-config.service';
import {providersResponse} from '../ai/providers';
import {isManagedMetaUser, MANAGED_META_MODE, type ManagedMetaScope} from '../ai/meta-model';
import {invalidRequest} from '../domain/errors';
import {AiConfigRequestV1, AiConfigResponseV1, ProvidersResponseV1} from '../contracts/v1';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';

/**
 * Proveedores e IA del asistente (OCB-010). Mismos guards que /assistants/me.
 * El body del PUT lleva la key del dueño: nunca se registra ni se devuelve, y
 * un body inválido responde el error fijo de SafeErrorFilter (sin el detalle de zod).
 */
@Controller('assistants')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class AiController {
  constructor(
    @Inject(AI_CONFIG_SERVICE) private readonly ai: AiConfigService,
    @Optional() @Inject(MANAGED_META_MODE) private readonly managedMeta?: ManagedMetaScope,
  ) {}

  @Get('me/providers')
  @Header('Cache-Control', 'no-store')
  providers(@Req() request: AuthenticatedRequest): ProvidersResponseV1 {
    return ProvidersResponseV1.parse(providersResponse(isManagedMetaUser(this.managedMeta, request.principal.userId)));
  }

  @Put('me/ai')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async configure(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<AiConfigResponseV1> {
    if (isManagedMetaUser(this.managedMeta, request.principal.userId)) throw invalidRequest();
    const input = AiConfigRequestV1.parse(body);
    return AiConfigResponseV1.parse(await this.ai.configure(request.principal.userId, input));
  }
}
