import {Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req, UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {APPROVALS_SERVICE, type ApprovalsService} from '../approvals/approvals.service';
import {CatalogView, IndustrySlug, ItemId} from '../brain-hub/contracts';
import type {BrainHubService} from '../brain-hub/service';
import {ServiceError} from '../domain/errors';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';
import {BRAIN_HUB_SERVICE} from './brain-hub.controller';
import {InternalTokenGuard, type InternalRequest} from './internal-token.guard';

const BusinessId = z.uuid();
const businessId = (raw: string) => {
  const parsed = BusinessId.safeParse(raw);
  if (!parsed.success) throw new ServiceError('NOT_FOUND', 404);
  return parsed.data;
};
const itemId = (raw: string) => {
  const parsed = ItemId.safeParse(raw);
  if (!parsed.success) throw new ServiceError('NOT_FOUND', 404);
  return parsed.data;
};

export const InstallResponse = z.object({approval_id: z.uuid(), status: z.string()}).strict();

/**
 * Catálogo de habilidades en «Mi asistente» (OSB-016, OSF-004). Instalar o
 * desinstalar no instala nada: crea una aprobación que el dueño confirma en la
 * página de aprobación (OSB-013). La instalación es por VM (usuario).
 */
@Controller('assistants/me')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class SkillsController {
  constructor(
    @Inject(BRAIN_HUB_SERVICE) private readonly brainHub: BrainHubService,
    @Inject(APPROVALS_SERVICE) private readonly approvals: ApprovalsService,
  ) {}

  @Get('businesses/:businessId/skills/catalog')
  @Header('Cache-Control', 'no-store')
  async catalog(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string): Promise<CatalogView> {
    return CatalogView.parse(await this.brainHub.catalogFor(request.principal.userId, businessId(raw)));
  }

  @Post('businesses/:businessId/skills/:itemId/install')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async install(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Param('itemId') item: string) {
    const approval = await this.approvals.propose(request.principal.userId, {business_id: businessId(raw), kind: 'install_skill', item_id: itemId(item)});
    return InstallResponse.parse({approval_id: approval.id, status: approval.status});
  }

  @Post('businesses/:businessId/skills/:itemId/uninstall')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async uninstall(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Param('itemId') item: string) {
    const approval = await this.approvals.propose(request.principal.userId, {business_id: businessId(raw), kind: 'uninstall_skill', item_id: itemId(item)});
    return InstallResponse.parse({approval_id: approval.id, status: approval.status});
  }
}

/** Catálogo para `saleads_list_skill_catalog` (MCP). El MCP manda la industria verificada del negocio. */
@Controller('internal/brain-hub')
@UseGuards(InternalTokenGuard)
export class InternalCatalogController {
  constructor(@Inject(BRAIN_HUB_SERVICE) private readonly brainHub: BrainHubService) {}

  @Get('catalog')
  @Header('Cache-Control', 'no-store')
  async catalog(@Req() request: InternalRequest, @Query('business_id') raw?: string, @Query('industry_slug') industry?: string): Promise<CatalogView> {
    const slug = industry === undefined ? undefined : IndustrySlug.parse(industry);
    return CatalogView.parse(await this.brainHub.catalogFor(request.internalUserId, businessId(raw ?? ''), slug));
  }
}
