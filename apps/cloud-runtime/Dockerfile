# Mosaiq Cloud Runtime — 控制平面镜像
#
# 多阶段：
#   1) deps   — pnpm install --filter <这个 app + 它的 workspace 依赖>
#   2) build  — tsc 出 dist
#   3) runner — 体积最小的运行镜像（只含 dist + node_modules，不含 src）

# ─── stage: deps ────────────────────────────────────────────────────────────
FROM node:20.18-bookworm-slim AS deps
WORKDIR /repo

# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# better-sqlite3 在没有 prebuilt 时需要 python + build-essential 编译。
# Node 20 + bookworm 上 better-sqlite3 12.x 应该有 prebuilt，这里只是兜底。
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
# 同 apps/browser-pod/Dockerfile：root pnpm.patchedDependencies 引用 patches/playwright-core@1.59.1.patch
# 必须在 pnpm install --frozen-lockfile 前 COPY 进来，否则 exit 254 (ENOENT during patch verify)。
# cloud-runtime 不直接依赖 playwright-core，但 workspace 级 patch 校验依然会触发。
COPY patches patches/
COPY packages/persona-schema/package.json packages/persona-schema/
COPY apps/cloud-runtime/package.json apps/cloud-runtime/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter @mosaiq/persona-schema --filter @mosaiq/cloud-runtime

# ─── stage: build ───────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/persona-schema packages/persona-schema
COPY apps/cloud-runtime apps/cloud-runtime
RUN pnpm --filter @mosaiq/persona-schema build && \
    pnpm --filter @mosaiq/cloud-runtime build

# pnpm deploy 把目标 workspace 包 + 所有 prod deps（含 workspace 间的 @mosaiq/persona-schema）
# 展平成一个**没有 symlink** 的独立目录，runner stage 一句 COPY 就能拿到完整可跑的 app。
#
# 这是 pnpm 官方为 docker 多阶段推荐的做法（https://pnpm.io/cli/deploy）。
# 之前的做法（COPY /repo/node_modules 然后单独叠 dist）在 pnpm 严格模式下会丢
# per-workspace 的 deps —— 比如 @hono/node-server 是 cloud-runtime 的 direct dep，
# 它只在 apps/cloud-runtime/node_modules/ 里有 symlink，root /repo/node_modules/ 里没有，
# 所以 runner 起来就 ERR_MODULE_NOT_FOUND。deploy 会真把这些包复制进 /tmp/deploy/node_modules/。
RUN pnpm --filter=@mosaiq/cloud-runtime deploy --prod /tmp/deploy

# ─── stage: runner ──────────────────────────────────────────────────────────
FROM node:20.18-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

# better-sqlite3 是 native module，prebuilt 在 install 时已下到 .pnpm store 并 deploy 进来；
# runner image 跟 build image 都是 node:20.18-bookworm-slim（同 glibc + 同 arch），ABI 一致。

COPY --from=build /tmp/deploy /app

# data 目录给 sqlite。Fly volume 挂载点，dev 也能跑。
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
