/**
 * `mosaiq personas show <persona-id>` — 打印一份 persona 的详情。
 *
 * 不启动 Chromium；纯 `loadPersona` → 排版输出。`--json` 模式吐完整 Persona JSON
 * （含 fingerprint seeds），便于 jq / 脚本对比。默认人读视图省略噪声 seeds（信息密度低
 * 且每次创建都换），保留对调试有用的字段：identity / 系统 / 硬件签名 / 代理 / 时间。
 *
 * 退出码：
 *   0 = 找到并打印
 *   2 = persona 不存在 / 文件损坏 / 参数错
 */

import { parseArgs } from 'node:util';

import { type Persona, loadPersona } from '@runova/sdk';

import { fmt } from '../../output.js';
import { extractTemplateTag } from './template-tag.js';

const HELP = `Usage: mosaiq personas show <persona-id> [options]

Print a persona's details. Does not launch Chromium.

Arguments:
  <persona-id>           Persona id (use \`mosaiq personas list\` to discover)

Options:
  --json                 Print full Persona JSON (incl. fingerprint seeds /
                         font list) instead of a human-readable view
  -h, --help             Show this help
`;

export async function runPersonasShow(argv: readonly string[]): Promise<number> {
  let opts: { personaId: string; json: boolean; help: boolean };
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    opts = {
      personaId: parsed.positionals[0] ?? '',
      json: parsed.values.json === true,
      help: parsed.values.help === true,
    };
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!opts.personaId) {
    process.stderr.write(`Error: <persona-id> is required.\n\n${HELP}`);
    return 2;
  }

  let persona: Persona;
  try {
    persona = loadPersona(opts.personaId);
  } catch (err) {
    process.stderr.write(`${fmt.red('✗')} ${(err as Error).message}\n`);
    return 2;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(persona, null, 2)}\n`);
    return 0;
  }

  printPersonaSummary(persona);
  return 0;
}

/** 排版工具：左 label / 右 value，label 列左对齐到固定宽度。 */
function row(label: string, value: string): string {
  return `  ${fmt.dim(label.padEnd(14))}${value}`;
}

function formatDate(iso: string | null | undefined): string {
  if (iso == null || iso === '') return fmt.dim('—');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printPersonaSummary(p: Persona): void {
  const w = process.stdout.write.bind(process.stdout);

  // ── Identity ──────────────────────────────────────────────────────────
  w(`${fmt.bold(p.metadata.displayName)}  ${fmt.cyan(p.metadata.id)}\n`);
  w(`${fmt.dim('Template')}: ${extractTemplateTag(p) ?? fmt.dim('unknown')}\n`);
  w(
    `${fmt.dim('Tags')}: ${
      p.metadata.tags.length === 0 ? fmt.dim('—') : p.metadata.tags.join(', ')
    }\n`,
  );
  if (p.metadata.notes) {
    w(`${fmt.dim('Notes')}: ${p.metadata.notes}\n`);
  }
  w(`${fmt.dim('Created')}: ${formatDate(p.metadata.createdAt)}`);
  w(`   ${fmt.dim('Updated')}: ${formatDate(p.metadata.updatedAt)}\n`);
  w(
    `${fmt.dim('Last launched')}: ${formatDate(p.metadata.lastLaunchedAt)}   ${fmt.dim(
      'Launch count',
    )}: ${p.metadata.launchCount}\n`,
  );
  w('\n');

  // ── System ────────────────────────────────────────────────────────────
  w(`${fmt.bold('System')}\n`);
  w(row('OS', `${p.system.os.family} ${p.system.os.version} (${p.system.os.arch})`));
  w('\n');
  w(row('Locale', `${p.system.locale}  ${fmt.dim(`(${p.system.languages.join(', ')})`)}`));
  w('\n');
  w(row('Timezone', p.system.timezone));
  w('\n');
  w(
    row(
      'Screen',
      `${p.system.screen.width}×${p.system.screen.height} @${p.system.screen.devicePixelRatio}x  ${fmt.dim(
        `(avail ${p.system.screen.availWidth}×${p.system.screen.availHeight}, ${p.system.screen.colorDepth}-bit)`,
      )}`,
    ),
  );
  w('\n');
  w('\n');

  // ── Browser ───────────────────────────────────────────────────────────
  w(`${fmt.bold('Browser')}\n`);
  w(row('Brand', p.browser.brand));
  w('\n');
  w(row('Version', p.browser.fullVersion));
  w('\n');
  if (p.browser.userAgent) {
    w(row('UA override', p.browser.userAgent));
    w('\n');
  } else {
    w(row('UA override', fmt.dim('— (auto-derived from os + brand + version)')));
    w('\n');
  }
  w('\n');

  // ── Hardware ──────────────────────────────────────────────────────────
  w(`${fmt.bold('Hardware')}\n`);
  const cpu = p.hardware.cpu;
  w(row('CPU', `${cpu.modelName ?? fmt.dim('—')} (${cpu.cores} cores)`));
  w('\n');
  w(row('Memory', `${p.hardware.deviceMemoryGb} GB`));
  w('\n');
  w(row('GPU vendor', p.hardware.gpu.vendor));
  w('\n');
  w(row('GPU webgl', `${fmt.dim(p.hardware.gpu.webglVendor)} / ${p.hardware.gpu.webglRenderer}`));
  w('\n');
  if (p.hardware.gpu.webglProfileId) {
    w(row('GPU profile', p.hardware.gpu.webglProfileId));
    w('\n');
  }
  w(
    row(
      'Audio',
      `${p.hardware.audio.sampleRate} Hz  ${fmt.dim(
        `(in: ${p.hardware.audio.inputDeviceCount}, out: ${p.hardware.audio.outputDeviceCount})`,
      )}`,
    ),
  );
  w('\n');
  w(row('Touch', p.hardware.maxTouchPoints > 0 ? `${p.hardware.maxTouchPoints} points` : 'no'));
  w('\n');
  w('\n');

  // ── Fingerprint signature ─────────────────────────────────────────────
  w(`${fmt.bold('Fingerprint')}\n`);
  w(
    row(
      'Canvas',
      `seed=${fmt.dim(p.fingerprint.canvas.noiseSeed)}  strength=${p.fingerprint.canvas.noiseStrength}`,
    ),
  );
  w('\n');
  w(
    row(
      'WebGL',
      `seed=${fmt.dim(p.fingerprint.webgl.noiseSeed)}  perturbReadPixels=${p.fingerprint.webgl.perturbReadPixels}`,
    ),
  );
  w('\n');
  w(
    row(
      'Audio',
      `seed=${fmt.dim(p.fingerprint.audio.noiseSeed)}  amplitudeDb=${
        p.fingerprint.audio.noiseAmplitudeDb ?? '—'
      }`,
    ),
  );
  w('\n');
  w(row('Fonts', `${p.fingerprint.fontList.fonts.length} entries`));
  w('\n');
  w(row('WebRTC', `mode=${p.fingerprint.webrtc.mode}`));
  w('\n');
  w('\n');

  // ── Network ───────────────────────────────────────────────────────────
  w(`${fmt.bold('Network')}\n`);
  if (!p.network.proxy) {
    w(row('Proxy', fmt.dim('none')));
    w('\n');
  } else {
    const x = p.network.proxy;
    const credPart = x.username ? `${x.username}${x.password ? ':***' : ''}@` : '';
    w(row('Proxy', `${x.protocol}://${credPart}${x.host}:${x.port}`));
    w('\n');
    if (x.label) {
      w(row('Proxy label', x.label));
      w('\n');
    }
    if (x.bypassList && x.bypassList.length > 0) {
      w(row('Bypass', x.bypassList.join(', ')));
      w('\n');
    }
  }
}
