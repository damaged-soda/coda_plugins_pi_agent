// Pi Agent entry: speaks ACP to Coda on stdio, spawns `pi --mode rpc` as a child.
import { randomUUID, createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readLines } from './lines.mjs';
import { PiRpc } from './pi-rpc.mjs';
import { findPi } from './pi-command.mjs';
import { classifyPiFailure, isPiAuthError, getBase64DecodedSize } from './errors.mjs';

const log = (...args) => process.stderr.write(`[pi-agent] ${args.join(' ')}\n`);

// ---- JSON-RPC helpers ----
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const reply = (id, result) => send({ id, result });
const refuse = (id, code, message, data) => send({ id, error: { code, message, ...(data ? { data } : {}) } });
const notify = (method, params) => send({ method, params });

// ---- Settings ----
const settings = (() => {
  try { return JSON.parse(process.env.CODA_PLUGIN_SETTINGS || '{}'); } catch { return {}; }
})();
const pluginState = process.env.CODA_PLUGIN_STATE || join(tmpdir(), 'pi-agent-state');
const pluginPath = process.env.CODA_PLUGIN_PATH || '.';
const codaNode = process.env.CODA_NODE || process.execPath;

// ---- State ----
let initParams = null;
const sessions = new Map(); // sessionId -> SessionState
const loadingSessions = new Set();

class SessionState {
  constructor(sessionId, cwd) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.pi = null;
    this.systemPromptFile = null;
    this.extraArgs = [];
    this.ensuring = null;
    this.turn = null; // { resolve, reject, updates, text, cancelled, steered }
    this.models = [];
    this.thinkingLevels = [];
    this.currentModelValue = null;
    this.currentThinkingLevel = null;
    this.chosenModelValue = null;
    this.chosenThinkingLevel = null;
    this.commands = [];
    this.configOptions = [];
    this.elicitationSupported = false;
  }
}

// Where Pi is: a path set in Coda, the PATH, the usual directories, else the copy setup installed (agent/pi-command.mjs).
const piCommand = findPi(settings);

// ---- Model value encoding ----
function modelValue(model) {
  return `${model.provider}/${model.id}`;
}
function parseModelValue(value) {
  const slash = value.indexOf('/');
  if (slash < 0) return { provider: value, modelId: value };
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

// ---- Build config options from pi state ----
function buildConfigOptions(session) {
  const opts = [];
  // Model select
  if (session.models.length > 0 && session.currentModelValue) {
    opts.push({
      id: 'model',
      name: '模型',
      type: 'select',
      category: 'model',
      currentValue: session.currentModelValue,
      options: session.models.map(m => ({
        value: modelValue(m),
        name: m.name || m.id,
      })),
    });
  }
  // Thinking level select (only if model supports reasoning)
  if (session.thinkingLevels.length > 1 || (session.thinkingLevels.length === 1 && session.thinkingLevels[0] !== 'off')) {
    opts.push({
      id: 'thinking',
      name: '推理强度',
      type: 'select',
      category: 'thought_level',
      currentValue: session.currentThinkingLevel ?? 'medium',
      options: session.thinkingLevels.map(level => ({
        value: level,
        name: level,
      })),
    });
  }
  session.configOptions = opts;
  return opts;
}

// ---- Build available commands ----
function buildAvailableCommands(session) {
  return session.commands.map(cmd => ({
    name: cmd.name,
    description: cmd.description || '',
  })).filter(cmd => cmd.name);
}

function notifyAvailableCommands(session) {
  const commands = buildAvailableCommands(session);
  if (!commands.length) return;
  setImmediate(() => {
    notify('session/update', {
      sessionId: session.sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
    });
  });
}

function assertContained(targetPath, baseDir) {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw Object.assign(new Error(`Path traversal detected: ${targetPath} is outside ${baseDir}`), { code: -32602 });
  }
  return resolvedTarget;
}

