/**
 * canvas-cross-check — 产品正确性 gate。
 *
 * 我们对外承诺：
 *   (D) Determinism —— 同一个 persona（同 masterSeed）跨多次 launch 拿到完全
 *       一致的 Canvas hash。否则用户跨会话登陆同一站点会被识别为不同设备。
 *   (U) Uniqueness   —— 不同 persona 的 Canvas hash 互不相同。否则两个 persona
 *       在同一站点会被关联，多账号隔离就被破。
 *
 * 这个脚本：
 *   - 用 4 个不同 OS 模板各跑 2 次（共 8 个 session），每个 session 用同一段固定
 *     绘制内容算 Canvas hash（toDataURL → SHA-256 截 16 hex）。
 *   - assert (D) 跨 run hash 完全相同；assert (U) 跨 persona hash 全部不同。
 *
 *   pnpm --filter @mosaiq/sdk exec tsx bench/canvas-cross-check.ts
 *
 * 失败 → 反检测注入的 noise 派生路径或 spoof 应用顺序有静默 bug。
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

import type { Persona } from '@mosaiq/persona-schema';
import {
  createMacosSonomaChromeUsPersona,
  createUbuntu2204ChromeUsPersona,
  createWin10ChromeUsPersona,
  createWin11ChromeUsPersona,
} from '@mosaiq/persona-schema/templates';

import {
  deletePersona,
  getUserDataDir,
  launchPersona,
  personaExists,
  savePersona,
} from '../src/index.js';

interface Fixture {
  readonly label: string;
  /**
   * factory(suffix) —— 同一 label 不同 suffix 产出同 masterSeed、不同 id 的 persona。
   * id 不同是为了 user-data-dir 不撞，masterSeed 相同是 determinism 测试核心。
   */
  factory(suffix: string): Persona;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    label: 'win11-A',
    factory: (s) =>
      createWin11ChromeUsPersona({
        id: `xc-w11-a-${s}`,
        displayName: 'W11A',
        masterSeed: 'aaaaaaaa1111bbbb2222cccc3333dddd',
      }),
  },
  {
    label: 'win10-B',
    factory: (s) =>
      createWin10ChromeUsPersona({
        id: `xc-w10-b-${s}`,
        displayName: 'W10B',
        masterSeed: 'beefdead4444aaaa5555bbbb6666cccc',
      }),
  },
  {
    label: 'macos-C',
    factory: (s) =>
      createMacosSonomaChromeUsPersona({
        id: `xc-mac-c-${s}`,
        displayName: 'MacC',
        masterSeed: 'cafe7777ee8888ff9999aaaa0000bbbb',
      }),
  },
  {
    label: 'ubuntu-D',
    factory: (s) =>
      createUbuntu2204ChromeUsPersona({
        id: `xc-ubu-d-${s}`,
        displayName: 'UbuD',
        masterSeed: 'deafff111122223333444455556666aa',
      }),
  },
];

const RUNS_PER_PERSONA = 2;

// 固定 canvas 绘制内容 + hash 计算 —— 在浏览器内 evaluate 跑。
const CANVAS_PROBE_SOURCE = `
(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 280;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d ctx');
  // 用 CreepJS / browserleaks 等流行 fingerprinter 类似的混合图案，
  // 能放大 spoof 路径里所有 hook（toDataURL / getImageData / fillText / 渐变 / 文字）
  // 中任何一个的不一致。
  ctx.textBaseline = 'top';
  ctx.font = '14px "Arial"';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f60';
  ctx.fillRect(125, 1, 62, 20);
  ctx.fillStyle = '#069';
  ctx.fillText('Mosaiq Cross-Check 1', 2, 15);
  ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
  ctx.fillText('Mosaiq Cross-Check 1', 4, 17);
  // 第二行加点几何 + emoji，触发更多 raster path
  ctx.beginPath();
  ctx.arc(50, 50, 8, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = '#900';
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = '12px sans-serif';
  ctx.fillText('|0aB!?', 80, 50);

  const dataUrl = canvas.toDataURL();
  // SHA-256 在 Node 端算 —— about:blank 没有 secure context，crypto.subtle 不可用。
  return { dataUrl, dataUrlLen: dataUrl.length };
})()
`.trim();

