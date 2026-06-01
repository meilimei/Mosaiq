#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * register-persona.mjs — 把一个 persona 上传到运行中的 cloud-runtime。
 *
 * Phase 11.1 没有自动 seed 池，要在 createSession({ persona: { id: '...' } }) 模式
 * 工作前手工注册一次。LaunchAI 集成验收的 §2.5 步就是用这个。
 *
 * Usage:
 *   MOSAIQ_API_URL=http://127.0.0.1:8787 \
 *   MOSAIQ_API_KEY=msq_sk_dev_... \
 *   MOSAIQ_PROJECT_ID=proj_launchai \
 *   node packages/cloud-sdk/scripts/register-persona.mjs
 *
 * 默认上传 win11-chrome-us 模板。指定 MOSAIQ_PERSONA_TEMPLATE 切别的（目前只
 * 内置一个，留扩展位）。重复上传同一个 id → 409 duplicate，脚本退码 0 + 警告
 * （目的是幂等：CI / 本地反复跑都不爆）。
 */

import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';

const apiUrl = (process.env.MOSAIQ_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const apiKey = process.env.MOSAIQ_API_KEY;
const projectId = process.env.MOSAIQ_PROJECT_ID ?? 'proj_launchai';

if (!apiKey) {
  console.error('FATAL: MOSAIQ_API_KEY env required');
  process.exit(2);
}

const TEMPLATES = {
  'win11-chrome-us': createWin11ChromeUsPersona,
};
const templateName = process.env.MOSAIQ_PERSONA_TEMPLATE ?? 'win11-chrome-us';
const factory = TEMPLATES[templateName];
if (!factory) {
  console.error(
    `FATAL: unknown template "${templateName}". Available: ${Object.keys(TEMPLATES).join(', ')}`,
  );
  process.exit(2);
}

// 让 persona id 稳定（每次脚本跑都给同一 id），方便重跑幂等。
// MOSAIQ_PERSONA_ID 可覆盖；MOSAIQ_PERSONA_SEED 让指纹细节稳定（noiseSeed 等派生）。
const personaId = process.env.MOSAIQ_PERSONA_ID ?? `${templateName}-default`;
const masterSeed = process.env.MOSAIQ_PERSONA_SEED ?? 'phase-11-1-launchai-default';

const persona = factory({
  id: personaId,
  displayName: process.env.MOSAIQ_PERSONA_DISPLAY_NAME ?? `Mosaiq ${templateName} default`,
  masterSeed,
});
console.log(
  `[register-persona] template=${templateName} id=${persona.metadata.id} → POST ${apiUrl}/v1/personas (project=${projectId})`,
);

const resp = await fetch(`${apiUrl}/v1/personas`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(persona),
});

const body = await resp.json().catch(() => ({}));

if (resp.status === 201) {
  console.log(`✅ registered: id=${body.id} source=${body.source} project_id=${body.project_id}`);
  console.log(`\nNext step: set MOSAIQ_DEFAULT_PERSONA_ID=${body.id} in your client's .env`);
  process.exit(0);
}

if (resp.status === 409 && body?.error?.code === 'persona.duplicate') {
  console.log(`✅ already registered: id=${persona.metadata.id} (idempotent skip)`);
  console.log(
    `\nNext step: set MOSAIQ_DEFAULT_PERSONA_ID=${persona.metadata.id} in your client's .env`,
  );
  process.exit(0);
}

console.error(`❌ unexpected response: status=${resp.status} body=${JSON.stringify(body)}`);
process.exit(1);
