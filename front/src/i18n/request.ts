/**
 * next-intl Configuration for App Router
 *
 * This file is required by next-intl to load translation messages
 * for each locale on the server side.
 */

import { getRequestConfig } from 'next-intl/server'
import { locales, defaultLocale } from './config'
import { getAllMessages } from './messages'

export default getRequestConfig(async ({ requestLocale }) => {
  // Get locale from request or use default
  let locale = await requestLocale

  // Validar que el locale es válido, si no usar default
  if (!locale || !locales.includes(locale as (typeof locales)[number])) {
    locale = defaultLocale
  }

  const messages = await getAllMessages(locale)

  return {
    locale,
    messages,
  }
})