async function ensurePiRunning(session) {
  while (session.ensuring) {
    await session.ensuring;
  }
  if (session.pi && !session.pi.exited && session.pi.ready) return;
  session.ensuring = (async () => {
    try {
      await spawnPi(session, session.systemPromptFile, session.extraArgs);
      session.pi.ready = false;

      if (session.chosenModelValue && session.currentModelValue !== session.chosenModelValue) {
        let reapplyFailed = false;
        let failError = null;
        try {
          const { provider, modelId } = parseModelValue(session.chosenModelValue);
          const res = await session.pi.send('set_model', { provider, modelId }, { timeout: 15000 });
          if (!res) throw new Error('set_model returned falsy');
          session.currentModelValue = session.chosenModelValue;
          try {
            const levels = await session.pi.send('get_available_thinking_levels', {}, { timeout: 10000 });
            session.thinkingLevels = levels?.levels ?? [];
            const state = await session.pi.send('get_state', {}, { timeout: 10000 });
            session.currentThinkingLevel = state.thinkingLevel ?? null;
          } catch {}
        } catch (e) {
          reapplyFailed = true;
          failError = e;
          log('Failed to re-apply chosen model after respawn:', e.message);
        }
        if (reapplyFailed) {
          try {
            const refreshed = await session.pi.send('get_state', {}, { timeout: 10000 });
            session.currentModelValue = refreshed?.model ? modelValue(refreshed.model) : null;
            session.currentThinkingLevel = refreshed?.thinkingLevel ?? null;
          } catch {}
          session.chosenModelValue = session.currentModelValue;
          if (session.pi) session.pi.ready = true;
          const configOptions = buildConfigOptions(session);
          notify('session/update', {
            sessionId: session.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions },
          });
          throw Object.assign(
            new Error(`Pi 重启后无法恢复之前选择的模型（${session.chosenModelValue}）：${failError?.message || '未知错误'}`),
            { code: -32603 }
          );
        }
      }

      if (session.chosenThinkingLevel && session.currentThinkingLevel !== session.chosenThinkingLevel) {
        let reapplyFailed = false;
        let failError = null;
        try {
          const res = await session.pi.send('set_thinking_level', { level: session.chosenThinkingLevel }, { timeout: 10000 });
          if (!res) throw new Error('set_thinking_level returned falsy');
          session.currentThinkingLevel = session.chosenThinkingLevel;
        } catch (e) {
          reapplyFailed = true;
          failError = e;
          log('Failed to re-apply chosen thinking level after respawn:', e.message);
        }
        if (reapplyFailed) {
          try {
            const refreshed = await session.pi.send('get_state', {}, { timeout: 10000 });
            session.currentThinkingLevel = refreshed?.thinkingLevel ?? null;
          } catch {}
          session.chosenThinkingLevel = session.currentThinkingLevel;
          if (session.pi) session.pi.ready = true;
          const configOptions = buildConfigOptions(session);
          notify('session/update', {
            sessionId: session.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions },
          });
          throw Object.assign(
            new Error(`Pi 重启后无法恢复之前选择的推理强度（${session.chosenThinkingLevel}）：${failError?.message || '未知错误'}`),
            { code: -32603 }
          );
        }
      }

      session.pi.ready = true;
      buildConfigOptions(session);
    } finally {
      session.ensuring = null;
    }
  })();

  await session.ensuring;
}

// ---- Spawn pi for a session ----
async function spawnPi(session, systemPromptFile, extraArgs = []) {
  const args = ['--mode', 'rpc', '--session-id', session.sessionId, ...extraArgs];
  // The providers set in Coda (`pi.providers`), registered by an extension that lists their models as Pi starts.
  if (Object.keys(settings['pi.providers'] ?? {}).length) args.push('--extension', join(pluginPath, 'agent', 'providers.mjs'));
  if (systemPromptFile) {
    args.push('--append-system-prompt', systemPromptFile);
  }
  // Extra CLI args from settings
  const extraCliArgs = settings['pi.extraArgs'];
  if (extraCliArgs) {
    if (Array.isArray(extraCliArgs)) args.push(...extraCliArgs);
    else if (typeof extraCliArgs === 'string') args.push(...extraCliArgs.split(/\s+/).filter(Boolean));
  }

  // Use the machine's own Pi configuration, credentials, extensions and session
  // store as-is (PI_CODING_AGENT_DIR or ~/.pi/agent), so sessions also show up
  // in `pi --resume`.
  const env = { ...process.env };
  const nodeDir = dirname(codaNode);
  let pathVal = env.PATH || '';
  if (isAbsolute(piCommand)) {
    const piDir = dirname(piCommand);
    if (!pathVal.split(':').includes(piDir)) {
      pathVal = `${piDir}:${pathVal}`;
    }
  }
  if (!pathVal.split(':').includes(nodeDir)) {
    pathVal = `${nodeDir}:${pathVal}`;
  }
  env.PATH = pathVal;

  const pi = new PiRpc({
    piCommand,
    args,
    cwd: session.cwd,
    env,
    onEvent: record => handlePiEvent(session, record),
    onExtensionUI: record => handleExtensionUI(session, record),
    onExit: (code, signal) => handlePiExit(session, pi, code, signal),
  });
  pi.spawn();
  session.pi = pi;

  try {
  // Query initial state
  try {
    const state = await pi.send('get_state', {}, { timeout: 15000 });
    if (state.model) {
      session.currentModelValue = modelValue(state.model);
    }
    session.currentThinkingLevel = state.thinkingLevel ?? null;
  } catch (e) {
    log('get_state failed:', e.message);
  }

  let modelsData;
  try {
    modelsData = await pi.send('get_available_models', {}, { timeout: 15000 });
  } catch (e) {
    // Pi failed to start or answer: a normal error, not "not logged in".
    const tail = pi.stderrTail.trim().split('\n').slice(-5).join('\n');
    throw Object.assign(new Error(`Pi 启动失败：${e.message}${tail && !e.message.includes(tail) ? `\n${tail}` : ''}`), { code: -32603 });
  }
  session.models = modelsData?.models ?? [];

  if (session.models.length === 0) {
    throw Object.assign(new Error('Pi 没有可用的模型。请先配置 Pi 的 provider 和登录信息。'), { code: -32000 });
  }

  if (!session.currentModelValue) {
    let fallbackSucceeded = false;
    for (const m of session.models) {
      try {
        const res = await pi.send('set_model', { provider: m.provider, modelId: m.id }, { timeout: 15000 });
        if (res) {
          fallbackSucceeded = true;
          break;
        }
      } catch (e) {
        log(`set_model fallback failed for ${m.provider}/${m.id}:`, e.message);
      }
    }
    if (!fallbackSucceeded) {
      throw Object.assign(new Error('Pi 没有可用的默认模型，尝试切换全部可用模型均失败。'), { code: -32603 });
    }
    try {
      const refreshedState = await pi.send('get_state', {}, { timeout: 15000 });
      if (refreshedState?.model) {
        session.currentModelValue = modelValue(refreshedState.model);
      }
      session.currentThinkingLevel = refreshedState?.thinkingLevel ?? null;
    } catch (e) {
      log('get_state refresh failed:', e.message);
    }
    if (!session.currentModelValue) {
      throw Object.assign(new Error('Pi 没有可用的默认模型。'), { code: -32603 });
    }
  }

  try {
    const levels = await pi.send('get_available_thinking_levels', {}, { timeout: 10000 });
    session.thinkingLevels = levels?.levels ?? [];
  } catch (e) {
    log('get_available_thinking_levels failed:', e.message);
  }

  try {
    const cmds = await pi.send('get_commands', {}, { timeout: 10000 });
    session.commands = cmds?.commands ?? [];
  } catch (e) {
    log('get_commands failed:', e.message);
  }

  buildConfigOptions(session);
  notifyAvailableCommands(session);
  pi.ready = true;
  } catch (err) {
    try {
      pi.close();
      pi.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        try { pi.kill('SIGKILL'); } catch {}
      }, 500);
      killTimer.unref?.();
    } catch {}
    session.pi = null;
    throw err;
  }
}

