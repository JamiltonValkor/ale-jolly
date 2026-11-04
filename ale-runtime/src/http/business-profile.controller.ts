import {Body, Controller, Get, Header, HttpCode, Inject, Param, Put, Req, UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {BUSINESS_PROFILE_SERVICE, type BusinessProfileService} from '../business-profile/business-profile.service';
import {BusinessProfileUpdateRequestV1, BusinessProfileV1} from '../contracts/v1';
import {notFound} from '../domain/errors';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';

const BusinessId = z.uuid();

/** Un id inválido se responde igual que un negocio ajeno: 404. */
function businessIdOf(raw: string): string {
  const parsed = BusinessId.safeParse(raw);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/**
 * Tipo de negocio del equipo de marketing (MLB-002, MLF-001). `Idempotency-Key`
 * se acepta sin exigirla: el PUT es idempotente por naturaleza.
 */
@Controller('assistants/me/businesses/:businessId/profile')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class BusinessProfileController {
  constructor(@Inject(BUSINESS_PROFILE_SERVICE) private readonly profiles: BusinessProfileService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string): Promise<BusinessProfileV1> {
    return BusinessProfileV1.parse(await this.profiles.get(request.principal.userId, businessIdOf(raw)));
  }

  @Put()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async put(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Body() body: unknown): Promise<BusinessProfileV1> {
    const business = businessIdOf(raw);
    const input = BusinessProfileUpdateRequestV1.parse(body);
    return BusinessProfileV1.parse(await this.profiles.update(request.principal.userId, business, input.business_type));
  }
}
