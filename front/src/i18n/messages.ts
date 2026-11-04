import { defaultLocale, locales, type Locale } from './config'

/**
 * Modo local: los mismos exports que `@/i18n/messages` de SaleADS, con solo
 * los namespaces de Meta Assistant (más `common` y el tramo `composer`/`real`
 * de `agentChat` que usa el compositor).
 */
export type IntlMessages = Record<string, unknown>
type MessageModule = { default: unknown }
type MessageLoader = (locale: Locale) => Promise<MessageModule>

const messageLoaders = {
  common: (locale: Locale) => import(`./locales/${locale}/common.json`),
  agentChat: (locale: Locale) => import(`./locales/${locale}/agent-chat.json`),
  autonomousTeam: (locale: Locale) =>
    import(`./locales/${locale}/autonomous-team.json`),
  salesAssistant: (locale: Locale) =>
    import(`./locales/${locale}/sales-assistant.json`),
  metaAssistant: (locale: Locale) =>
    import(`./locales/${locale}/meta-assistant.json`),
  metaExperience: (locale: Locale) =>
    import(`./locales/${locale}/meta-experience.json`),
  companion: (locale: Locale) => import(`./locales/${locale}/companion.json`),
  metaBrain: (locale: Locale) => import(`./locales/${locale}/meta-brain.json`),
} satisfies Record<string, MessageLoader>

const publicNamespaces = ['common'] as const satisfies readonly (keyof typeof messageLoaders)[]

function normalizeLocale(locale: string | undefined): Locale {
  return locales.includes(locale as Locale) ? (locale as Locale) : defaultLocale
}

async function loadMessages(
  locale: string | undefined,
  namespaces: readonly (keyof typeof messageLoaders)[]
): Promise<IntlMessages> {
  const normalizedLocale = normalizeLocale(locale)
  const entries = await Promise.all(
    namespaces.map(async namespace => {
      const messageModule = await messageLoaders[namespace](normalizedLocale)
      return [namespace, messageModule.default] as const
    })
  )
  return Object.fromEntries(entries)
}

export async function getAllMessages(locale: string | undefined) {
  return loadMessages(
    locale,
    Object.keys(messageLoaders) as (keyof typeof messageLoaders)[]
  )
}

export async function getPublicMessages(locale: string | undefined) {
  return loadMessages(locale, publicNamespaces)
}

export async function getCompanionScreenMessages(locale: string | undefined) {
  return loadMessages(locale, [...publicNamespaces, 'companion'])
}