// ---- Handle pi events ----
function handlePiEvent(session, record) {
  // Session-level events (occur whether or not a turn is active)
  if (record.type === 'session_info_changed') {
    notify('session/update', {
      sessionId: session.sessionId,
      update: { sessionUpdate: 'session_info_update', title: record.name || null },
    });
    return;
  }
  if (record.type === 'thinking_level_changed') {
    session.currentThinkingLevel = record.level;
    const configOptions = buildConfigOptions(session);
    notify('session/update', {
      sessionId: session.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    });
    return;
  }

  const turn = session.turn;
  if (!turn) return;

  // Cancellation is read before anything later in the input stream. Once read,
  // Pi is told to stop and no more work updates are reported for this turn.
  if (turn.cancelled && record.type !== 'agent_settled') return;

  if (record.type === 'agent_settled' && !turn.cancelled && record.aborted) {
    turn.stopReason = 'cancelled';
  }

  switch (record.type) {
    case 'message_update': {
      const evt = record.assistantMessageEvent;
      if (!evt) break;
      if (evt.type === 'text_delta') {
        notify('session/update', {
          sessionId: session.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: evt.delta } },
        });
        turn.text += evt.delta;
      } else if (evt.type === 'thinking_delta') {
        notify('session/update', {
          sessionId: session.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: evt.delta } },
        });
      }
      break;
    }
    case 'tool_execution_start': {
      const kind = mapToolKind(record.toolName);
      const title = toolTitle(record.toolName, record.args);
      const locations = toolLocations(record.toolName, record.args);
      notify('session/update', {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: record.toolCallId,
          title,
          kind,
          status: 'in_progress',
          rawInput: record.args,
          ...(locations.length ? { locations } : {}),
        },
      });
      break;
    }
    case 'tool_execution_update': {
      const blocks = mapToolResultContent(record.partialResult?.content);
      if (blocks.length) {
        notify('session/update', {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: record.toolCallId,
            content: blocks,
            status: 'in_progress',
          },
        });
      }
      break;
    }
    case 'tool_execution_end': {
      const blocks = mapToolResultContent(record.result?.content);
      notify('session/update', {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: record.toolCallId,
          content: blocks,
          status: record.isError ? 'failed' : 'completed',
          rawOutput: record.result,
        },
      });
      break;
    }
    case 'auto_retry_end': {
      if (record.success === false && record.finalError) {
        turn.finalRetryError = record.finalError;
      }
      break;
    }
    case 'agent_settled': {
      if (turn.cancelled || record.aborted) {
        turn.stopReason = 'cancelled';
      }
      turn.settled = true;
      turn.settledAborted = Boolean(record.aborted);
      finishTurn(session, turn);
      break;
    }
    case 'agent_end': {
      // Store info from agent_end but don't finish yet (wait for agent_settled)
      turn.lastWillRetry = Boolean(record.willRetry);
      if (record.willRetry) break;
      turn.lastStopReason = null;
      turn.errorMessage = null;
      turn.finalRetryError = null;
      const messages = record.messages ?? [];
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        if (lastAssistant.stopReason === 'length') turn.lastStopReason = 'max_tokens';
        else if (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted') {
          turn.lastStopReason = lastAssistant.stopReason;
          turn.errorMessage = lastAssistant.errorMessage;
        } else {
          turn.lastStopReason = lastAssistant.stopReason ?? null;
          turn.errorMessage = null;
        }
      }
      break;
    }
    default:
      break;
  }
}

