// Coda's 「检查」 for a row of `pi.providers` (Coda docs/plugins.md「设置的检查」): lists the models its address gives, as
// Pi would when it starts, with the key typed and not saved yet, else the one Coda keeps for the row.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { endpointOf, listModels } from './providers.mjs';

const tokens = n => n >= 1000000 ? `${+(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(n);

export async function check(request, env = process.env, fetcher = fetch) {
  const row = request?.value ?? {}, name = String(request?.row ?? '');
  if (name.includes('/')) return { items: [{ type: 'error', text: '名称不能带 /：Pi 用「provider/模型」认模型' }] };
  const at = endpointOf(name, row, env, request?.secrets?.key || undefined);
  if (!at) return { items: [{ type: 'error', text: row.source ? `这台机器上没有 ${row.source}：先在提供它的插件里填好地址` : '先选来源或填地址' }] };
  let models;
  try { models = await listModels({ ...row, url: at.url }, at.key, fetcher); }
  catch (e) { return { items: [{ type: 'error', text: `列不出模型：${e.message}` }] }; }
  if (!models.length) return { items: [{ type: 'error', text: '能连上，但没有列出模型' }] };
  return { items: [{ type: 'markdown', text: `能连上，共 ${models.length} 个模型` },
    ...models.slice(0, 40).map(model => ({ type: 'stat', label: model.name, value: `${tokens(model.contextWindow)} 上下文` })),
    ...(models.length > 40 ? [{ type: 'markdown', text: `另有 ${models.length - 40} 个没有列出` }] : [])] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  process.stdout.write(JSON.stringify(await check(request)));
}
