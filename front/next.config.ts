import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/**
 * Modo local de Meta Assistant. Mismas opciones de build que SaleADS
 * (React Compiler, three transpilado) sin Sentry, PostHog ni redirects. El
 * cliente de gateway del navegador usa `/__gw`, que aquí reenvía siempre al
 * gateway simulado (en SaleADS solo en desarrollo).
 */
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://saleads.local'

const nextConfig: NextConfig = {
  output: 'standalone',
  reactCompiler: true,
  transpilePackages: ['three'],
  skipTrailingSlashRedirect: true,
  turbopack: {
    root: process.cwd(),
    // `next-auth/react` no se instala: lo reemplaza la sesión demo (D7).
    resolveAlias: {
      'next-auth/react': './src/lib/auth/local/next-auth-react.tsx',
    },
  },
  experimental: {
    optimizePackageImports: ['@phosphor-icons/react'],
  },
  async rewrites() {
    return [{ source: '/__gw/:path*', destination: `${GATEWAY_URL}/:path*` }]
  },
}

export default withNextIntl(nextConfig)