function finishTurn(session, targetTurn) {
  const turn = targetTurn || session.turn;
  if (!turn || !turn.settled) return;
  if (session.turn !== turn) return;
  session.turn = null;
  clearPendingExtUI(session);

  let stopReason = turn.stopReason || 'end_turn';
  if (turn.cancelled) stopReason = 'cancelled';
  else if (turn.lastStopReason === 'max_tokens') stopReason = 'max_tokens';

  // Check for error
  if (turn.lastStopReason === 'error' && !turn.cancelled) {
    const errorText = turn.finalRetryError || turn.errorMessage || 'Pi 返回了错误，但没有附带错误信息';
    const canTag = ['started', 'queued'].includes(turn.disposition) &&
      !turn.settledAborted &&
      !turn.cancelled &&
      turn.lastWillRetry === false;
    const failure = canTag ? classifyPiFailure(errorText) : null;
    const err = {
      code: -32603,
      message: errorText,
      ...(failure ? { data: { _meta: { coda: { failure } } } } : {}),
    };
    turn.reject?.(err);
    return;
  }

  turn.resolve?.({ stopReason });
}

// ---- Tool kind mapping ----
function mapToolKind(toolName) {
  if (!toolName) return 'other';
  const name = toolName.toLowerCase();
  if (name === 'read' || name === 'readfile' || name === 'read_file' || name === 'cat') return 'read';
  if (name === 'edit' || name === 'write' || name === 'writefile' || name === 'write_file' ||
      name === 'multiedit' || name === 'multi_edit' || name === 'patch' || name === 'applydiff') return 'edit';
  if (name === 'bash' || name === 'shell' || name === 'execute' || name === 'run') return 'execute';
  if (name === 'grep' || name === 'search' || name === 'find' || name === 'glob' ||
      name === 'ls' || name === 'list' || name === 'ripgrep') return 'search';
  return 'other';
}

function toolTitle(toolName, args) {
  if (!args) return toolName;
  const keyArg = args.command ?? args.path ?? args.file ?? args.pattern ?? args.query ?? '';
  const short = typeof keyArg === 'string' && keyArg.length > 60 ? keyArg.slice(0, 57) + '...' : keyArg;
  return short ? `${toolName}: ${short}` : toolName;
}

function toolLocations(toolName, args) {
  const locs = [];
  const path = args?.path ?? args?.file;
  if (typeof path === 'string') {
    locs.push({ path });
  }
  return locs;
}

function mapToolResultContent(contentArray) {
  if (!Array.isArray(contentArray)) return [];
  const blocks = [];
  for (const block of contentArray) {
    if (!block) continue;
    if (block.type === 'image' && block.data) {
      blocks.push({
        type: 'content',
        content: {
          type: 'image',
          data: block.data,
          mimeType: block.mimeType || 'image/png',
        },
      });
    } else if (block.type === 'text' || typeof block.text === 'string') {
      const text = block.text ?? '';
      if (text) {
        blocks.push({
          type: 'content',
          content: { type: 'text', text },
        });
      }
    }
  }
  return blocks;
}

function clearPendingExtUI(session) {
  if (!session._pendingExtUI || session._pendingExtUI.size === 0) return;
  for (const [reqId, pending] of session._pendingExtUI) {
    if (pending.timer) clearTimeout(pending.timer);
    notify('$/cancel_request', { requestId: reqId });
    session.pi?.write({ type: 'extension_ui_response', id: pending.piId, cancelled: true });
  }
  session._pendingExtUI.clear();
}

// ---- Handle extension UI requests from pi ----
function handleExtensionUI(session, record) {
  const turn = session.turn;
  const method = record.method;

  // Fire-and-forget methods: just log or map
  if (['notify', 'setStatus', 'setWidget', 'set_editor_text'].includes(method)) {
    return;
  }
  if (method === 'setTitle') {
    if (record.title) {
      notify('session/update', {
        sessionId: session.sessionId,
        update: { sessionUpdate: 'session_info_update', title: record.title },
      });
    }
    return;
  }

  // Dialog methods: only forward while a turn is in progress
  if (!turn || turn.cancelled) {
    // Outside a turn, cancel immediately
    session.pi.write({ type: 'extension_ui_response', id: record.id, cancelled: true });
    return;
  }

  if (method === 'confirm') {
    handleConfirm(session, record);
  } else if (method === 'select') {
    handleSelect(session, record);
  } else if (method === 'input' || method === 'editor') {
    handleInput(session, record);
  } else {
    // Unknown dialog, cancel
    session.pi.write({ type: 'extension_ui_response', id: record.id, cancelled: true });
  }
}

