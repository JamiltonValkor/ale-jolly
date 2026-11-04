import {Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Req, UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {
  BrainFeedbackRequestV1, BrainFeedbackResponseV1, BrainSnapshotDiffV1, BrainSnapshotResponseV1, BrainSnapshotResponseV2, BrainSnapshotsResponseV1,
} from '../contracts/v1';
import type {BrainFeedbackService} from '../orqa/brain-feedback';
import {ServiceError} from '../domain/errors';
import type {BrainSnapshotService} from '../orqa/brain-snapshots';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';

export const BRAIN_SNAPSHOTS_SERVICE = Symbol('BRAIN_SNAPSHOTS_SERVICE');
export const BRAIN_FEEDBACK_SERVICE = Symbol('BRAIN_FEEDBACK_SERVICE');
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,128}$/;

const BusinessId = z.uuid();
const Version = z.coerce.number().int().min(1).max(1_000_000);
const Limit = z.coerce.number().int().min(1).max(100);

/** Un id o versión inválidos se responden igual que un negocio ajeno: 404. */
function notFoundUnless<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ServiceError('NOT_FOUND', 404);
  return parsed.data;
}

/** Fotos del cerebro del negocio en «Mi asistente» (OSB-010, OSF-001). Se leen aunque la VM esté apagada. */
@Controller('assistants/me/businesses/:businessId/brain/snapshots')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class BrainSnapshotsController {
  constructor(@Inject(BRAIN_SNAPSHOTS_SERVICE) private readonly snapshots: BrainSnapshotService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async timeline(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Query('limit') limit?: string): Promise<BrainSnapshotsResponseV1> {
    const business = notFoundUnless(BusinessId, raw);
    const size = limit === undefined ? 20 : Limit.safeParse(limit).success ? Limit.parse(limit) : 20;
    return BrainSnapshotsResponseV1.parse(await this.snapshots.timeline(request.principal.userId, business, size));
  }

  /** v1 por defecto (front publicado); `?schema=2` devuelve la forma v2 (MLB-014). */
  @Get(':version')
  @Header('Cache-Control', 'no-store')
  async version(
    @Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Param('version') version: string, @Query('schema') schema?: string,
  ): Promise<BrainSnapshotResponseV1 | BrainSnapshotResponseV2> {
    const business = notFoundUnless(BusinessId, raw);
    const v = notFoundUnless(Version, version);
    if (schema === '2') return BrainSnapshotResponseV2.parse(await this.snapshots.versionV2(request.principal.userId, business, v));
    return BrainSnapshotResponseV1.parse(await this.snapshots.version(request.principal.userId, business, v));
  }

  /** `?from=:n`: qué se agregó, se retiró o cambió entre dos versiones. */
  @Get(':version/diff')
  @Header('Cache-Control', 'no-store')
  async diff(
    @Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Param('version') version: string, @Query('from') from?: string,
  ): Promise<BrainSnapshotDiffV1> {
    const business = notFoundUnless(BusinessId, raw);
    return BrainSnapshotDiffV1.parse(await this.snapshots.diff(
      request.principal.userId, business, notFoundUnless(Version, version), notFoundUnless(Version, from)));
  }
}

/** Lo que el dueño dice de una memoria (MLB-014): 202, le llega a Ale por una sesión aparte. */
@Controller('assistants/me/businesses/:businessId/brain/feedback')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class BrainFeedbackController {
  constructor(@Inject(BRAIN_FEEDBACK_SERVICE) private readonly feedback: BrainFeedbackService) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async create(
    @Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Body() body: unknown, @Headers('idempotency-key') key?: string,
  ): Promise<BrainFeedbackResponseV1> {
    const business = notFoundUnless(BusinessId, raw);
    const input = BrainFeedbackRequestV1.parse(body);
    const idem = typeof key === 'string' && IDEMPOTENCY.test(key) ? key : null;
    return BrainFeedbackResponseV1.parse(await this.feedback.enqueue(request.principal.userId, business, input, idem));
  }
}
