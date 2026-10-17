// Manages a Pi child process in RPC mode with request correlation and event routing.
import { spawn } from 'node:child_process';
import { readLines } from './lines.mjs';
import { dirname } from 'node:path';

const log = (...args) => process.stderr.write(`[pi-rpc] ${args.join(' ')}\n`);

export class PiRpc {
  constructor({ piCommand, args, cwd, env, onEvent, onExtensionUI, onExit }) {
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._onEvent = onEvent;
    this._onExtensionUI = onExtensionUI;
    this._onExit = onExit;
    this._exited = false;
    this._stderrTail = '';
    this._child = null;
    this._piCommand = piCommand;
    this._args = args;
    this._cwd = cwd;
    this._env = env;
  }

  spawn() {
    const child = spawn(this._piCommand, this._args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this._cwd,
      env: this._env,
      detached: false,
    });
    this._child = child;
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      process.stderr.write(text);
      // Keep last 2KB of stderr for error reporting
      this._stderrTail = (this._stderrTail + text).slice(-2048);
    });

    readLines(child.stdout).on('line', line => {
      let record;
      try { record = JSON.parse(line); } catch { return; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) return;
      this._dispatch(record);
    });

    child.on('close', (code, signal) => {
      this._exited = true;
      // Fail all pending requests
      for (const [id, entry] of this._pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Pi exited (${signal ?? `code ${code}`})${this._stderrTail ? `: ${this._stderrTail.trim().split('\n').pop()}` : ''}`));
      }
      this._pending.clear();
      this._onExit?.(code, signal);
    });
    child.on('error', err => {
      log('spawn error:', err.message);
    });
    return child;
  }

  _dispatch(record) {
    // Response to a command we sent
    if (record.type === 'response') {
      const entry = this._pending.get(record.id);
      if (entry) {
        this._pending.delete(record.id);
        clearTimeout(entry.timer);
        if (record.success === false) {
          entry.reject(Object.assign(new Error(record.error ?? 'Pi command failed'), { piError: true }));
        } else {
          entry.resolve(record.data);
        }
      }
      return;
    }
    // Extension UI request from pi
    if (record.type === 'extension_ui_request') {
      this._onExtensionUI?.(record);
      return;
    }
    // Session event
    this._onEvent?.(record);
  }

  // Send a command to pi, returns a promise for the response data
  send(type, params = {}, { timeout = 30000, id } = {}) {
    if (this._exited) return Promise.reject(new Error('Pi process has exited'));
    const reqId = id ?? String(this._nextId++);
    const command = { id: reqId, type, ...params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`Pi command ${type} timed out after ${timeout}ms`));
      }, timeout);
      this._pending.set(reqId, { resolve, reject, timer });
      this._child.stdin.write(JSON.stringify(command) + '\n');
    });
  }

  // Send a fire-and-forget record (no response expected, like extension_ui_response)
  write(record) {
    if (this._exited || !this._child) return;
    this._child.stdin.write(JSON.stringify(record) + '\n');
  }

  kill(signal = 'SIGTERM') {
    if (!this._child || this._exited) return;
    try { this._child.kill(signal); } catch {}
  }

  get exited() { return this._exited; }
  get stderrTail() { return this._stderrTail; }

  close() {
    if (!this._child || this._exited) return;
    try { this._child.stdin.end(); } catch {}
  }
}
