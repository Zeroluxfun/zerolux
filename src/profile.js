// An agent's public profile: a photo, a tagline and two links, set by the wallet that owns the agent.
// This file is the part with no network and no database in it: what a profile may hold, what counts as a
// picture, and the exact words the owner signs. The page (public/app.js) builds the same words.
// The handlers are in src/profile-api.js.

export const PHOTO_MAX = 300_000; // bytes, after the page has cropped and shrunk it
export const TAGLINE_MAX = 140;
export const SITE_MAX = 200;
export const SIGN_WINDOW_MS = 10 * 60_000;

// A picture is one of three formats, told by its first bytes and never by what the sender says it is.
// SVG and anything else that can carry script is refused by not being on this list.
export function sniff(bytes) {
  const b = bytes, at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

export function fromBase64(text) {
  if (typeof text !== 'string' || text.length > Math.ceil(PHOTO_MAX / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try { const bin = atob(text), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; } catch { return null; }
}

// One line of plain text: control characters and line breaks become spaces, runs of spaces collapse.
const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();

// The text fields of a profile, cleaned. Returns { ok, tagline, x, site } or { ok: false, error }.
// An empty field means "nothing set": the market then shows what the agent was built with.
export function cleanProfile(raw) {
  const tagline = oneLine(raw?.tagline);
  if (tagline.length > TAGLINE_MAX) return { ok: false, error: `The tagline can be at most ${TAGLINE_MAX} characters.` };
  const x = oneLine(raw?.x).replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
  if (x && !/^[A-Za-z0-9_]{1,15}$/.test(x)) return { ok: false, error: 'That is not an X handle. Use letters, numbers and underscores, 15 at most.' };
  let site = oneLine(raw?.site);
  if (site) {
    if (site.length > SITE_MAX) return { ok: false, error: `The website address can be at most ${SITE_MAX} characters.` };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(site)) site = 'https://' + site;
    let u; try { u = new URL(site); } catch { return { ok: false, error: 'That is not a website address.' }; }
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return { ok: false, error: 'The website has to be an https address.' };
    site = u.href;
    if (site.length > SITE_MAX) return { ok: false, error: `The website address can be at most ${SITE_MAX} characters.` };
  }
  return { ok: true, tagline, x, site };
}

// What the owner signs. `photo` is 'keep' (leave the picture as it is), 'none' (take it down) or
// 'sha256:<hex>' (this exact file). Text values are written as JSON strings so no value can pass for another line.
export const profileMessage = ({ id, photo, tagline, x, site, time }) => [
  `Zero Lux (zerolux.fun): set the profile of agent ${id}`,
  `Photo: ${photo}`,
  `Tagline: ${JSON.stringify(tagline)}`,
  `X: ${JSON.stringify(x)}`,
  `Website: ${JSON.stringify(site)}`,
  `Time: ${time}`,
  'Signing this costs nothing and moves no money.',
].join('\n');

// The signed time has to be a real moment close to now.
export function timeOk(time, now = Date.now()) {
  if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)) return false;
  const t = Date.parse(time);
  return Number.isFinite(t) && Math.abs(now - t) <= SIGN_WINDOW_MS;
}

export const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
