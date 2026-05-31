# npm 首发排错 — `@runova` scope

## 背景

- npm **Organization** 为 **`runova`**（`@runova/*`），不是 `@mosaiq`。
- npm 上的 **`@mosaiq` scope 已被他人占用**，不能把 CLI 发成 `@mosaiq/cli`。
- **产品名**仍是 Mosaiq；**命令**仍是 `mosaiq`；**npm 包名**为 `@runova/cli`。

## 症状（历史）

曾尝试 `PUT @mosaiq/cli` → **404**：因为 org 是 `runova`，不是 `mosaiq`。

## 正确安装方式

```powershell
npm i -g @runova/cli@0.10.2
mosaiq --version
mosaiq personas templates list
```

## 首发顺序（均在 `@runova` org 下）

```powershell
cd D:\projects\Mosaiq
pnpm --filter "@runova/persona-schema" --filter "@runova/sdk" --filter "@runova/cli" build
pnpm --filter "@runova/cloud-sdk" build
.\scripts\npm-first-publish.ps1
```

或单包（需 OTP）：

```powershell
cd packages\persona-schema && npm publish --access public --provenance=false
# sdk/cli 必须用 pnpm publish（会改写 workspace:*），不要用裸 npm publish：
pnpm --filter @runova/sdk publish --access public --no-git-checks --publish-branch main
pnpm --filter @runova/cli publish --access public --no-git-checks --publish-branch main
cd ..\cloud-sdk && npm publish --access public --provenance=false
```

## `E403` — cannot publish over 0.10.0

```text
403 Forbidden - You cannot publish over the previously published versions: 0.10.0
```

**这不是失败**：说明 `@runova/cli@0.10.0` **已经发上去过**（终端里会有 `+ @runova/cli@0.10.0`），不要重复发同一版本。

若 `npm view @runova/cli` / `npm i @runova/cli` 仍 404，常见原因是首发用了 **`npm publish` 直发**，tarball 里依赖仍是 `workspace:*`，且包级元数据不完整。处理：

1. **`@runova/sdk@0.10.0`** 若用裸 `npm publish` 首发，tarball 里 `@runova/persona-schema` 仍是 `workspace:*` → 装 CLI 会 `EUNSUPPORTEDPROTOCOL`（即使 CLI 元数据已修好）。
2. 发布 **`sdk@0.10.1`** + **`cli@0.10.2`**（链式依赖）：

```powershell
cd D:\projects\Mosaiq
pnpm --filter @runova/sdk --filter @runova/cli build
.\scripts\npm-publish-runova-fix.ps1
npm i -g @runova/cli@0.10.2
```

可选：72 小时内撤坏版本 `npm unpublish @runova/cli@0.10.0 --force` / `sdk@0.10.0 --force`（慎用）。

## 验证

```powershell
npm view @runova/persona-schema version
npm view @runova/sdk version
npm view @runova/cli version
npm view @runova/cloud-sdk version
npm i -g @runova/cli@0.10.1
npx mosaiq --version
```

## 权限问题

若 PUT 仍 404/403：在 [npmjs.com](https://www.npmjs.com) → **Organizations → runova → Teams**，确认你的账号对 scope 有 **read-write** publish 权。
