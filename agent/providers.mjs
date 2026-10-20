// Pi extension (loaded with `pi --extension`): registers the providers set in Coda's `pi.providers`, a row each — its
// address, key, API and model defaults — and lists each one's models from its address (`<地址>/models`, the OpenAI list)
// as Pi starts. Coda's 「重新读取模型」 starts Pi again, which lists them again. What a provider listed last is kept in
// the plugin's state and used while its address cannot be reached.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const log = (...args) => process.stderr.write(`[pi-agent] ${args.join(' ')}\n`);
const parse = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
const LIST_TIMEOUT = 8000;

// A row's key, read from the file Coda keeps it in (CODA_PLUGIN_SECRETS); none for a provider without one.
function keyOf(file) {
  if (!file) return undefined;
  try { return readFileSync(file, 'utf8').trim() || undefined; } catch (e) { log(`读不到 provider 的 Key：${e.message}`); return undefined; }
}

// The models a provider's address lists, as Pi takes them: the row's defaults, a context window the list gives instead
// (OpenRouter's `context_length`, vLLM's `max_model_len`, llama.cpp's `meta.n_ctx_train`). Asked as the API it is called
// with (`row.api`) asks: a proxy that serves both (CLIProxy) lists other names to an Anthropic client, names its OpenAI
// route does not know.
export async function listModels(row, key, fetcher = fetch) {
  const url = `${String(row.url).replace(/\/+$/, '')}/models`;
  const headers = !key ? {} : row.api === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key}` };
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT) });
  if (!response.ok) throw new Error(`${url} 回答 ${response.status}`);
  const body = await response.json();
  const listed = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return listed.filter(model => typeof model?.id === 'string' && model.id).map(model => ({
    id: model.id,
    name: typeof model.display_name === 'string' ? model.display_name : typeof model.name === 'string' ? model.name : model.id,
    reasoning: row.reasoning ?? true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: [model.context_length, model.max_model_len, model.meta?.n_ctx_train].find(n => Number.isInteger(n) && n > 0) ?? row.contextWindow ?? 128000,
    maxTokens: row.maxTokens ?? 16384,
  }));
}

// Where a row's provider is: the model service another plugin provides that it chooses (`source`, Coda's
// CODA_MODEL_PROVIDERS: its address, API and the file of its key), else its own address and key. Null when it has neither.
export function endpointOf(name, row, env = process.env, typedKey) {
  if (row?.source) {
    const provided = parse(env.CODA_MODEL_PROVIDERS)[row.source];
    if (!provided?.url) return null;
    return { url: provided.url, api: provided.api || row.api, key: keyOf(provided.keyFile) };
  }
  if (!row?.url) return null;
  return { url: row.url, api: row.api, key: typedKey ?? keyOf(parse(env.CODA_PLUGIN_SECRETS)['pi.providers']?.[name]?.key) };
}

export default async function codaProviders(pi) {
  const rows = parse(process.env.CODA_PLUGIN_SETTINGS)['pi.providers'] ?? {};
  const state = process.env.CODA_PLUGIN_STATE;
  const cacheFile = state ? join(state, 'provider-models.json') : null;
  const cache = cacheFile ? parse((() => { try { return readFileSync(cacheFile, 'utf8'); } catch { return '{}'; } })()) : {};
  const listed = await Promise.all(Object.entries(rows).map(async ([name, row]) => {
    // Pi names a model `<provider>/<model>`: a name with a slash cannot be told apart.
    const at = name.includes('/') ? null : endpointOf(name, row);
    if (!at) { log(`跳过 provider「${name}」：${name.includes('/') ? '名称不能带 /' : row?.source ? `来源 ${row.source} 在这台机器上没有` : '没有地址'}`); return null; }
    let models;
    try { models = await listModels({ ...row, url: at.url, api: at.api }, at.key); cache[name] = models; }
    catch (e) { models = cache[name] ?? []; log(`provider「${name}」列不出模型（${e.message}）${models.length ? '，用上次列出的' : ''}`); }
    if (!models.length) return null;
    pi.registerProvider(name, { name, baseUrl: at.url, apiKey: at.key ?? 'none', api: at.api ?? 'openai-completions', models });
    return name;
  }));
  if (cacheFile && listed.some(Boolean)) {
    try { mkdirSync(state, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(cache)); } catch (e) { log(`没能记下列出的模型：${e.message}`); }
  }
}