// confirm -> ACP session/request_permission
function handleConfirm(session, record) {
  const reqId = randomUUID();
  const title = record.title ?? '';
  const message = record.message ?? '';
  // Map to permission request with allow_once / reject_once
  send({
    id: reqId,
    method: 'session/request_permission',
    params: {
      sessionId: session.sessionId,
      toolCall: {
        toolCallId: `ext-${record.id}`,
        title: `${title}${message ? `: ${message}` : ''}`,
        kind: 'other',
        status: 'pending',
      },
      options: [
        { optionId: 'allow', name: '允许', kind: 'allow_once' },
        { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
      ],
    },
  });
  let timer = null;
  if (typeof record.timeout === 'number' && record.timeout > 0) {
    timer = setTimeout(() => {
      if (session._pendingExtUI?.has(reqId)) {
        session._pendingExtUI.delete(reqId);
        notify('$/cancel_request', { requestId: reqId });
      }
    }, record.timeout);
  }
  session._pendingExtUI = session._pendingExtUI || new Map();
  session._pendingExtUI.set(reqId, { piId: record.id, type: 'confirm', timer });
}

// select -> ACP elicitation/create
function handleSelect(session, record) {
  if (!session.elicitationSupported) {
    session.pi.write({ type: 'extension_ui_response', id: record.id, cancelled: true });
    return;
  }
  const schema = {
    type: 'object',
    required: ['choice'],
    properties: {
      choice: {
        type: 'string',
        title: record.title ?? 'Select',
        oneOf: (record.options ?? []).map(opt => ({ const: opt, title: opt })),
      },
    },
  };
  requestElicitation(session, record, 'select', schema);
}

// input/editor -> ACP elicitation/create
function handleInput(session, record) {
  if (!session.elicitationSupported) {
    session.pi.write({ type: 'extension_ui_response', id: record.id, cancelled: true });
    return;
  }
  const schema = {
    type: 'object',
    required: ['text'],
    properties: {
      text: {
        type: 'string',
        title: record.title ?? 'Input',
        ...(record.placeholder ? { description: record.placeholder } : {}),
        ...(record.prefill ? { default: record.prefill } : {}),
      },
    },
  };
  requestElicitation(session, record, 'input', schema);
}

function requestElicitation(session, record, type, schema) {
  const reqId = randomUUID();
  send({
    id: reqId,
    method: 'elicitation/create',
    params: {
      sessionId: session.sessionId,
      mode: 'form',
      message: record.title ?? '',
      requestedSchema: schema,
    },
  });
  let timer = null;
  if (typeof record.timeout === 'number' && record.timeout > 0) {
    timer = setTimeout(() => {
      if (session._pendingExtUI?.has(reqId)) {
        session._pendingExtUI.delete(reqId);
        notify('$/cancel_request', { requestId: reqId });
      }
    }, record.timeout);
  }
  session._pendingExtUI = session._pendingExtUI || new Map();
  session._pendingExtUI.set(reqId, { piId: record.id, type, timer });
}

// ---- Handle pi exit ----
function handlePiExit(session, pi, code, signal) {
  log(`Pi exited: ${signal ?? `code ${code}`}`);
  if (session.pi !== pi) return;
  session.pi = null;
  clearPendingExtUI(session);
  if (session.turn) {
    const turn = session.turn;
    session.turn = null;
    if (turn.cancelled) {
      turn.resolve?.({ stopReason: 'cancelled' });
    } else {
      turn.reject?.({
        code: -32603,
        message: `Pi 进程意外退出（${signal ?? `code ${code}`}）${pi?.stderrTail ? `\n${pi.stderrTail.trim().split('\n').slice(-3).join('\n')}` : ''}`,
      });
    }
  }
}

// ---- System prompt file ----
function writeSystemPrompt(sessionId, text) {
  const dir = join(pluginState, 'prompts');
  const file = join(dir, `${sessionId}.md`);
  assertContained(file, dir);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  writeFileSync(file, text, 'utf8');
  return file;
}

function validateSystemPrompt(systemPrompt) {
  if (systemPrompt === undefined || systemPrompt === null) return '';
  if (systemPrompt.mode !== 'append' || !Array.isArray(systemPrompt.content)
      || systemPrompt.content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) {
    throw Object.assign(new Error('systemPrompt 只支持 append 模式和文本块'), { code: -32602 });
  }
  return systemPrompt.content.map(block => block.text).join('\n').trim();
}

// ---- ACP request handlers ----
const methods = {
  initialize: (params) => {
    initParams = params;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { systemPrompt: {} },
      },
      _meta: { steering: { supported: true } },
      agentInfo: { name: 'Pi', version: '0.1.1' },
    };
  },

  'session/new': async (params) => {
    // Validate systemPrompt
    const sp = params.systemPrompt;
    if (sp && sp.mode !== 'append') {
      throw Object.assign(new Error(`不支持 systemPrompt 模式 ${sp.mode}`), { code: -32602 });
    }
    const text = validateSystemPrompt(sp);

    const sessionId = randomUUID();
    loadingSessions.add(sessionId);
    try {
      const cwd = params.cwd || process.cwd();
      const session = new SessionState(sessionId, cwd);

      // Check elicitation support
      session.elicitationSupported = !!initParams?.clientCapabilities?.elicitation?.form;

      // Write system prompt
      let promptFile = null;
      if (text) {
        promptFile = writeSystemPrompt(sessionId, text);
      }

      session.systemPromptFile = promptFile;
      session.extraArgs = [];

      try {
        await spawnPi(session, promptFile);
      } catch (e) {
        throw Object.assign(new Error(e.message), { code: e.code ?? -32603 });
      }

      sessions.set(sessionId, session);

      return { sessionId, configOptions: session.configOptions };
    } finally {
      loadingSessions.delete(sessionId);
    }
  },

  'session/load': async (params) => {
    const { sessionId } = params;
    if (!sessionId || typeof sessionId !== 'string') throw Object.assign(new Error('sessionId is required'), { code: -32602 });
    if (sessionId.length > 128 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
      throw Object.assign(new Error('无效的 sessionId'), { code: -32602 });
    }

    loadingSessions.add(sessionId);
    try {
      const sp = params.systemPrompt;
      if (sp && sp.mode !== 'append') {
        throw Object.assign(new Error(`不支持 systemPrompt 模式 ${sp.mode}`), { code: -32602 });
      }
      const text = validateSystemPrompt(sp);

      const cwd = params.cwd || process.cwd();
      const session = new SessionState(sessionId, cwd);
      session.elicitationSupported = !!initParams?.clientCapabilities?.elicitation?.form;

      let promptFile = null;
      if (text) {
        promptFile = writeSystemPrompt(sessionId, text);
      }

      session.systemPromptFile = promptFile;
      session.extraArgs = [];

      try {
        await spawnPi(session, promptFile);
      } catch (e) {
        throw Object.assign(new Error(e.message), { code: e.code ?? -32603 });
      }

      sessions.set(sessionId, session);

      return { configOptions: session.configOptions };
    } finally {
      loadingSessions.delete(sessionId);
    }
  },

  'session/set_config_option': async (params) => {
    const session = getSession(params.sessionId);
    await ensurePiRunning(session);
    const { configId, value } = params;

    if (configId === 'model') {
      const { provider, modelId } = parseModelValue(value);
      await session.pi.send('set_model', { provider, modelId }, { timeout: 15000 });
      session.chosenModelValue = value;
      session.currentModelValue = value;
      // Refresh thinking levels (they depend on model)
      try {
        const levels = await session.pi.send('get_available_thinking_levels', {}, { timeout: 10000 });
        session.thinkingLevels = levels?.levels ?? [];
        // Get current thinking level
        const state = await session.pi.send('get_state', {}, { timeout: 10000 });
        session.currentThinkingLevel = state.thinkingLevel ?? null;
      } catch {}
    } else if (configId === 'thinking') {
      await session.pi.send('set_thinking_level', { level: value }, { timeout: 10000 });
      session.chosenThinkingLevel = value;
      session.currentThinkingLevel = value;
    } else {
      throw Object.assign(new Error(`Unknown configId: ${configId}`), { code: -32602 });
    }

    return { configOptions: buildConfigOptions(session) };
  },

  'session/set_model': async (params) => {
    // Convenience alias
    return methods['session/set_config_option']({ ...params, configId: 'model', value: params.modelId });
  },

  'session/prompt': (params) => {
    const session = getSession(params.sessionId);
    if (session.turn) {
      throw Object.assign(new Error('已有一轮正在进行'), { code: -32603 });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const turn = {
        preparing: true,
        resolve: (val) => {
          if (settled) return;
          settled = true;
          if (session.turn === turn) session.turn = null;
          clearPendingExtUI(session);
          resolve(val);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          if (session.turn === turn) session.turn = null;
          clearPendingExtUI(session);
          if (turn.cancelled) {
            resolve({ stopReason: 'cancelled' });
            return;
          }
          const errObj = err instanceof Error ? err : Object.assign(new Error(err?.message || String(err)), { code: err?.code });
          if (err?.code !== undefined && errObj.code === undefined) errObj.code = err.code;
          if (err?.data !== undefined) errObj.data = err.data;
          reject(errObj);
        },
        text: '',
        cancelled: false,
        settled: false,
        settledAborted: false,
        disposition: null,
        stopReason: null,
        lastStopReason: null,
        errorMessage: null,
        lastWillRetry: null,
        finalRetryError: null,
        steered: null,
      };
      session.turn = turn;

      (async () => {
        try {
          await ensurePiRunning(session);
          if (session.turn !== turn || turn.cancelled || turn.settled) return;

          const { message: messageText, images } = await mapAcpPrompt(params.prompt, session.sessionId);
          if (session.turn !== turn || turn.cancelled || turn.settled) return;

          turn.preparing = false;
          const pi = session.pi;
          const piPrompt = { message: messageText };
          if (images.length) piPrompt.images = images;

          pi.send('prompt', piPrompt, { timeout: 300000 })
            .then(data => {
              if (session.turn === turn && session.pi === pi) {
                turn.disposition = data?.disposition;
                if (data?.disposition === 'handled') {
                  turn.settled = true;
                  turn.stopReason = 'end_turn';
                  finishTurn(session, turn);
                }
              }
            })
            .catch(err => {
              if (session.turn === turn && session.pi === pi) {
                if (turn.cancelled) {
                  turn.resolve({ stopReason: 'cancelled' });
                  return;
                }
                const isAuth = isPiAuthError(err.message);
                turn.reject({ code: isAuth ? -32000 : -32603, message: err.message });
              }
            });
        } catch (err) {
          if (session.turn === turn && !turn.settled) {
            if (turn.cancelled) {
              turn.resolve({ stopReason: 'cancelled' });
            } else {
              turn.reject(err);
            }
          }
        }
      })();
    });
  },

  '_session/steering': async (params) => {
    const session = sessions.get(params.sessionId);
    if (!session) return { outcome: 'promptRequired', reason: 'noRunningTurn' };

    const turn = session.turn;
    const pi = session.pi;
    if (!turn || turn.preparing || turn.cancelled || turn.settled || !pi || pi.exited || !pi.ready || session.ensuring) {
      return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    }

    // Send steer to pi
    let message, images;
    try {
      const mapped = await mapAcpPrompt(params.prompt, session.sessionId);
      message = mapped.message;
      images = mapped.images;
    } catch (e) {
      log('steer mapAcpPrompt failed:', e.message);
      return { outcome: 'failed' };
    }
    const steerCmd = { message };
    if (images.length) steerCmd.images = images;
    try {
      await pi.send('steer', steerCmd, { timeout: 30000 });
      if (session.turn === turn && !turn.settled && !turn.cancelled && session.pi === pi) {
        return { outcome: 'injected' };
      }
      return { outcome: 'failed' };
    } catch (e) {
      log('steer failed:', e.message);
      const turnEnded = session.turn !== turn || turn.settled || turn.cancelled;
      if (turnEnded && e.piError === true) {
        return { outcome: 'promptRequired', reason: 'noRunningTurn' };
      }
      return { outcome: 'failed' };
    }
  },
};

