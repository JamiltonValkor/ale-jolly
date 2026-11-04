export function createAssistantQueryKeys(namespace: string) {
  const keys = {
    all: [namespace] as const,
    user: (userId: string) => [...keys.all, userId] as const,
    me: (userId: string) => [...keys.user(userId), 'me'] as const,
    providers: (userId: string) => [...keys.user(userId), 'providers'] as const,
    messages: (userId: string, sessionId: string) =>
      [...keys.user(userId), 'messages', sessionId] as const,
    // ORQA del usuario (OSF-001…005)
    brainSnapshots: (userId: string, businessId: string) =>
      [...keys.user(userId), 'brain', businessId] as const,
    brainSnapshot: (userId: string, businessId: string, version: number) =>
      [...keys.brainSnapshots(userId, businessId), version] as const,
    approval: (userId: string, approvalId: string) =>
      [...keys.user(userId), 'approval', approvalId] as const,
    skillCatalog: (userId: string, businessId: string) =>
      [...keys.user(userId), 'skills', businessId] as const,
    // Agente de marketing (MLF-001…006)
    brainSnapshotV2: (userId: string, businessId: string, version: number) =>
      [...keys.brainSnapshots(userId, businessId), version, 'v2'] as const,
    brainDiff: (userId: string, businessId: string, from: number, to: number) =>
      [...keys.brainSnapshots(userId, businessId), 'diff', from, to] as const,
    businessProfile: (userId: string, businessId: string) =>
      [...keys.user(userId), 'business-profile', businessId] as const,
    brainHubAdmin: (userId: string) =>
      [...keys.user(userId), 'brain-hub-admin'] as const,
    // Canal robot (CR-005): compañeros físicos vinculados.
    robotDevices: (userId: string) =>
      [...keys.user(userId), 'robot-devices'] as const,
    // Stock (IVF-001): por negocio, salvo el estado de habilitación.
    stockStatus: (userId: string) =>
      [...keys.user(userId), 'stock-status'] as const,
    stock: (userId: string, businessId: string) =>
      [...keys.user(userId), 'stock', businessId] as const,
    stockSummary: (userId: string, businessId: string) =>
      [...keys.stock(userId, businessId), 'summary'] as const,
    stockItems: (userId: string, businessId: string) =>
      [...keys.stock(userId, businessId), 'items'] as const,
    stockProposals: (userId: string, businessId: string) =>
      [...keys.stock(userId, businessId), 'proposals'] as const,
    stockOrders: (userId: string, businessId: string) =>
      [...keys.stock(userId, businessId), 'orders'] as const,
    stockAutonomy: (userId: string, businessId: string) =>
      [...keys.stock(userId, businessId), 'autonomy'] as const,
  }

  return keys
}

export const salesAssistantKeys = createAssistantQueryKeys('sales-assistant')
