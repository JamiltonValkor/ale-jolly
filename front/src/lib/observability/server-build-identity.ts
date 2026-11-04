import 'server-only'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ServerBuildIdentity {
  id: string
  source: 'next_build_id' | 'unknown'
}

const UNKNOWN_BUILD: ServerBuildIdentity = {
  id: 'unknown',
  source: 'unknown',
}
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export function resolveServerBuildIdentity(
  value: unknown
): ServerBuildIdentity {
  if (typeof value !== 'string' || !BUILD_ID_PATTERN.test(value))
    return UNKNOWN_BUILD
  return { id: value, source: 'next_build_id' }
}

/** Reads only Next's generated build identity; development stays honestly unknown. */
export function getServerBuildIdentity(
  readBuildId: () => string = () =>
    readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')
): ServerBuildIdentity {
  if (process.env.NODE_ENV === 'development') return UNKNOWN_BUILD
  try {
    return resolveServerBuildIdentity(readBuildId())
  } catch {
    return UNKNOWN_BUILD
  }
}
