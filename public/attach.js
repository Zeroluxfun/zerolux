// Reading a customer's file in their own browser, before anything is sent.
//
// A PDF, a Word document, a spreadsheet or a text file is turned into its text here; a picture is scaled down to a
// JPEG. Only that text or that JPEG goes to Zero Lux (POST /api/files), which answers with the id the request then
// carries. The original file never leaves this computer.
const LIMIT = 200_000; // characters of one file's text that are kept
const SIDE = 1280; // a picture's longest side after scaling
const TEXT = /\.(txt|text|md|markdown|csv|tsv|json|jsonl|log|xml|html?|ya?ml|toml|ini|js|mjs|ts|py|sol|sql|rs|go|java|c|cpp|h|css|sh)$/i;
export const ACCEPT = '.pdf,.docx,.xlsx,.txt,.md,.csv,.tsv,.json,.log,.xml,.html,.yaml,.yml,image/png,image/jpeg,image/webp,image/gif';
export const mark = (id) => '[attached file zl:' + id + ']';
const many = (n, one) => n.toLocaleString('en-US') + ' ' + one + (n === 1 ? '' : 's');

// The files inside a zip (a .docx and an .xlsx are both zips), for the names `want` says yes to.
async function unzip(buf, want) {
  const b = new Uint8Array(buf), dv = new DataView(buf); let e = b.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('That file could not be opened.');
  const n = dv.getUint16(e + 10, true), out = new Map(); let o = dv.getUint32(e + 16, true);
  for (let i = 0; i < n && o + 46 <= b.length && dv.getUint32(o, true) === 0x02014b50; i++) {
    const method = dv.getUint16(o + 10, true), csize = dv.getUint32(o + 20, true), usize = dv.getUint32(o + 24, true), nlen = dv.getUint16(o + 28, true), xlen = dv.getUint16(o + 30, true), clen = dv.getUint16(o + 32, true), at = dv.getUint32(o + 42, true);
    const name = new TextDecoder().decode(b.subarray(o + 46, o + 46 + nlen)); o += 46 + nlen + xlen + clen;
    if (!want(name) || usize > 40_000_000) continue;
    const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true), raw = b.subarray(start, start + csize);
    out.set(name, method === 0 ? raw : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
  }
  return out;
}
const xml = (u8) => new DOMParser().parseFromString(new TextDecoder().decode(u8), 'application/xml');

async function pdf(file) {
  const lib = await import('/vendor/pdf.min.mjs'); lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  let doc;
  try { doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, disableFontFace: true }).promise; }
  catch (x) { throw new Error(x?.name === 'PasswordException' ? 'That PDF is locked with a password. Remove the password and try again.' : 'That PDF could not be read.'); }
  let text = '';
  for (let p = 1; p <= doc.numPages && text.length < LIMIT; p++) {
    const items = (await (await doc.getPage(p)).getTextContent()).items; let page = '';
    for (const it of items) page += it.str + (it.hasEOL ? '\n' : '');
    if (page.trim()) text += `\n\n[Page ${p}]\n` + page.trim();
  }
  const pages = doc.numPages; try { await doc.destroy(); } catch {}
  if (!text.trim()) throw new Error('That PDF has no readable text. It may be a scan: attach photos of the pages instead.');
  return { kind: 'text', text, note: many(pages, 'page') };
}

async function docx(file) {
  const main = (await unzip(await file.arrayBuffer(), (n) => n === 'word/document.xml')).get('word/document.xml');
  if (!main) throw new Error('That does not look like a Word document.');
  const paras = [...xml(main).getElementsByTagName('w:p')].map((p) => [...p.getElementsByTagName('*')].map((n) => (n.tagName === 'w:t' ? n.textContent : n.tagName === 'w:tab' ? '\t' : n.tagName === 'w:br' ? '\n' : '')).join('')).filter((t) => t.trim());
  if (!paras.length) throw new Error('That Word document has no readable text.');
  return { kind: 'text', text: paras.join('\n\n'), note: many(paras.length, 'paragraph') };
}

