import {Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {
  AdminCatalogResponse, AdminLessonsResponse, IndustrySlug, ItemId, LessonShareRequest, LessonShareResponse, OwnerLessonsResponse, PublishRequest,
  PublishResponse, SharingPreference, SharingUpdateRequest,
} from '../brain-hub/contracts';
import {BrainHubError} from '../brain-hub/errors';
import type {BrainHubService} from '../brain-hub/service';
import {ServiceError} from '../domain/errors';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';
import {InternalTokenGuard, type InternalRequest} from './internal-token.guard';

export const BRAIN_HUB_SERVICE = Symbol('BRAIN_HUB_SERVICE');

/** Traduce los errores del módulo aislado al contrato de errores v1. */
async function hub<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BrainHubError) {
      throw new ServiceError(error.code === 'REJECTED' ? 'INVALID_REQUEST' : error.code, error.status);
    }
    throw error;
  }
}

const LessonId = z.uuid();
const lessonId = (raw: string) => {
  const parsed = LessonId.safeParse(raw);
  if (!parsed.success) throw new ServiceError('NOT_FOUND', 404);
  return parsed.data;
};

/** Lecciones que suben desde la VM por el MCP (`saleads_share_learning`). */
@Controller('internal/brain-hub')
@UseGuards(InternalTokenGuard)
export class InternalBrainHubController {
  constructor(@Inject(BRAIN_HUB_SERVICE) private readonly brainHub: BrainHubService) {}

  @Post('lessons')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async share(@Req() request: InternalRequest, @Body() body: unknown): Promise<LessonShareResponse> {
    return LessonShareResponse.parse(await hub(() => this.brainHub.shareLesson(request.internalUserId, LessonShareRequest.parse(body))));
  }
}

/** Preferencia de compartir y lo que compartió el dueño (OSF-004). */
@Controller('assistants/me/learning-sharing')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class LearningSharingController {
  constructor(@Inject(BRAIN_HUB_SERVICE) private readonly brainHub: BrainHubService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Req() request: AuthenticatedRequest): Promise<SharingPreference> {
    return SharingPreference.parse(await hub(() => this.brainHub.sharing(request.principal.userId)));
  }

  @Put()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async put(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<SharingPreference> {
    const input = SharingUpdateRequest.parse(body);
    return SharingPreference.parse(await hub(() => this.brainHub.setSharing(request.principal.userId, input.enabled)));
  }

  @Post('notice-ack')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async ack(@Req() request: AuthenticatedRequest): Promise<SharingPreference> {
    return SharingPreference.parse(await hub(() => this.brainHub.ackNotice(request.principal.userId)));
  }

  @Get('lessons')
  @Header('Cache-Control', 'no-store')
  async lessons(@Req() request: AuthenticatedRequest): Promise<OwnerLessonsResponse> {
    return OwnerLessonsResponse.parse({lessons: await hub(() => this.brainHub.ownerLessons(request.principal.userId))});
  }
}

/** API admin del buzón (OSF-005): solo la lista blanca del servidor. */
@Controller('assistants/admin/brain-hub')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class BrainHubAdminController {
  constructor(@Inject(BRAIN_HUB_SERVICE) private readonly brainHub: BrainHubService) {}

  @Get('lessons')
  @Header('Cache-Control', 'no-store')
  async lessons(@Req() request: AuthenticatedRequest, @Query('industry') industry?: string, @Query('status') status?: string): Promise<AdminLessonsResponse> {
    const filter = {industry: industry === undefined ? undefined : IndustrySlug.parse(industry), status};
    return AdminLessonsResponse.parse({lessons: await hub(() => this.brainHub.adminLessons(request.principal.userId, filter))});
  }

  @Post('lessons/:id/validate')
  @HttpCode(204)
  async validate(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await hub(() => this.brainHub.validate(request.principal.userId, lessonId(id)));
  }

  @Post('lessons/:id/reject')
  @HttpCode(204)
  async reject(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await hub(() => this.brainHub.reject(request.principal.userId, lessonId(id)));
  }

  @Post('lessons/:id/publish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async publish(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown): Promise<PublishResponse> {
    return PublishResponse.parse(await hub(() => this.brainHub.publish(request.principal.userId, lessonId(id), PublishRequest.parse(body))));
  }

  @Get('catalog')
  @Header('Cache-Control', 'no-store')
  async catalog(@Req() request: AuthenticatedRequest): Promise<AdminCatalogResponse> {
    return AdminCatalogResponse.parse({items: await hub(() => this.brainHub.adminCatalog(request.principal.userId))});
  }

  @Post('catalog/:itemId/retire')
  @HttpCode(204)
  async retire(@Req() request: AuthenticatedRequest, @Param('itemId') itemId: string): Promise<void> {
    await hub(() => this.brainHub.retire(request.principal.userId, ItemId.parse(itemId)));
  }
}
