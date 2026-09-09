# Build once, run as either the API or the worker.
FROM node:20-slim AS build
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY services/api/package.json services/api/
RUN npm install --workspaces --include-workspace-root
COPY packages/shared packages/shared
COPY services/api services/api
RUN npm run build -w @clearframe/shared && npm run build -w @clearframe/api

FROM node:20-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY services/api/package.json services/api/
RUN npm install --workspaces --include-workspace-root --omit=dev
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/services/api/dist services/api/dist
COPY services/api/db services/api/db
RUN mkdir -p /repo/.data
WORKDIR /repo/services/api
EXPOSE 8080
CMD ["node", "dist/server.js"]
