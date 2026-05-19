/**
 * Mosaiq CLI 顶层入口。
 *
 * 使用方式：
 *   mosaiq detection-lab run <persona-id> [options]
 *   mosaiq personas list [--json]
 *
 * 路由策略：
 *   - 手工解析 argv[2] / argv[3]，subcommand 自己用 `node:util.parseArgs` 处理 flags
 *   - 没引 commander / yargs，避免新增运行时依赖
 *   - 已知 subcommand 无效时打印 usage + exit 2（CI 友好的错误码）
 *
 * 退出码（顶层）：
 *   0 = success / help
 *   1 = subcommand-specific failure（detection-lab run 在有 hits 时按策略退）
 *   2 = unknown subcommand / 参数错
 *   130 = SIGINT 取消
 */

import { runDetectionLabCommand } from './commands/detection-lab/run.js';
import { runPersonasList } from './commands/personas/list.js';
import { fmt } from './output.js';

const CLI_VERSION = '0.9.0-dev.0';

const USAGE = `Mosaiq CLI v${CLI_VERSION}

Usage:
  mosaiq <command> <subcommand> [args...]

Commands:
  detection-lab run <persona-id>    Run a Detection Lab pass for a persona
  personas list                     List all stored personas

Global:
  -h, --help                        Show this help (or per-command help)
  -v, --version                     Print CLI version

Examples:
  mosaiq personas list
  mosaiq detection-lab run baseline-bench-mp9itrpe
  mosaiq detection-lab run my-persona --only creepjs,sannysoft --headed
  mosaiq detection-lab run my-persona --json > run.json
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // Top-level flags
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  const top = argv[0];
  const sub = argv[1];
  const rest = argv.slice(2);

  if (top === 'detection-lab' && sub === 'run') {
    return runDetectionLabCommand(rest);
  }
  if (top === 'personas' && sub === 'list') {
    return runPersonasList(rest);
  }

  process.stderr.write(`${fmt.red(`Unknown command: ${top}${sub ? ` ${sub}` : ''}`)}\n\n${USAGE}`);
  return 2;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`${fmt.red('[mosaiq] uncaught error:')} ${err?.stack ?? err}\n`);
    process.exit(1);
  });
