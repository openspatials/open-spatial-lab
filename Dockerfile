FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Lab adjustment: the full install, not --omit=dev. The world servers load ajv and ajv-formats (devDependencies)
# to check answers and writes against the Web of Worlds contract, as they do in a plain local run. Without them the
# servers still run, but every request logs "validator unavailable: Cannot find module 'ajv'".
RUN npm ci

FROM node:22-bookworm-slim
WORKDIR /app
RUN groupadd --system osl && useradd --system --gid osl --home /app osl && chown osl:osl /app
# Lab adjustment: COPY --chown, not a later "chown -R /app". A recursive chown copies every file again into a new layer
# (187 MB, a second copy of node_modules and web).
COPY --chown=osl:osl --from=deps /app/node_modules ./node_modules
COPY --chown=osl:osl package.json package-lock.json ./
COPY --chown=osl:osl src ./src
COPY --chown=osl:osl web ./web
COPY --chown=osl:osl runtime ./runtime
COPY --chown=osl:osl tools ./tools
# Lab adjustment: the worlds list and the contract schema are read at start, and the licence files travel with the code.
COPY --chown=osl:osl worlds.json ./worlds.json
COPY --chown=osl:osl wow-spec ./wow-spec
COPY --chown=osl:osl LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY --chown=osl:osl licenses ./licenses
COPY --chown=osl:osl --chmod=755 docker/entrypoint.sh ./docker/entrypoint.sh

# Lab adjustment: OSL_PUBLIC_ORIGIN is where a browser reaches this container. Every world then says it lives at
# {origin}/w/{key}, through the frontend, because the world servers listen on 127.0.0.1 inside the container.
# Run with -p 8143:8143, or set OSL_PUBLIC_ORIGIN to match the port you publish. Placement writes stay off: the
# container sets neither OSL_BIND_HOST nor OSL_PLACEMENT_WRITES.
ENV NODE_ENV=production \
    OSL_PUBLIC_ORIGIN=http://127.0.0.1:8143 \
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
