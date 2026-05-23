# Mosaiq Browser Pod — 单 session chromium 镜像
#
# 用 mcr.microsoft.com/playwright base 直接拿 chromium binary。Playwright 官方
# 维护、含 chromium + 所有依赖，省去自己 apt-get 安装 chromium-deps。

# ─── stage: build ───────────────────────────────────────────────────────────
FROM node:20.18-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
# root package.json 声明了 pnpm.patchedDependencies → patches/playwright-core@1.59.1.patch
# pnpm install --frozen-lockfile 会在解析 lockfile 时校验 patch 文件存在，缺了就 exit 254
# (ENOENT during patch hash verify)。即使 browser-pod 不直接依赖 playwright-core，workspace
# 级的 patch 配置依然要 satisfied。13 KB，几乎免费。
COPY patches patches/
COPY packages/persona-schema/package.json packages/persona-schema/
COPY apps/browser-pod/package.json apps/browser-pod/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter @mosaiq/persona-schema --filter @mosaiq/browser-pod

COPY tsconfig.base.json ./
COPY packages/persona-schema packages/persona-schema
COPY apps/browser-pod apps/browser-pod
RUN pnpm --filter @mosaiq/persona-schema build && \
    pnpm --filter @mosaiq/browser-pod build

# pnpm deploy 把目标 workspace 包 + 所有 prod deps 展平成 symlink-free 目录。
# 之前 runner 只 COPY /repo/node_modules 会漏掉 apps/browser-pod/node_modules/ 里的
# per-workspace symlinks（hono、@hono/node-server、playwright-core 等都在那里），
# 起来就 ERR_MODULE_NOT_FOUND。详见 apps/cloud-runtime/Dockerfile 同款修复。
RUN pnpm --filter=@mosaiq/browser-pod deploy --prod /tmp/deploy

# ─── stage: runner ──────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV POD_CONTROL_PORT=9222
ENV POD_CDP_PORT=9223
ENV POD_PROFILE_DIR=/data/profile

# Playwright base 已含 node + chromium。pnpm deploy 输出已经是独立 prod 树，
# runner 不需要 corepack/pnpm 也能跑（CMD 直接 node dist/index.js）。

COPY --from=build /tmp/deploy /app

# pod 内 chromium 路径（playwright base 镜像里 playwright-core 已知道路径）
# 留空即用 playwright-core chromium.executablePath()
ENV POD_CHROME_EXECUTABLE=

# 持久化目录（dev 用 host bind mount 即可，prod 是 Fly Volume）
RUN mkdir -p /data/profile
VOLUME ["/data"]

EXPOSE 9222
EXPOSE 9223

# 用非 root 用户跑（playwright base 的 pwuser）—— chromium --no-sandbox 已开
USER pwuser

HEALTHCHECK --interval=15s --timeout=2s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.POD_CONTROL_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
