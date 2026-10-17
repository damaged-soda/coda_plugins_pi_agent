// Pi Agent entry: speaks ACP to Coda on stdio, spawns `pi --mode rpc` as a child.
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { readLines } from './lines.mjs';
import { PiRpc } from './pi-rpc.mjs';

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

class SessionState {
  constructor(sessionId, cwd) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.pi = null;
    this.turn = null; // { resolve, reject, updates, text, cancelled, steered }
    this.models = [];
    this.thinkingLevels = [];
    this.currentModelValue = null;
    this.currentThinkingLevel = null;
    this.commands = [];
    this.configOptions = [];
    this.elicitationSupported = false;
  }
}

function getPiCommand() {
  const configured = settings['pi.commandPath'];
  if (configured) return configured;
  try {
    const found = execSync('which pi', { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (found) return found;
  } catch {}
  const home = homedir();
  const candidates = [
    join(home, '.npm-global/bin/pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
    join(home, '.local/bin/pi'),
    join(home, '.bun/bin/pi'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'pi';
}

const piCommand = getPiCommand();

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
  if (session.models.length > 0) {
    opts.push({
      id: 'model',
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

// ---- Spawn pi for a session ----
async function spawnPi(session, systemPromptFile, extraArgs = []) {
  const args = ['--mode', 'rpc', '--session-id', session.sessionId, ...extraArgs];
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
  if (!env.PATH?.includes(nodeDir)) {
    env.PATH = `${nodeDir}:${env.PATH || ''}`;
  }

  const pi = new PiRpc({
    piCommand,
    args,
    cwd: session.cwd,
    env,
    onEvent: record => handlePiEvent(session, record),
    onExtensionUI: record => handleExtensionUI(session, record),
    onExit: (code, signal) => handlePiExit(session, code, signal),
  });
  pi.spawn();
  session.pi = pi;

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
}

// ---- Handle pi events ----
function handlePiEvent(session, record) {
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
      const content = record.partialResult?.content;
      const text = content?.map(c => c.text ?? '').join('') ?? '';
      if (text) {
        notify('session/update', {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: record.toolCallId,
            content: [{ type: 'content', content: { type: 'text', text } }],
            status: 'in_progress',
          },
        });
      }
      break;
    }
    case 'tool_execution_end': {
      const content = record.result?.content;
      const text = content?.map(c => c.text ?? '').join('') ?? '';
      notify('session/update', {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: record.toolCallId,
          content: text ? [{ type: 'content', content: { type: 'text', text } }] : [],
          status: record.isError ? 'failed' : 'completed',
        },
      });
      break;
    }
    case 'agent_settled': {
      if (turn.cancelled || record.aborted) {
        turn.stopReason = 'cancelled';
      }
      turn.settled = true;
      finishTurn(session);
      break;
    }
    case 'agent_end': {
      // Store info from agent_end but don't finish yet (wait for agent_settled)
      if (record.willRetry) break;
      const messages = record.messages ?? [];
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        if (lastAssistant.stopReason === 'length') turn.lastStopReason = 'max_tokens';
        else if (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted') {
          turn.lastStopReason = lastAssistant.stopReason;
          turn.errorMessage = lastAssistant.errorMessage;
        }
      }
      break;
    }
    case 'session_info_changed': {
      if (record.name !== undefined) {
        notify('session/update', {
          sessionId: session.sessionId,
          update: { sessionUpdate: 'session_info_update', ...(record.name ? { title: record.name } : {}) },
        });
      }
      break;
    }
    default:
      break;
  }
}

function finishTurn(session) {
  const turn = session.turn;
  if (!turn || !turn.settled) return;
  session.turn = null;

  let stopReason = turn.stopReason || 'end_turn';
  if (turn.cancelled) stopReason = 'cancelled';
  else if (turn.lastStopReason === 'max_tokens') stopReason = 'max_tokens';

  // Check for error
  if (turn.lastStopReason === 'error' && !turn.cancelled && turn.errorMessage) {
    turn.reject?.({ code: -32603, message: turn.errorMessage });
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

// ---- Handle extension UI requests from pi ----
function handleExtensionUI(session, record) {
  const turn = session.turn;
  const method = record.method;

  // Fire-and-forget methods: just log or map
  if (['notify', 'setStatus', 'setWidget', 'set_editor_text'].includes(method)) {
    // setTitle -> session_info_update
    if (method === 'setTitle' && record.title) {
      notify('session/update', {
        sessionId: session.sessionId,
        update: { sessionUpdate: 'session_info_update', title: record.title },
      });
    }
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
  if (!turn) {
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
  session._pendingExtUI = session._pendingExtUI || new Map();
  session._pendingExtUI.set(reqId, { piId: record.id, type: 'confirm' });
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
    params: { sessionId: session.sessionId, message: record.title ?? '', requestedSchema: schema },
  });
  session._pendingExtUI = session._pendingExtUI || new Map();
  session._pendingExtUI.set(reqId, { piId: record.id, type });
}

// ---- Handle pi exit ----
function handlePiExit(session, code, signal) {
  log(`Pi exited: ${signal ?? `code ${code}`}`);
  if (session.turn) {
    const turn = session.turn;
    session.turn = null;
    turn.reject?.({
      code: -32603,
      message: `Pi 进程意外退出（${signal ?? `code ${code}`}）${session.pi.stderrTail ? `\n${session.pi.stderrTail.trim().split('\n').slice(-3).join('\n')}` : ''}`,
    });
  }
}

// ---- System prompt file ----
function writeSystemPrompt(sessionId, text) {
  const dir = join(pluginState, 'prompts');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const file = join(dir, `${sessionId}.md`);
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
      agentInfo: { name: 'Pi', version: '0.1.0' },
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
    const cwd = params.cwd || process.cwd();
    const session = new SessionState(sessionId, cwd);

    // Check elicitation support
    session.elicitationSupported = !!initParams?.clientCapabilities?.elicitation?.form;

    // Write system prompt
    let promptFile = null;
    if (text) {
      promptFile = writeSystemPrompt(sessionId, text);
    }

    try {
      await spawnPi(session, promptFile);
    } catch (e) {
      throw Object.assign(new Error(e.message), { code: e.code ?? -32603 });
    }

    sessions.set(sessionId, session);

    return { sessionId, configOptions: session.configOptions };
  },

  'session/load': async (params) => {
    const { sessionId } = params;
    if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: -32602 });

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

    try {
      await spawnPi(session, promptFile);
    } catch (e) {
      throw Object.assign(new Error(e.message), { code: e.code ?? -32603 });
    }

    sessions.set(sessionId, session);

    return { sessionId, configOptions: session.configOptions };
  },

  'session/set_config_option': async (params) => {
    const session = getSession(params.sessionId);
    const { configId, value } = params;

    if (configId === 'model') {
      const { provider, modelId } = parseModelValue(value);
      await session.pi.send('set_model', { provider, modelId }, { timeout: 15000 });
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

  'session/prompt': async (params) => {
    const session = getSession(params.sessionId);
    if (session.turn) {
      throw Object.assign(new Error('已有一轮正在进行'), { code: -32603 });
    }

    // Map ACP prompt content to pi prompt
    const blocks = params.prompt ?? [];
    let messageText = '';
    const images = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        messageText += (messageText ? '\n' : '') + block.text;
      } else if (block.type === 'image') {
        images.push({ type: 'image', data: block.data, mimeType: block.mimeType ?? 'image/png' });
      } else if (block.type === 'resource_link') {
        const ref = block.uri ?? block.path ?? '';
        if (ref) messageText += (messageText ? '\n' : '') + ref;
      } else if (block.type === 'resource') {
        const resText = block.resource?.text ?? '';
        if (resText) {
          messageText += (messageText ? '\n' : '') + `--- ${block.resource?.uri ?? 'resource'} ---\n${resText}\n---`;
        }
      }
    }

    // Create turn promise
    return new Promise((resolve, reject) => {
      session.turn = {
        resolve,
        reject: (err) => {
          session.turn = null;
          if (err.code) reject(Object.assign(new Error(err.message), { code: err.code, data: err.data }));
          else reject(err);
        },
        text: '',
        cancelled: false,
        settled: false,
        stopReason: null,
        lastStopReason: null,
        errorMessage: null,
        steered: null,
      };

      const piPrompt = { message: messageText };
      if (images.length) piPrompt.images = images;

      session.pi.send('prompt', piPrompt, { timeout: 300000 })
        .then(data => {
          // prompt accepted; now wait for agent_settled via events
          if (data?.disposition === 'handled') {
            // Extension command consumed it, finish immediately
            session.turn.settled = true;
            session.turn.stopReason = 'end_turn';
            finishTurn(session);
          }
        })
        .catch(err => {
          if (session.turn) {
            const turn = session.turn;
            session.turn = null;
            turn.reject?.({ code: -32603, message: err.message });
          }
        });
    });
  },

  '_session/steering': async (params) => {
    const session = sessions.get(params.sessionId);
    if (!session) return { outcome: 'promptRequired', reason: 'noRunningTurn' };

    if (!session.turn || session.turn.cancelled) {
      return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    }

    // Send steer to pi
    const text = (params.prompt ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    try {
      await session.pi.send('steer', { message: text }, { timeout: 30000 });
      return { outcome: 'injected' };
    } catch (e) {
      log('steer failed:', e.message);
      return { outcome: 'injected' }; // Still report injected since pi queued it
    }
  },
};

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw Object.assign(new Error(`没有会话 ${sessionId}`), { code: -32002 });
  return session;
}

// ---- Cancel handler (notification, no response) ----
function handleCancel(params) {
  const session = sessions.get(params.sessionId);
  if (!session) return;

  if (session.turn) {
    session.turn.cancelled = true;
    // Send clear_queue then abort to pi
    if (session.pi && !session.pi.exited) {
      session.pi.send('clear_queue', {}, { timeout: 5000 }).catch(() => {});
      session.pi.send('abort', {}, { timeout: 10000 })
        .then(() => {
          // Pi stopped; if turn still pending, finish it
          if (session.turn) {
            session.turn.settled = true;
            session.turn.stopReason = 'cancelled';
            finishTurn(session);
          }
        })
        .catch(() => {
          // Pi hung; cancel locally and respawn lazily on the next turn.
          if (session.turn) {
            session.pi.kill();
            session.turn.settled = true;
            session.turn.stopReason = 'cancelled';
            finishTurn(session);
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

    if (message.error) {
      session.pi.write({ type: 'extension_ui_response', id: pending.piId, cancelled: true });
      return;
    }

    const result = message.result;
    if (pending.type === 'confirm') {
      const outcome = result?.outcome;
      if (outcome?.outcome === 'cancelled' || outcome?.outcome === 'selected') {
        const allowed = outcome.outcome === 'selected' && outcome.optionId === 'allow';
        session.pi.write({ type: 'extension_ui_response', id: pending.piId, confirmed: allowed });
      } else {
        session.pi.write({ type: 'extension_ui_response', id: pending.piId, cancelled: true });
      }
      return;
    } else if (pending.type === 'select') {
      if (result?.action === 'accept' && result?.data?.choice) {
        session.pi.write({ type: 'extension_ui_response', id: pending.piId, value: result.data.choice });
      } else {
        session.pi.write({ type: 'extension_ui_response', id: pending.piId, cancelled: true });
      }
      return;
    } else if (pending.type === 'input') {
      if (result?.action === 'accept' && result?.data?.text !== undefined) {
        session.pi.write({ type: 'extension_ui_response', id: pending.piId, value: result.data.text });
      } else {
        session.pi.write({ type: 'extension_ui_response', id: pending.piId, cancelled: true });
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