async function xlsx(file) {
  const z = await unzip(await file.arrayBuffer(), (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!z.has('xl/workbook.xml')) throw new Error('That does not look like an Excel spreadsheet.');
  const shared = z.has('xl/sharedStrings.xml') ? [...xml(z.get('xl/sharedStrings.xml')).getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join('')) : [];
  const names = [...xml(z.get('xl/workbook.xml')).getElementsByTagName('sheet')].map((s) => s.getAttribute('name'));
  const sheets = [...z.keys()].filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const cell = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  let text = '', rows = 0;
  for (const [i, path] of sheets.entries()) {
    if (text.length >= LIMIT) break;
    const lines = [];
    for (const row of xml(z.get(path)).getElementsByTagName('row')) {
      const out = [];
      for (const c of row.getElementsByTagName('c')) {
        let col = 0; for (const ch of (c.getAttribute('r') || '').replace(/\d/g, '')) col = col * 26 + ch.charCodeAt(0) - 64;
        const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0]?.textContent ?? '';
        const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map((x) => x.textContent).join('') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
        if (col <= 500) out[col ? col - 1 : out.length] = cell(String(val));
      }
      if (out.length) { lines.push(Array.from(out, (x) => x ?? '').join(',')); rows++; }
    }
    if (lines.length) text += `\n\n# Sheet: ${names[i] || 'Sheet ' + (i + 1)}\n` + lines.join('\n');
  }
  if (!text.trim()) throw new Error('That spreadsheet has no readable cells.');
  return { kind: 'text', text, note: many(sheets.length, 'sheet') + ', ' + many(rows, 'row') };
}

async function picture(file) {
  let bmp; try { bmp = await createImageBitmap(file); } catch { throw new Error('That picture could not be opened.'); }
  const s = Math.min(1, SIDE / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  let blob;
  for (const q of [0.85, 0.7, 0.5]) { blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q)); if (blob && blob.size <= 850_000) break; }
  if (!blob || blob.size > 850_000) throw new Error('That picture is too detailed to send. Try a smaller one.');
  return { kind: 'image', blob, note: `${c.width} × ${c.height}` };
}

// A file, as what will be sent: {kind: "text", text, note} or {kind: "image", blob, note}.
export async function readFile(file) {
  const name = file.name || 'file';
  if (file.size > 30_000_000) throw new Error('That file is over 30 MB. Attach a smaller one.');
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') return pdf(file);
  if (/\.docx$/i.test(name)) return docx(file);
  if (/\.xlsx$/i.test(name)) return xlsx(file);
  if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return picture(file);
  if (TEXT.test(name) || file.type.startsWith('text/') || file.type === 'application/json') {
    const text = await file.text();
    if (text.includes(String.fromCharCode(0))) throw new Error('That file is not text.');
    if (!text.trim()) throw new Error('That file is empty.');
    return { kind: 'text', text, note: many(text.split('\n').length, 'line') };
  }
  throw new Error('That kind of file cannot be read here. Attach a PDF, a Word or Excel file (.docx, .xlsx), a text or CSV file, or a picture.');
}

// Reads the file and sends what was read. Answers {id, name, kind, chars, note, cut}.
export async function attach(file, { origin = '' } = {}) {
  const got = await readFile(file), name = file.name || 'file';
  const cut = got.kind === 'text' && got.text.length > LIMIT;
  const res = await fetch(origin + '/api/files', {
    method: 'POST', body: got.kind === 'text' ? got.text.slice(0, LIMIT) : got.blob,
    headers: { 'content-type': got.kind === 'text' ? 'text/plain; charset=utf-8' : 'image/jpeg', 'x-file-kind': got.kind, 'x-file-name': encodeURIComponent(name.slice(0, 120)), 'x-file-note': encodeURIComponent(got.note || '') },
  }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok) throw new Error(data.error || 'The file could not be sent. Check your connection and try again.');
  return { id: data.id, name: data.name, kind: data.kind, chars: data.chars, note: data.note, cut };
}
