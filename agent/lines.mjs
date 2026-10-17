// Byte-level LF splitter for JSONL streams (same pattern as Coda's json-lines.mjs).
// Node readline splits on U+2028/U+2029 which are valid inside JSON strings.
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export function readLines(input) {
  const reader = new EventEmitter(), decoder = new StringDecoder('utf8');
  let pending = [], closed = false;
  const emit = line => reader.emit('line', line.endsWith('\r') ? line.slice(0, -1) : line);
  const take = text => {
    let start = 0, end;
    while (!closed && (end = text.indexOf('\n', start)) >= 0) {
      pending.push(text.slice(start, end)); start = end + 1;
      const line = pending.join(''); pending = [];
      emit(line);
    }
    if (!closed && start < text.length) pending.push(text.slice(start));
  };
  const data = chunk => take(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  const finish = () => {
    if (closed) return;
    take(decoder.end());
    if (pending.length && !closed) { const rest = pending.join(''); pending = []; emit(rest); }
    reader.close();
  };
  reader.close = () => {
    if (closed) return;
    closed = true;
    input.off('data', data); input.off('end', finish); input.off('close', reader.close);
    input.pause?.();
    reader.emit('close');
  };
  input.on('data', data); input.on('end', finish); input.on('close', reader.close);
  return reader;
}
