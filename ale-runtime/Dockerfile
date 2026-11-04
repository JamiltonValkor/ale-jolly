# syntax=docker/dockerfile:1.7
# sa-assistant-service — build multi-stage linux/amd64 (nodos GKE amd64).
# Validación remota sin Docker local:
#   gcloud builds submit --project YOUR_PROJECT --config ci/public-validation.yaml .

# BUILD_PLATFORM: producción sigue en linux/amd64 (nodos GKE); el modo local pasa la del equipo.
ARG BUILD_PLATFORM=linux/amd64

# ---------- build ----------
FROM --platform=${BUILD_PLATFORM} node:22-alpine AS builder
RUN apk add --no-cache 'zlib>=1.3.2-r1'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# ---------- runtime ----------
FROM --platform=${BUILD_PLATFORM} node:22-alpine AS runtime
# Los gestores de paquetes son herramientas de build; el runtime arranca Node directo.
RUN apk add --no-cache 'zlib>=1.3.2-r1' \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
             /usr/local/bin/corepack /usr/local/bin/yarn \
             /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx
ENV NODE_ENV=production \
    PORT=8060
WORKDIR /app
COPY --from=builder --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 package.json ./
# SOUL + skills que el servicio publica en la metadata de cada VM (ASSISTANT_BUNDLE_DIR).
COPY --chown=1000:1000 distribution ./distribution
COPY --chown=1000:1000 vm/extensions ./vm/extensions
# Fail packaging if an ignored managed asset would make application startup fail.
RUN node -e "require('./dist/src/activation/vm-extensions').metaRuntimeExtensions()"
# El usuario node de node:*-alpine es uid/gid 1000 (coincide con el securityContext de k8s).
USER 1000:1000
EXPOSE 8060
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8060/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
