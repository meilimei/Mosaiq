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

import { runDetectionLabCompare } from './commands/detection-lab/compare.js';
import { runDetectionLabDeleteRun } from './commands/detection-lab/delete-run.js';
import { runDetectionLabListRuns } from './commands/detection-lab/list-runs.js';
import { runDetectionLabCommand } from './commands/detection-lab/run.js';
import { runDetectionLabShowRun } from './commands/detection-lab/show-run.js';
import { runPersonasCreate } from './commands/personas/create.js';
import { runPersonasDelete } from './commands/personas/delete.js';
import { runPersonasList } from './commands/personas/list.js';
import { runPersonasShow } from './commands/personas/show.js';
import { runPersonasTemplatesList } from './commands/personas/templates.js';
import { fmt } from './output.js';

const CLI_VERSION = '0.9.0-dev.0';

const USAGE = `Mosaiq CLI v${CLI_VERSION}

Usage:
  mosaiq <command> <subcommand> [args...]

Commands:
  detection-lab run         <persona-id>                     Run a Detection Lab pass
  detection-lab list-runs   <persona-id>                     List historical runs
  detection-lab show-run    <persona-id> <run-id>            Print a saved run
  detection-lab delete-run  <persona-id> <run-id>            Delete a saved run
  detection-lab compare     <persona-id> <run-a> <run-b>     Diff two runs (B - A)
  personas      list                                         List all stored personas
  personas      show        <persona-id>                     Print one persona's details
  personas      create      <persona-id>                     Create a new persona from a template
  personas      delete      <persona-id>                     Delete a persona JSON
  personas      templates   list                             List available persona templates

Global:
  -h, --help                        Show this help (or per-command help)
  -v, --version                     Print CLI version

Examples:
  mosaiq personas list
  mosaiq personas templates list
  mosaiq personas create reddit-alice --template win11-chrome-us --display-name "Reddit Alice"
  mosaiq personas show reddit-alice
  mosaiq personas delete reddit-alice --yes
  mosaiq detection-lab run baseline-bench-mp9itrpe
  mosaiq detection-lab list-runs baseline-bench-mp9itrpe
  mosaiq detection-lab show-run baseline-bench-mp9itrpe 2026-05-19T11-01-32-216Z
  mosaiq detection-lab delete-run baseline-bench-mp9itrpe 2026-... --yes
  mosaiq detection-lab compare baseline-bench-mp9itrpe 2026-05-18T... 2026-05-19T... --fail-on-regression
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
  if (top === 'detection-lab' && sub === 'list-runs') {
    return runDetectionLabListRuns(rest);
  }
  if (top === 'detection-lab' && sub === 'show-run') {
    return runDetectionLabShowRun(rest);
  }
  if (top === 'detection-lab' && sub === 'delete-run') {
    return runDetectionLabDeleteRun(rest);
  }
  if (top === 'detection-lab' && sub === 'compare') {
    return runDetectionLabCompare(rest);
  }
  if (top === 'personas' && sub === 'list') {
    return runPersonasList(rest);
  }
  if (top === 'personas' && sub === 'show') {
    return runPersonasShow(rest);
  }
  if (top === 'personas' && sub === 'create') {
    return runPersonasCreate(rest);
  }
  if (top === 'personas' && sub === 'delete') {
    return runPersonasDelete(rest);
  }
  // `personas templates list` —— 三段式 subcommand。`personas templates`
  // 没有 `list` 后缀的孤儿调用直接打印帮助（按 `templates list` 的别名兜底）。
  if (top === 'personas' && sub === 'templates') {
    const templatesSub = rest[0];
    if (templatesSub === undefined || templatesSub === 'list') {
      return runPersonasTemplatesList(templatesSub === 'list' ? rest.slice(1) : rest);
    }
    process.stderr.write(
      `${fmt.red(`Unknown subcommand: personas templates ${templatesSub}`)}\n\n${USAGE}`,
    );
    return 2;
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
