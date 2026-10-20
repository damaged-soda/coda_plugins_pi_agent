// Coda's 「准备运行环境」 for Pi (Coda docs/plugins.md「准备运行环境」): Pi there to start, or installed. A Pi this machine
// has of its own (the path set in Coda, the PATH, the usual install directories) is used as it is; with none, the latest
// `@earendil-works/pi-coding-agent` is installed into this plugin's state with Coda's own Node and npm, where the agent
// finds it (`agent/pi-command.mjs`). A path set in Coda that does not run is said, not installed over. Run again, it finds
// what it installed and is done at once.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE, findPi, managedPrefix } from './pi-command.mjs';

// With Coda's Node first on the PATH: Pi's command, and npm's, are Node scripts.
const withNode = (env, node) => ({ ...env, PATH: [dirname(node), env.PATH].filter(Boolean).join(delimiter) });

// What a Pi says it is; null when it does not run.
export function versionOf(command, { env = process.env, node = process.execPath, run = spawnSync } = {}) {
  const result = run(command, ['--version'], { encoding: 'utf8', timeout: 20_000, env: withNode(env, node) });
  return result.status === 0 ? result.stdout.trim().split('\n').pop() || '?' : null;
}

// 0 once Pi runs here; 1 with the reason as the last line, which Coda shows.
export function setup({ env = process.env, node = process.execPath, run = spawnSync, find = findPi, exists = existsSync,
  say = line => process.stdout.write(`${line}\n`), fail = line => process.stderr.write(`${line}\n`) } = {}) {
  const settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}');
  const found = find(settings, { env });
  const version = found === 'pi' ? null : versionOf(found, { env, node, run });
  if (version) { say(`已有 Pi ${version}：${found}`); return 0; }
  const configured = settings['pi.commandPath'];
  if (configured && configured !== 'pi') { fail(`设置里的 Pi 路径 ${configured} 运行不了：改正它，或改回 pi 由插件安装`); return 1; }
  const prefix = managedPrefix(env), npm = join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!prefix) { fail(`这个后端没有插件状态目录，装不了 Pi：请自己安装 npm i -g ${PACKAGE}`); return 1; }
  if (!exists(npm)) { fail(`Coda 的 Node 没带 npm（${npm}），装不了 Pi：请自己安装 npm i -g ${PACKAGE}`); return 1; }
  say(`没有找到 Pi，安装 ${PACKAGE} 到 ${prefix}`);
  const installed = run(node, [npm, 'install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', '--no-update-notifier', PACKAGE],
    { stdio: 'inherit', timeout: 9 * 60_000, env: withNode(env, node) });
  if (installed.status !== 0) { fail(`安装 Pi 失败（npm ${installed.error?.message ?? `退出码 ${installed.status ?? installed.signal}`}），见上面的输出`); return 1; }
  const at = join(prefix, 'bin', 'pi'), now = versionOf(at, { env, node, run });
  if (!now) { fail(`装好了，但 ${at} 运行不了`); return 1; }
  say(`已安装 Pi ${now}：${at}`);
  return 0;
}

// Run as a command (Node names the module by its real path, so the path it was given is resolved the same way).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = setup();
