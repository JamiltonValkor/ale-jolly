export * from './autonomous-team.schemas'
export {
  agentBudgetSchema,
  agentBudgetUpdateSchema,
  budgetIfMatch,
  type AgentBudget,
  type AgentBudgetUpdate,
} from '@/shared/contracts/agent-budget'
export {
  resolveAuthorship,
  stripAgentPrefix,
  type Authorship,
  type ResolvedAuthorship,
} from '@/shared/lib/authorship'
