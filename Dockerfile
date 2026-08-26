FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
RUN groupadd --system osl && useradd --system --gid osl --home /app osl
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY web ./web
COPY runtime ./runtime
COPY tools ./tools
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh && chown -R osl:osl /app

ENV NODE_ENV=production \
    OSL_FRONTEND_HOST=0.0.0.0 \
    OSL_FRONTEND_PORT=8143 \
    BACKEND_A_PORT=18151 \
    BACKEND_B_PORT=18152 \
    BACKEND_LOBBY_PORT=18153 \
    BACKEND_AIRPORT_PORT=18154

USER osl
EXPOSE 8143

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.OSL_FRONTEND_PORT,path:'/healthz',timeout:2000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["./docker/entrypoint.sh"]
