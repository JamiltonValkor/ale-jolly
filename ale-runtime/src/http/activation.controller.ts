import {Body, Controller, Header, Headers, HttpCode, Inject, Post, Req, UseGuards} from '@nestjs/common';
import {ActivationRequestV1, ActivationResponseV1, OAuthCallbackRequestV1, OAuthCallbackResponseV1} from '../contracts/v1';
import {ACTIVATION_SERVICE, type ActivationService} from '../activation/activation.service';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';

/**
 * Activación y callback OAuth (OCB-007). Mismos guards que /assistants/me:
 * token web (401) y bandera (403/503). El body del callback nunca se registra.
 */
@Controller('assistants')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class ActivationController {
  constructor(@Inject(ACTIVATION_SERVICE) private readonly activation: ActivationService) {}

  @Post('me/activation')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async activate(
    @Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: unknown, @Body() body: unknown,
  ): Promise<ActivationResponseV1> {
    // Cuerpo opcional (OCB-016): sin cuerpo, express deja `{}` o undefined.
    const input = ActivationRequestV1.parse(body ?? {});
    return ActivationResponseV1.parse(await this.activation.activate(request.principal.userId, key, input));
  }

  @Post('oauth/callback')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async callback(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<OAuthCallbackResponseV1> {
    const input = OAuthCallbackRequestV1.parse(body);
    return OAuthCallbackResponseV1.parse(await this.activation.callback(request.principal.userId, input));
  }
}
