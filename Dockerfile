# Node 20 (Debian slim) — plays nicely with native deps like argon2.
FROM node:20-slim AS base

WORKDIR /app

# openssl is required by the Prisma query engine; dumb-init forwards signals as PID 1.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*


FROM base AS build

# Build tools for native modules (argon2). Harmless if prebuilt binaries are used.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install ALL dependencies — typescript and prisma are devDependencies needed for the build.
# Do NOT prune afterwards: the prisma CLI / ts-node are used for `npm run push` and `npm run seed`.
COPY package*.json ./
RUN npm ci

# App source
COPY . .

# Prisma client → generated/prisma (linux engine; no DATABASE_URL needed to generate)
RUN npm run generate

# Compile TypeScript → dist
RUN npm run build


FROM base AS runtime

# No secrets are baked in: every setting comes from the environment at runtime
# (compose `env_file` / `environment`). These are only defaults.
ARG NODE_ENV=production
ARG PORT=4000
ENV NODE_ENV=${NODE_ENV} \
    PORT=${PORT}

COPY --from=build --chown=node:node /app ./

# Local media (employees / leads / files) — mount a volume here to keep it across deploys.
RUN mkdir -p uploads && chown node:node uploads

USER node

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
