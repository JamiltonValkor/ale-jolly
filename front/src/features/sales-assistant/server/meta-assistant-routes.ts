import 'server-only'
import { createSalesAssistantRoutes } from './handlers'
import { metaAssistantBindings } from './route-bindings'
import { createStockRoutes } from './stock-handlers'

const routes = createSalesAssistantRoutes(metaAssistantBindings)

/** Explicit parity surface; no IA credentials/providers or admin routes. */
export const metaAssistantRoutes = {
  me: routes.me,
  activation: routes.activation,
  sessions: routes.sessions,
  messages: routes.messages,
  stream: routes.stream,
  stop: routes.stop,
  start: routes.start,
  timezone: routes.timezone,
  snapshots: routes.snapshots,
  snapshot: routes.snapshot,
  snapshotDiff: routes.snapshotDiff,
  brainFeedback: routes.brainFeedback,
  businessProfile: routes.businessProfile,
  approval: routes.approval,
  approvalCode: routes.approvalCode,
  approve: routes.approve,
  reject: routes.reject,
  catalog: routes.catalog,
  install: routes.install,
  uninstall: routes.uninstall,
  agentBudget: routes.agentBudget,
  devices: routes.devices,
  deviceClaim: routes.deviceClaim,
  device: routes.device,
  ...createStockRoutes(metaAssistantBindings),
}