const MAX_BLOB_SIZE = 50 * 1024 * 1024; // 50 MiB

function getSanitizedBasename(uri, mimeType) {
  let name = '';
  if (uri) {
    try {
      const u = new URL(uri);
      name = u.pathname.split('/').filter(Boolean).pop() || '';
    } catch {
      name = uri.split(/[/\\?#]/).filter(Boolean).pop() || '';
    }
  }
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!name || name === '.' || name === '..') {
    name = 'attachment';
  }
  if (!name.includes('.')) {
    const ext = mimeType?.split('/')[1]?.split(';')[0]?.replace(/[^a-zA-Z0-9]/g, '');
    if (ext) name += `.${ext}`;
  }
  if (name.length > 80) {
    name = name.slice(0, 80);
  }
  return name;
}

async function mapAcpPrompt(blocks, sessionId) {
  let message = '';
  const images = [];
  let attachmentIndex = 0;
  for (const block of (blocks ?? [])) {
    if (block.type === 'text') {
      message += (message ? '\n' : '') + block.text;
    } else if (block.type === 'image') {
      if (block.data) {
        if (getBase64DecodedSize(block.data) > MAX_BLOB_SIZE) {
          throw Object.assign(new Error('附件大小超过 50 MiB 限制'), { code: -32602 });
        }
        images.push({ type: 'image', data: block.data, mimeType: block.mimeType ?? 'image/png' });
      }
    } else if (block.type === 'resource_link') {
      const ref = block.uri ?? block.path ?? '';
      if (ref) message += (message ? '\n' : '') + ref;
    } else if (block.type === 'resource') {
      const res = block.resource;
      if (res?.text) {
        message += (message ? '\n' : '') + `--- ${res.uri ?? 'resource'} ---\n${res.text}\n---`;
      } else if (res?.blob) {
        if (getBase64DecodedSize(res.blob) > MAX_BLOB_SIZE) {
          throw Object.assign(new Error('附件大小超过 50 MiB 限制'), { code: -32602 });
        }
        const mime = res.mimeType ?? '';
        const buf = Buffer.from(res.blob, 'base64');
        if (buf.length > MAX_BLOB_SIZE) {
          throw Object.assign(new Error('附件大小超过 50 MiB 限制'), { code: -32602 });
        }
        if (mime.startsWith('image/')) {
          images.push({ type: 'image', data: res.blob, mimeType: mime || 'image/png' });
        } else {
          const stateDir = process.env.CODA_PLUGIN_STATE || tmpdir();
          const attachmentsRoot = join(stateDir, 'attachments');
          const targetDir = join(attachmentsRoot, sessionId || 'global');
          assertContained(targetDir, attachmentsRoot);
          await fs.promises.mkdir(targetDir, { recursive: true });

          const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
          const sanitized = getSanitizedBasename(res.uri, mime);
          const safeFileName = `${attachmentIndex}-${hash}-${sanitized}`;
          const filePath = join(targetDir, safeFileName);
          assertContained(filePath, targetDir);

          try {
            await fs.promises.writeFile(filePath, buf);
          } catch (e) {
            throw Object.assign(new Error(`保存附件失败：${e.message}`), { code: -32603 });
          }

          attachmentIndex++;
          const uriStr = res.uri ?? 'attachment';
          const mimeStr = mime || 'application/octet-stream';
          message += (message ? '\n' : '') + `--- Resource attachment: ${filePath} (mime: ${mimeStr}, uri: ${uriStr}) ---`;
        }
      }
    }
  }
  return { message, images };
}

async function cleanupOldAttachments() {
  try {
    const stateDir = process.env.CODA_PLUGIN_STATE || tmpdir();
    const attachmentsRoot = join(stateDir, 'attachments');
    if (!existsSync(attachmentsRoot)) return;
    const entries = await fs.promises.readdir(attachmentsRoot, { withFileTypes: true });
    const now = Date.now();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionDirName = entry.name;
        if (sessions.has(sessionDirName) || loadingSessions.has(sessionDirName)) continue;
        try {
          const dirPath = join(attachmentsRoot, sessionDirName);
          const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
          let newestMtime = 0;
          for (const file of files) {
            try {
              const fileStat = await fs.promises.stat(join(dirPath, file.name));
              if (fileStat.mtimeMs > newestMtime) {
                newestMtime = fileStat.mtimeMs;
              }
            } catch {}
          }
          if (newestMtime === 0) {
            const dirStat = await fs.promises.stat(dirPath);
            newestMtime = dirStat.mtimeMs;
          }
          if (now - newestMtime > maxAgeMs) {
            await fs.promises.rm(dirPath, { recursive: true, force: true });
          }
        } catch {}
      }
    }
  } catch {}
}
cleanupOldAttachments().catch(() => {});

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw Object.assign(new Error(`没有会话 ${sessionId}`), { code: -32002 });
  return session;
}

