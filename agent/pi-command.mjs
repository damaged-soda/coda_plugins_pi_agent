// Where Pi is on this machine, as the agent starts it and as its setup looks for it: the path set in Coda
// (`pi.commandPath`), else the PATH, else the usual install directories, else the copy this plugin's setup installed in
// its own state (`agent/setup.mjs`). A Pi the machine has of its own is always taken before that copy.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const PACKAGE = '@earendil-works/pi-coding-agent';

// The npm prefix setup installs Pi into: the plugin's state, none for a backend without one.
export const managedPrefix = (env = process.env) => env.CODA_PLUGIN_STATE ? join(env.CODA_PLUGIN_STATE, 'pi') : null;

export function findPi(settings, { env = process.env, home = homedir(), exists = existsSync } = {}) {
  const configured = settings['pi.commandPath'];
  if (configured && configured !== 'pi') return configured;
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'pi')).find(exists);
  if (onPath) return onPath;
  const managed = managedPrefix(env);
  return [join(home, '.npm-global/bin/pi'), '/opt/homebrew/bin/pi', '/usr/local/bin/pi', join(home, '.local/bin/pi'), join(home, '.bun/bin/pi'),
    ...(managed ? [join(managed, 'bin', 'pi')] : [])].find(exists) ?? 'pi';
}
