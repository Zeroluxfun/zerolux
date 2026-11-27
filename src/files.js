// Files a customer hands an agent.
//
// The customer's browser reads the file (public/attach.js): a PDF, a Word document, a spreadsheet or a text file is
// turned into its text there, and a picture is scaled down to a JPEG. Only that text or that JPEG is sent here, so
// this Worker never opens a document format, and what a file can cost a run is known before the run starts.
//
//   POST /api/files      the text (text/plain) or the JPEG (image/jpeg) as the body, with
//                        x-file-kind: text|image, x-file-name, x-file-note (both URL-encoded)   -> {"id", ...}
//   GET  /api/files/:id  -> its name, kind and size. The contents are never served back.
//
// A request names its files by ending with one line per file: [attached file zl:<id>]. The id is 32 random hex
// characters and is the only key to the file, so the line can travel wherever the request text goes: an ordinary run,
// a standing order, a long job. When the agent runs, src/run.js swaps the lines for the files themselves.
import { json, allow, clientKey } from './line.js';
import { MAX_FILES, TEXT_CHARS, IMAGE_BYTES, IMAGE_SIDE, FILE_KEEP_DAYS, MARK } from './filetext.js';
export { MAX_FILES, TEXT_CHARS, IMAGE_BYTES, IMAGE_SIDE, FILE_KEEP_DAYS, IMAGE_ROOM, MARK, fileRoom, fileContent } from './filetext.js';

const now = () => new Date().toISOString();
const later = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

// Width and height from a JPEG's own header, or null if it is not one.
function jpegSize(b) {
  if (b.length < 12 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if ((m >= 0xd0 && m <= 0xd9) || m === 0x01) { i += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + '<>"\\\\/]', 'g');
const header = (request, k, max) => { try { return decodeURIComponent(request.headers.get(k) || '').replace(CONTROL, ' ').trim().slice(0, max); } catch { return ''; } };

export async function putFile(request, env) {
  if (Number(request.headers.get('content-length') || 0) > 1_000_000) return json({ error: 'That file is too large to send.' }, 413);
  if (!(await allow(env, 'file:' + clientKey(request), 60))) return json({ error: 'That is enough files for today.' }, 429);
  const kind = request.headers.get('x-file-kind'), name = header(request, 'x-file-name', 120) || 'file', note = header(request, 'x-file-note', 80) || null;
  const body = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (!body.length || body.length > 1_000_000) return json({ error: body.length ? 'That file is too large to send.' : 'The file was empty.' }, body.length ? 413 : 400);
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
  let text = null, data = null, chars = 0;
  if (kind === 'text') {
    text = new TextDecoder('utf-8').decode(body);
    if (text.includes(String.fromCharCode(0))) return json({ error: 'That does not look like text.' }, 400);
    text = text.replace(/\r\n?/g, '\n').trim().slice(0, TEXT_CHARS); chars = text.length;
    if (!text) return json({ error: 'No readable text was found in that file.' }, 400);
  } else if (kind === 'image') {
    const size = jpegSize(body);
    if (!size || body.length > IMAGE_BYTES || size.w > IMAGE_SIDE || size.h > IMAGE_SIDE || !size.w || !size.h) return json({ error: `A picture is sent as a JPEG of at most ${IMAGE_SIDE} pixels a side.` }, 400);
    data = body.buffer;
  } else return json({ error: 'x-file-kind is text or image.' }, 400);
  await env.DB.prepare('INSERT INTO files (id, name, kind, note, size, chars, text, data, created_at, keep_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, name, kind, note, body.length, chars, text, data, now(), later(FILE_KEEP_DAYS)).run();
  return json({ id, name, kind, note, size: body.length, chars, keep_days: FILE_KEEP_DAYS });
}

export async function fileInfo(env, id) {
  const f = await env.DB.prepare('SELECT id, name, kind, note, size, chars, keep_until FROM files WHERE id = ? AND keep_until > ?').bind(id, now()).first();
  return f ? json(f, 200, { 'cache-control': 'no-store' }) : json({ error: 'No file with that id. It may have expired.' }, 404);
}

// A standing order or a long job that names files needs them for as long as it lasts.
export async function keepFiles(env, text, days) {
  const ids = [...new Set([...String(text || '').matchAll(MARK)].map((m) => m[1]))].slice(0, MAX_FILES);
  for (const id of ids) await env.DB.prepare('UPDATE files SET keep_until = MAX(keep_until, ?) WHERE id = ?').bind(later(days), id).run();
  return ids.length;
}

// The files a request names, and the request without the lines that named them.
export async function attachments(env, input) {
  const ids = [...new Set([...input.matchAll(MARK)].map((m) => m[1]))].slice(0, MAX_FILES);
  if (!ids.length) return { text: input, files: [] };
  const t = now();
  const rows = await Promise.all(ids.map((id) => env.DB.prepare('SELECT name, kind, note, text, data FROM files WHERE id = ? AND keep_until > ?').bind(id, t).first()));
  return { text: input.replace(MARK, '').trim(), files: rows.map((r) => r || { missing: true }) };
}

// From the timer: files nobody needs any more.
export const filesTick = (env) => env.DB.prepare('DELETE FROM files WHERE keep_until < ?').bind(now()).run();
