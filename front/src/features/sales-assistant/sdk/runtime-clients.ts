import * as classic from './sales-assistant-client'
import * as orqa from './orqa-client'
import * as robot from './robot-devices-client'
import { streamSalesAssistantTurn } from './sales-assistant-stream'

type JsonRequest = typeof classic.requestJson
type Prefix = '/api/sales-assistant' | '/api/meta-assistant'

function readClient(request: JsonRequest) {
  return {
    fetchSalesAssistantMe: (signal?: AbortSignal) =>
      classic.fetchSalesAssistantMe(signal, request),
    fetchSalesAssistantMessages: (id: string, signal?: AbortSignal) =>
      classic.fetchSalesAssistantMessages(id, signal, request),
    createSalesAssistantSession: () =>
      classic.createSalesAssistantSession(request),
    requestSalesAssistantActivation: (key: string, timezone?: string) =>
      classic.requestSalesAssistantActivation(key, timezone, request),
    updateSalesAssistantTimezone: (timezone: string) =>
      classic.updateSalesAssistantTimezone(timezone, request),
    stopSalesAssistant: () => classic.stopSalesAssistant(request),
    startSalesAssistant: () => classic.startSalesAssistant(request),
    deleteSalesAssistant: () => classic.deleteSalesAssistant(request),
  }
}

function aiClient(request: JsonRequest, managed: boolean) {
  const unavailable = () =>
    Promise.reject(new classic.SalesAssistantClientError('INVALID_REQUEST'))
  return {
    fetchSalesAssistantProviders: (signal?: AbortSignal) =>
      managed
        ? unavailable()
        : classic.fetchSalesAssistantProviders(signal, request),
    configureSalesAssistantAi: (input: classic.SalesAssistantAiInput) =>
      managed
        ? unavailable()
        : classic.configureSalesAssistantAi(input, request),
  }
}

function orqaReads(request: JsonRequest) {
  return {
    fetchBrainSnapshots: (
      business: string,
      limit: number,
      signal?: AbortSignal
    ) => orqa.fetchBrainSnapshots(business, limit, signal, request),
    fetchBrainSnapshot: (
      business: string,
      version: number,
      signal?: AbortSignal
    ) => orqa.fetchBrainSnapshot(business, version, signal, request),
    fetchBrainSnapshotV2: (
      business: string,
      version: number,
      signal?: AbortSignal
    ) => orqa.fetchBrainSnapshotV2(business, version, signal, request),
    fetchBrainDiff: (
      business: string,
      from: number,
      to: number,
      signal?: AbortSignal
    ) => orqa.fetchBrainDiff(business, from, to, signal, request),
    fetchApproval: (id: string, signal?: AbortSignal) =>
      orqa.fetchApproval(id, signal, request),
    fetchBusinessProfile: (business: string, signal?: AbortSignal) =>
      orqa.fetchBusinessProfile(business, signal, request),
    fetchSkillCatalog: (business: string, signal?: AbortSignal) =>
      orqa.fetchSkillCatalog(business, signal, request),
  }
}

function orqaWrites(request: JsonRequest) {
  return {
    decideApproval: (
      id: string,
      decision: 'approve' | 'reject',
      key: string,
      code?: string
    ) => orqa.decideApproval(id, decision, key, code, request),
    requestApprovalCode: (id: string) => orqa.requestApprovalCode(id, request),
    sendBrainFeedback: (
      business: string,
      input: Parameters<typeof orqa.sendBrainFeedback>[1],
      key: string
    ) => orqa.sendBrainFeedback(business, input, key, request),
    updateBusinessProfile: (
      business: string,
      type: Parameters<typeof orqa.updateBusinessProfile>[1]
    ) => orqa.updateBusinessProfile(business, type, request),
    proposeSkill: (
      business: string,
      item: string,
      action: 'install' | 'uninstall',
      key: string
    ) => orqa.proposeSkill(business, item, action, key, request),
  }
}

function orqaAdmin(request: JsonRequest) {
  return {
    fetchAdminLessons: (signal?: AbortSignal) =>
      orqa.fetchAdminLessons(signal, request),
    fetchAdminCatalog: (signal?: AbortSignal) =>
      orqa.fetchAdminCatalog(signal, request),
    reviewAdminLesson: (id: string, action: 'validate' | 'reject') =>
      orqa.reviewAdminLesson(id, action, request),
    publishAdminLesson: (
      id: string,
      input: Parameters<typeof orqa.publishAdminLesson>[1],
      key: string
    ) => orqa.publishAdminLesson(id, input, key, request),
    retireCatalogItem: (id: string) => orqa.retireCatalogItem(id, request),
  }
}

/** Canal robot (CR-004): el compañero físico del dueño. */
export function robotDevicesClient(request: JsonRequest) {
  return {
    claimRobotDevice: (code: string) => robot.claimRobotDevice(code, request),
    fetchRobotDevices: (signal?: AbortSignal) =>
      robot.fetchRobotDevices(signal, request),
    revokeRobotDevice: (id: string) => robot.revokeRobotDevice(id, request),
  }
}

/** Clientes inmutables por árbol; nunca alteran el transporte clásico. */
export function createRuntimeClients(prefix: Prefix, managedAi: boolean) {
  const request: JsonRequest = (path, schema, init) =>
    classic.requestJson(path, schema, init, prefix)
  const transport: typeof classic.salesAssistantFetch = (path, init) =>
    classic.salesAssistantFetch(path, init, prefix)
  return {
    client: { ...readClient(request), ...aiClient(request, managedAi) },
    orqa: {
      ...orqaReads(request),
      ...orqaWrites(request),
      ...orqaAdmin(request),
    },
    devices: robotDevicesClient(request),
    streamTurn: (id: string, text: string, signal: AbortSignal) =>
      streamSalesAssistantTurn(id, text, signal, transport),
  }
}
