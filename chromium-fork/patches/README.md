# Mosaiq Chromium Patches

这里放对 vanilla Chromium 的 patch 文件 + 它们的设计稿。

## 文件类型

| 文件 | 含义 |
|---|---|
| `series.txt` | quilt 风格的应用顺序清单 |
| `NNNN-name.spec.md` | patch 设计稿（实施前 / 实施期间维护） |
| `NNNN-name.patch` | `git format-patch` 产出的真 diff（实施完成后） |

## 工作流（每个 patch 实施时）

```
.spec.md 设计完整  →  在 ~/chromium/src 实施代码  →  增量 build 验证
                                                         ↓
                                                 git commit
                                                         ↓
                                                git format-patch -1
                                                         ↓
                                          mv 0001-xxx.patch <repo>/patches/
                                                         ↓
                                              series.txt 添加该行
                                                         ↓
                                            apply-patches.sh 验证可重放
```

## Phase A 三个 patch 当前状态

| Patch | Spec | Patch file | 状态 |
|---|---|---|---|
| 0014 Persona Bridge | [`0014-persona-bridge.spec.md`](./0014-persona-bridge.spec.md) | (待 A.2 生成) | 设计稿待写 |
| 0001 Canvas Noise | [`0001-canvas-noise.spec.md`](./0001-canvas-noise.spec.md) | (待 A.3 生成) | 设计稿待写 |
| 0011 TLS / JA4 Spoof | [`0011-tls-ja4-spoof.spec.md`](./0011-tls-ja4-spoof.spec.md) | (待 A.4 生成) | 设计稿待写 |

> Phase A.0 阶段不写 spec 完整内容 —— 设计需要 vanilla Chromium 源码可读后才能精确定位触点文件行号。每个 spec.md 在对应 phase 启动时由 Cascade 写入。

## apply-patches.sh 使用

```bash
# 在 ~/chromium/src 内（已 git checkout 到目标 stable tag）
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/apply-patches.sh
```

脚本会按 `series.txt` 顺序 `git apply --3way` 每个 .patch 文件。失败时停止并打印冲突文件清单。

## sync-upstream.sh 使用（Phase B+）

```bash
# 同步到新的 Chromium stable tag，自动尝试 rebase patch series
bash /mnt/d/projects/Mosaiq/chromium-fork/scripts/sync-upstream.sh 135.0.7100.x
```

若有 patch 冲突，需手动 `git apply --3way` 解决，然后 `git format-patch` 重新生成。详见 `docs/CHROMIUM-FORK-GUIDE.md` §4.3。
