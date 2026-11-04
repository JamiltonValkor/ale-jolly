// TDD-SKIP: pure React Query key factory, no logic to test
import type {
  AgentObjectType,
  AssistantBffPrefix,
} from '../sdk/autonomous-team-client'

export const autonomousTeamKeys = {
  all: ['autonomous-team'] as const,
  user: (userId: string) => [...autonomousTeamKeys.all, userId] as const,
  actions: (userId: string, businessId: string, filters: string) =>
    [
      ...autonomousTeamKeys.user(userId),
      'actions',
      businessId,
      filters,
    ] as const,
  action: (userId: string, actionId: string) =>
    [...autonomousTeamKeys.user(userId), 'action', actionId] as const,
  objectActions: (userId: string, type: AgentObjectType, objectId: string) =>
    [...autonomousTeamKeys.user(userId), 'object', type, objectId] as const,
  budget: (
    userId: string,
    businessId: string,
    assistantBffPrefix?: AssistantBffPrefix
  ) =>
    assistantBffPrefix === '/api/meta-assistant'
      ? ([
          ...autonomousTeamKeys.user(userId),
          'budget',
          businessId,
          'meta-assistant',
        ] as const)
      : ([...autonomousTeamKeys.user(userId), 'budget', businessId] as const),
  budgetCurrency: (userId: string, businessId: string) =>
    [
      ...autonomousTeamKeys.user(userId),
      'budget-currency',
      businessId,
    ] as const,
  creditCap: (userId: string) =>
    [...autonomousTeamKeys.user(userId), 'credit-cap'] as const,
}
