#!/usr/bin/env node
/**
 * Mosaiq Desktop dev launcher.
 *
 * 某些环境（包括部分 IDE 的内嵌终端、CI runner、corepack 路径）会注入
 * `ELECTRON_RUN_AS_NODE=1`，导致 `electron .` 把入口当作纯 Node 脚本执行，
 * `require('electron')` 返回二进制路径字符串而非模块对象，进而 `electron.app`
 * 为 undefined。
 *
 * 这里在 spawn vite 之前主动 delete 该环境变量，跨平台可靠。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const isWindows = process.platform === 'win32';
const viteBin = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  isWindows ? 'vite.CMD' : 'vite',
);

const child = spawn(viteBin, process.argv.slice(2), {
  cwd: path.resolve(__dirname, '..'),
  env,
  stdio: 'inherit',
  shell: isWindows, // .CMD 在 Windows 下需要 shell
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[mosaiq dev] failed to spawn vite:', err);
  process.exit(1);
});