interface Sample {
  label: string;
  run: number;
  hash: string;
  dataUrlLen: number;
  durationMs: number;
}

async function measureSession(persona: Persona): Promise<Omit<Sample, 'label' | 'run'>> {
  const t0 = Date.now();
  const session = await launchPersona(persona, { headless: true });
  try {
    const page = await session.firstPage();
    // about:blank 上 injection 也跑（addInitScript 注入到所有 page realm）。
    // 不必导航到 https 站点，节省时间且减少外部依赖。
    await page.goto('about:blank');
    const result = (await page.evaluate(CANVAS_PROBE_SOURCE)) as {
      dataUrl: string;
      dataUrlLen: number;
    };
    const hash = createHash('sha256').update(result.dataUrl).digest('hex').slice(0, 16);
    return { hash, dataUrlLen: result.dataUrlLen, durationMs: Date.now() - t0 };
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const samples: Sample[] = [];

  for (const fx of FIXTURES) {
    for (let run = 0; run < RUNS_PER_PERSONA; run++) {
      const persona = fx.factory(`r${run}`);
      const id = persona.metadata.id;
      if (personaExists(id)) deletePersona(id);
      savePersona(persona);
      try {
        const m = await measureSession(persona);
        samples.push({ label: fx.label, run, ...m });
        console.log(
          `[${fx.label}#${run}] hash=${m.hash}  dataUrlLen=${m.dataUrlLen}  ${m.durationMs}ms`,
        );
      } finally {
        deletePersona(id);
        await wait(300);
        try {
          rmSync(getUserDataDir(id), { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
  }

  console.log('');
  console.log('═══ assertions ═══');

  // (D) Determinism —— 同 label 跨 run hash 一致
  let detFail = 0;
  const byLabel = new Map<string, string[]>();
  for (const s of samples) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, []);
    byLabel.get(s.label)!.push(s.hash);
  }
  for (const [label, hashes] of byLabel) {
    const uniq = new Set(hashes);
    if (uniq.size === 1) {
      console.log(`  ✓ determinism  ${label.padEnd(12)} all ${hashes.length} runs = ${hashes[0]}`);
    } else {
      console.log(
        `  ✗ determinism  ${label.padEnd(12)} drift across runs: ${[...uniq].join(' | ')}`,
      );
      detFail++;
    }
  }

  // (U) Uniqueness —— 不同 label 的代表 hash 互不相同
  const repByLabel = new Map<string, string>();
  for (const [label, hashes] of byLabel) repByLabel.set(label, hashes[0]!);
  const allHashes = [...repByLabel.values()];
  const uniqHashes = new Set(allHashes);
  let uniFail = 0;
  if (uniqHashes.size === allHashes.length) {
    console.log(
      `  ✓ uniqueness   ${allHashes.length} personas → ${uniqHashes.size} distinct hashes`,
    );
  } else {
    console.log(
      `  ✗ uniqueness   ${allHashes.length} personas → only ${uniqHashes.size} distinct hashes (collision!)`,
    );
    // 打印碰撞详情
    const collisions = new Map<string, string[]>();
    for (const [label, hash] of repByLabel) {
      if (!collisions.has(hash)) collisions.set(hash, []);
      collisions.get(hash)!.push(label);
    }
    for (const [hash, labels] of collisions) {
      if (labels.length > 1) {
        console.log(`     hash ${hash} shared by: ${labels.join(', ')}`);
      }
    }
    uniFail++;
  }

  const failed = detFail + uniFail;
  console.log('');
  if (failed === 0) {
    console.log('PASS ✓  Canvas determinism + uniqueness 两条产品承诺都成立。');
  } else {
    console.log(`FAIL ✗  ${detFail} determinism breaches, ${uniFail} uniqueness breaches`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