// ---- Cancel handler (notification, no response) ----
function handleCancel(params) {
  const session = sessions.get(params.sessionId);
  if (!session) return;

  const turn = session.turn;
  const pi = session.pi;
  if (turn) {
    turn.cancelled = true;
    clearPendingExtUI(session);
    if (turn.preparing) {
      turn.settled = true;
      turn.stopReason = 'cancelled';
      if (session.turn === turn) session.turn = null;
      turn.resolve?.({ stopReason: 'cancelled' });
      return;
    }
    // Send clear_queue then abort to pi
    if (pi && !pi.exited) {
      pi.send('clear_queue', {}, { timeout: 5000 }).catch(() => {});
      pi.send('abort', {}, { timeout: 10000 })
        .then(() => {
          // Pi stopped; if turn still matches, finish it
          if (session.turn === turn && session.pi === pi && !turn.settled) {
            turn.settled = true;
            turn.stopReason = 'cancelled';
            finishTurn(session, turn);
          }
        })
        .catch(() => {
          // Pi hung; kill and finish only when session.turn === turn && session.pi === pi.
          // If the turn already settled via agent_settled, do nothing.
          if (session.turn === turn && session.pi === pi && !turn.settled) {
            pi.kill();
            turn.settled = true;
            turn.stopReason = 'cancelled';
            finishTurn(session, turn);
          }
        });
    }
  }
}

