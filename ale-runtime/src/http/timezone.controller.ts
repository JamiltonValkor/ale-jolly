import {Body, Controller, Header, HttpCode, Inject, Put, Req, UseGuards} from '@nestjs/common';
import {TIMEZONE_SERVICE, type TimezoneService} from '../assistant-config/timezone.service';
import {AssistantStateV1, TimezoneRequestV1} from '../contracts/v1';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';

/** Zona horaria del dueño (OCB-016). Mismos guards que /assistants/me. */
@Controller('assistants')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class TimezoneController {
  constructor(@Inject(TIMEZONE_SERVICE) private readonly timezones: TimezoneService) {}

  @Put('me/timezone')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async update(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<AssistantStateV1> {
    const input = TimezoneRequestV1.parse(body);
    return AssistantStateV1.parse(await this.timezones.update(request.principal.userId, input));
  }
}
