export type ServerTraceEnvironment = 'local' | 'dev' | 'preprod'

export interface ServerTraceCaptureConfig {
  environment: ServerTraceEnvironment
}

function traceEnvironment(): ServerTraceEnvironment | undefined {
  switch ((process.env.TRACE_ENVIRONMENT ?? '').toLowerCase()) {
    case 'local':
      return 'local'
    case 'dev':
    case 'develop':
    case 'development':
      return 'dev'
    case 'preprod':
    case 'preproduction':
      return 'preprod'
    default:
      return undefined
  }
}

/** Shared flag/env policy for both the safe facade and server implementation. */
export function getServerTraceCaptureConfig():
  | ServerTraceCaptureConfig
  | undefined {
  if (
    process.env.TRACE_CAPTURE_ENABLED !== 'true' ||
    process.env.TRACE_VIEWER_ENABLED !== 'true'
  )
    return undefined
  const environment = traceEnvironment()
  return environment ? { environment } : undefined
}

export function isServerTraceCaptureEnabled(): boolean {
  return getServerTraceCaptureConfig() !== undefined
}
