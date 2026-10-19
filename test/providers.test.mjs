import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codaProviders, { listModels } from "../agent/providers.mjs";

const answer = body => async () => ({ ok: true, json: async () => body });

test("listModels takes the OpenAI list, the row's defaults, and a context window the list gives", async () => {
  const seen = [];
  const fetcher = async (url, options) => { seen.push([url, options.headers]); return answer({ data: [
    { id: "qwen", meta: { n_ctx_train: 32768 } }, { id: "gemini", display_name: "Gemini" }, { object: "model" }] })(); };
  const models = await listModels({ url: "https://rig/v1/", reasoning: false, maxTokens: 8192 }, "sk", fetcher);
  assert.deepEqual(seen, [["https://rig/v1/models", { Authorization: "Bearer sk", "x-api-key": "sk", "anthropic-version": "2023-06-01" }]]);
  assert.deepEqual(models.map(m => [m.id, m.name, m.reasoning, m.contextWindow, m.maxTokens]),
    [["qwen", "qwen", false, 32768, 8192], ["gemini", "Gemini", false, 128000, 8192]]);
  await assert.rejects(listModels({ url: "https://rig/v1" }, undefined, async () => ({ ok: false, status: 401 })), /401/);
});

test("the extension registers each provider with its key, and uses what it listed last while the address is out of reach", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-providers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "key"), "sk-rig\n");
  const saved = { ...process.env }, fetched = globalThis.fetch;
  t.after(() => { process.env = saved; globalThis.fetch = fetched; });
  process.env.CODA_PLUGIN_STATE = dir;
  process.env.CODA_PLUGIN_SETTINGS = JSON.stringify({ "pi.providers": {
    rig: { url: "https://rig/v1", key: null, api: "openai-completions", reasoning: true, contextWindow: 128000, maxTokens: 16384 },
    "a/b": { url: "https://x/v1" } } });
  process.env.CODA_PLUGIN_SECRETS = JSON.stringify({ "pi.providers": { rig: { key: join(dir, "key") } } });
  const registered = [], pi = { registerProvider: (name, config) => registered.push([name, config]) };
  globalThis.fetch = answer({ data: [{ id: "qwen" }] });
  await codaProviders(pi);
  assert.deepEqual(registered.map(([name, config]) => [name, config.apiKey, config.baseUrl, config.models.map(m => m.id)]), [["rig", "sk-rig", "https://rig/v1", ["qwen"]]]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, "provider-models.json"), "utf8"))), ["rig"]);
  // Out of reach, it lists what it listed last.
  registered.length = 0;
  globalThis.fetch = async () => { throw new Error("offline"); };
  await codaProviders(pi);
  assert.deepEqual(registered.map(([name, config]) => [name, config.models.map(m => m.id)]), [["rig", ["qwen"]]]);
});
