import {Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Put, Req, UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {AGENT_BUDGET_SERVICE, type AgentBudgetService} from '../approvals/agent-budget.service';
import {DECISION_KEY} from '../approvals/approvals.service';
import {
  AgentBudgetEvaluationRequestV1, AgentBudgetEvaluationV1, AgentMonthlyBudgetUpdateRequestV1, AgentMonthlyBudgetV1,
} from '../contracts/v1';
import {invalidRequest, notFound, preconditionRequired} from '../domain/errors';
import {AssistantFlagGuard} from './assistant-flag.guard';
import {AuthGuard, type AuthenticatedRequest} from './auth.guard';
import {InternalTokenGuard, type InternalRequest} from './internal-token.guard';

const BusinessId = z.uuid();

function businessIdOf(raw: string): string {
  const parsed = BusinessId.safeParse(raw);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** Presupuesto mensual del agente en la web (AAB-012, AAF-004): solo con la sesión del dueño. */
@Controller('assistants/me/businesses/:businessId/agent-budget')
@UseGuards(AuthGuard, AssistantFlagGuard)
export class AgentBudgetController {
  constructor(@Inject(AGENT_BUDGET_SERVICE) private readonly budgets: AgentBudgetService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Req() request: AuthenticatedRequest, @Param('businessId') raw: string): Promise<AgentMonthlyBudgetV1> {
    return AgentMonthlyBudgetV1.parse(await this.budgets.get(request.principal.userId, businessIdOf(raw)));
  }

  @Put()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async put(
    @Req() request: AuthenticatedRequest, @Param('businessId') raw: string, @Body() body: unknown,
    @Headers('if-match') ifMatch?: string, @Headers('idempotency-key') key?: string,
  ): Promise<AgentMonthlyBudgetV1> {
    const business = businessIdOf(raw);
    if (typeof ifMatch !== 'string' || !ifMatch.trim()) throw preconditionRequired();
    if (typeof key !== 'string' || !DECISION_KEY.test(key)) throw invalidRequest();
    const input = AgentMonthlyBudgetUpdateRequestV1.parse(body);
    return AgentMonthlyBudgetV1.parse(await this.budgets.put(request.principal.userId, business, ifMatch, input));
  }
}

/** Lectura y evaluación para la Agent API y el espejo (C-10, C-13). Nunca escribe. */
@Controller('internal/assistants')
@UseGuards(InternalTokenGuard)
export class InternalAgentBudgetController {
  constructor(@Inject(AGENT_BUDGET_SERVICE) private readonly budgets: AgentBudgetService) {}

  @Get('businesses/:businessId/agent-budget')
  @Header('Cache-Control', 'no-store')
  async get(@Req() request: InternalRequest, @Param('businessId') raw: string): Promise<AgentMonthlyBudgetV1> {
    return AgentMonthlyBudgetV1.parse(await this.budgets.internalGet(request.internalUserId, businessIdOf(raw)));
  }

  @Post('agent-budget/evaluate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async evaluate(@Req() request: InternalRequest, @Body() body: unknown): Promise<AgentBudgetEvaluationV1> {
    return AgentBudgetEvaluationV1.parse(await this.budgets.evaluate(request.internalUserId, AgentBudgetEvaluationRequestV1.parse(body)));
  }
}
