import 'server-only'
import {
  callAssistantService,
  relayAssistantService,
  relayAssistantServiceOptional,
} from './assistant-service'
import { relayAssistantStream } from './stream-relay'
import { relaunchCookie } from './oauth-relaunch'
import type { SalesAssistantRouteContext } from './with-session'

export interface AssistantRequestServices {
  call: typeof callAssistantService
  relay: typeof relayAssistantService
  optional: typeof relayAssistantServiceOptional
  stream: typeof relayAssistantStream
  activationCookie: typeof relaunchCookie
}

/** Bindings are lazy so the classic exports retain their existing test/DI seams. */
const CLASSIC: AssistantRequestServices = {
  call: input => callAssistantService(input),
  relay: input => relayAssistantService(input),
  optional: input => relayAssistantServiceOptional(input),
  stream: input => relayAssistantStream(input),
  activationCookie: (url, secure) => relaunchCookie(url, secure),
}

export function servicesFor(context: SalesAssistantRouteContext) {
  return context.services ?? CLASSIC
}
