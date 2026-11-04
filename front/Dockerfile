# Front de Meta Assistant en modo local (P3). Build de producción y `next start`
# con la salida standalone de Next.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# El navegador habla con el gateway por el rewrite `/__gw`; las rewrites de Next
# se fijan en el build, así que GATEWAY_URL también entra aquí.
ARG GATEWAY_URL=https://saleads.local
ARG NEXT_PUBLIC_GATEWAY_URL=/__gw
ENV NEXT_TELEMETRY_DISABLED=1 \
    GATEWAY_URL=$GATEWAY_URL \
    NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
RUN pnpm build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
