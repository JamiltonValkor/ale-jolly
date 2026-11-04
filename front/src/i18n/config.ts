/**
 * Internationalization Configuration
 *
 * Defines supported locales and default locale for the application
 */

export const locales = ['es', 'en'] as const
export type Locale = (typeof locales)[number]

/**
 * Default locale (Spanish)
 */
export const defaultLocale: Locale = 'es'

/**
 * Locale display names
 */
export const localeNames: Record<Locale, string> = {
  es: 'Español',
  en: 'English',
}
