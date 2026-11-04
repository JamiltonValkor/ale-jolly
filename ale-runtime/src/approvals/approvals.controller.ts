import {Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Req, UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {ApprovalCodeResponseV1, ApprovalCreateRequestV1, ApprovalDecisionRequestV1, ApprovalV1, ApprovalVerificationV1} from '../contracts/v1';
import {invalidRequest, notFound} from '../domain/errors';
import {AssistantFlagGuard} from '../http/assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from '../http/auth.guard';
import {InternalTokenGuard, type InternalRequest} from '../http/internal-token.guard';
import {APPROVALS_SERVICE, DECISION_KEY, type ApprovalsService} from './approvals.service';

const ApprovalId = z.uuid();

function approvalId(raw: string): string {
  const parsed = ApprovalId.safeParse(raw);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function decisionKey(raw: string | undefined): string {
  if (typeof raw !== 'string' || !DECISION_KEY.test(raw)) throw invalidRequest();
  return raw;
}

/** Página de aprobación de la web (OSF-003): el dueño decide con su sesión. */
@Controller('assistants/approvals')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class ApprovalsController {
  constructor(@Inject(APPROVALS_SERVICE) private readonly approvals: ApprovalsService) {}

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<ApprovalV1> {
    return ApprovalV1.parse(await this.approvals.get(request.principal.userId, approvalId(id)));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async approve(
    @Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string,
  ): Promise<ApprovalV1> {
    // Sin cuerpo (front publicado, aprobaciones de instalación) o {code} en las de gasto (MLB-013).
    const decision = ApprovalDecisionRequestV1.parse(body && typeof body === 'object' ? body : {});
    return ApprovalV1.parse(await this.approvals.approve(request.principal.userId, approvalId(id), decisionKey(key), decision.code));
  }

  @Post(':id/code')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async code(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<ApprovalCodeResponseV1> {
    return ApprovalCodeResponseV1.parse(await this.approvals.requestCode(request.principal.userId, approvalId(id)));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reject(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Headers('idempotency-key') key?: string): Promise<ApprovalV1> {
    return ApprovalV1.parse(await this.approvals.reject(request.principal.userId, approvalId(id), decisionKey(key)));
  }
}

/** Propuestas del MCP (`saleads_request_approval`). Solo con token interno y `x-user-id`. */
@Controller('internal/assistants/approvals')
@UseGuards(InternalTokenGuard)
export class InternalApprovalsController {
  constructor(@Inject(APPROVALS_SERVICE) private readonly approvals: ApprovalsService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async propose(@Req() request: InternalRequest, @Body() body: unknown): Promise<ApprovalV1> {
    return ApprovalV1.parse(await this.approvals.propose(request.internalUserId, ApprovalCreateRequestV1.parse(body)));
  }

  /** C-5: integration confirma la aprobación del dueño antes de encender en Meta. Solo lectura. */
  @Get(':id/verification')
  @Header('Cache-Control', 'no-store')
  async verification(@Req() request: InternalRequest, @Param('id') id: string): Promise<ApprovalVerificationV1> {
    return ApprovalVerificationV1.parse(await this.approvals.verification(request.internalUserId, approvalId(id)));
  }
}
