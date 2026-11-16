// Build an offline design preview using the real markup/styles and a session-only
// adapter. This does not replace or modify the app's SQLite-backed API.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { openDatabase } from '../server.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const db = openDatabase(':memory:');
const seed = db.prepare('SELECT * FROM incidents ORDER BY id DESC').all().map((i) => ({ ...i, events: db.prepare('SELECT * FROM events WHERE incident_id=? ORDER BY id').all(i.id) }));
db.close();
const id = 'dns-dragons-preview';
const adapter = `const previewRecords = ${JSON.stringify(seed)};
async function api(path, options = {}) {
  const method = options.method || 'GET';
  const found = previewRecords.find(i => i.id === Number(path.split('/').pop()));
  if (method === 'POST') {
    const body = JSON.parse(options.body); const now = new Date().toISOString();
    const record = { ...body, id: Math.max(0, ...previewRecords.map(i => i.id)) + 1, status: 'investigating', created_at: now, updated_at: now, resolved_at: null, events: [{body:'The alarm was sounded. An adventurer has been dispatched.',status:'investigating',created_at:now}] };
    previewRecords.unshift(record); return structuredClone(record);
  }
  if (method === 'PATCH' && found) {
    const body = JSON.parse(options.body); const now = new Date().toISOString();
    Object.assign(found, {status:body.status,updated_at:now,resolved_at:body.status==='resolved'?now:null});
    found.events.push({body:body.note,status:body.status,created_at:now}); return structuredClone(found);
  }
  if (path === '/api/incidents') return {incidents:structuredClone(previewRecords)};
  if (found) return structuredClone(found);
  throw new Error('This encounter could not be found.');
}
`;
const mockHealth = `async function checkHealth() {
  $('#health-label').textContent = 'Design preview';
  $('#health-content').innerHTML = '<div class="health-row"><span>Preview mode</span><b>Session-only sample data</b></div><p class="health-note">This preview runs without a server. The downloadable app stores incidents in SQLite and checks the database at /health. Run it to see live health results.</p>';
}
`;
let js = read('public/app.js');
js = js.replace("const $ = (selector) => document.querySelector(selector);", `const previewRoot = document.getElementById('${id}');\nconst $ = (selector) => previewRoot.querySelector(selector);`)
  .replace("const $$ = (selector) => [...document.querySelectorAll(selector)];", () => "const $$ = (selector) => [...previewRoot.querySelectorAll(selector)];")
  .replace(/async function api\([\s\S]*?\n}\nlet toastTimer;/, `${adapter}\nlet toastTimer;`)
  .replace(/async function checkHealth\(\)[\s\S]*?\n}\nfor \(const selector/, `${mockHealth}\nfor (const selector`)
  .replace('setInterval(checkHealth, 60000);', '');
const svg = `data:image/svg+xml;base64,${Buffer.from(read('public/crest.svg')).toString('base64')}`;
let body = read('public/index.html').match(/<body>([\s\S]*)<\/body>/)[1]
  .replaceAll('src="/crest.svg"', `src="${svg}"`)
  .replace('href="/" class="brand"', 'href="#main" class="brand"')
  .replace('Fictional incidents. Real persistence.', 'Design preview · changes reset on refresh.')
  .replace(/<a class="secondary button-link" href="\/health"[^>]*>[^<]*<\/a>/, '<button class="secondary" data-close>Close</button>');
let css = read('public/style.css').replace(':root{', `#${id}{`).replace('body{', '.preview-body{');
// The in-conversation preview grows with its content; the app itself retains its
// fixed desktop sidebar. Scope all product styles away from conversation chrome.
css += `\n#${id}{position:relative;isolation:isolate;min-width:0;color-scheme:light}\n#${id} .preview-body{position:relative;overflow:hidden;min-height:830px}\n#${id} .sidebar{position:absolute}\n#${id} #toast{position:absolute}\n#${id} .skip-link{position:absolute}\n@media(max-width:800px){#${id} .sidebar{position:relative}}\n`;
const fragment = `<div id="${id}"><style>@scope (#${id}) {\n${css}\n}</style><div class="preview-body">${body}</div></div>\n<script>\n(()=>{\n${js}\n})();\n</script>\n`;
if (/\bfetch\s*\(/.test(fragment)) throw new Error('Offline preview must not make API calls.');
const standalone = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DNS & Dragons — design preview</title><style>body{margin:0}</style></head><body>${fragment}</body></html>`;
writeFileSync(resolve(root, 'preview.html'), standalone);
if (process.argv[2]) writeFileSync(resolve(process.argv[2]), fragment);
console.log('Built preview.html (session-only adapter; no server requests).');