// ---- Handle responses from Coda (for permission/elicitation requests we sent) ----
function handleCodaResponse(message) {
  // Look through all sessions for pending ext UI
  for (const [sid, session] of sessions) {
    const pending = session._pendingExtUI?.get(message.id);
    if (!pending) continue;
    session._pendingExtUI.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (message.error) {
      log('extension_ui_response:', pending.piId, pending.type, 'cancelled');
      session.pi.write({ type: 'extension_ui_response', id: pending.piId, cancelled: true });
      return;
    }

    const result = message.result;
    if (pending.type === 'confirm') {
      const outcome = result?.outcome;
      if (outcome?.outcome === 'cancelled') {
        const resp = { type: 'extension_ui_response', id: pending.piId, cancelled: true };
        log('extension_ui_response:', pending.piId, pending.type, 'cancelled');
        session.pi.write(resp);
      } else if (outcome?.outcome === 'selected') {
        if (outcome.optionId === 'allow') {
          const resp = { type: 'extension_ui_response', id: pending.piId, confirmed: true };
          log('extension_ui_response:', pending.piId, pending.type, 'accepted');
          session.pi.write(resp);
        } else if (outcome.optionId === 'reject') {
          const resp = { type: 'extension_ui_response', id: pending.piId, confirmed: false };
          log('extension_ui_response:', pending.piId, pending.type, 'accepted');
          session.pi.write(resp);
        } else {
          const resp = { type: 'extension_ui_response', id: pending.piId, cancelled: true };
          log('extension_ui_response:', pending.piId, pending.type, 'cancelled');
          session.pi.write(resp);
        }
      } else {
        const resp = { type: 'extension_ui_response', id: pending.piId, cancelled: true };
        log('extension_ui_response:', pending.piId, pending.type, 'cancelled');
        session.pi.write(resp);
      }
      return;
    } else if (pending.type === 'select') {
      if (result?.action === 'accept' && result?.content?.choice !== undefined) {
        const resp = { type: 'extension_ui_response', id: pending.piId, value: result.content.choice };
        log('extension_ui_response:', pending.piId, pending.type, 'accepted');
        session.pi.write(resp);
      } else {
        const resp = { type: 'extension_ui_response', id: pending.piId, cancelled: true };
        log('extension_ui_response:', pending.piId, pending.type, 'cancelled');
        session.pi.write(resp);
      }
      return;
    } else if (pending.type === 'input') {
      if (result?.action === 'accept' && result?.content?.text !== undefined) {
        const resp = { type: 'extension_ui_response', id: pending.piId, value: result.content.text };
        log('extension_ui_response:', pending.piId, pending.type, 'accepted');
        session.pi.write(resp);
      } else {
        const resp = { type: 'extension_ui_response', id: pending.piId, cancelled: true };
        log('extension_ui_response:', pending.piId, pending.type, 'cancelled');
        session.pi.write(resp);
      }
      return;
    }
    return;
  }
}

// ---- Main message loop ----
readLines(process.stdin).on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  // Notification (no id)
  if (!('id' in message)) {
    if (message.method === 'session/cancel') handleCancel(message.params ?? {});
    return;
  }

  // Response from Coda (to our permission/elicitation requests)
  if ('result' in message || 'error' in message) {
    handleCodaResponse(message);
    return;
  }

  // Request from Coda
  const method = methods[message.method];
  if (!method) {
    refuse(message.id, -32601, `Method not found: ${message.method}`);
    return;
  }

  try {
    const result = await method(message.params ?? {});
    reply(message.id, result);
  } catch (error) {
    refuse(message.id, error.code ?? -32603, error.message, error.data);
  }
}).on('close', () => {
  // stdin closed: shut down all pi children
  for (const [sid, session] of sessions) {
    if (session.pi) {
      session.pi.close();
      session.pi.kill();
    }
  }
  process.exit(0);
});

// ---- Lifecycle: SIGTERM/SIGINT ----
function shutdown() {
  for (const session of sessions.values()) {
    if (session.pi && !session.pi.exited) {
      session.pi.kill('SIGTERM');
      session.pi.kill('SIGKILL');
    }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
