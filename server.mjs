import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const severityValues = ['SEV-1', 'SEV-2', 'SEV-3'];
const statusValues = ['investigating', 'monitoring', 'resolved'];
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/crest.svg', ['crest.svg', 'image/svg+xml']],
]);

function fail(status, message) { return Object.assign(new Error(message), { status }); }
function field(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw fail(400, `${name} must be ${min}–${max} characters.`);
  return value.trim();
}
function choice(value, name, values) {
  if (!values.includes(value)) throw fail(400, `Choose a valid ${name}.`);
  return value;
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function openDatabase(path, seed = true) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('SEV-1','SEV-2','SEV-3')),
      service TEXT NOT NULL, assignee TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('investigating','monitoring','resolved')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id),
      body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS events_incident ON events(incident_id, id);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `);
  if (seed && !db.prepare("SELECT value FROM metadata WHERE key='seeded'").get()) {
    const samples = [
      ['Goblin granted AdministratorAccess', 'An intern goblin acquired the master key to the kingdom. Revoke the role, review the audit trail, and teach least privilege before lunch.', 'SEV-3', 'Identity guild', 'Gimli, SRE', 'resolved', 'Revoked the broad role, checked the audit log, and replaced it with a narrowly scoped policy. No suspicious activity found.'],
      ['Potion cache serving stale mana', 'Heroes report that mana potions are restoring yesterday’s energy. The cache is ignoring its TTL. Wizards have requested a very strong coffee.', 'SEV-2', 'Potion cache', 'Merlin, platform', 'resolved', 'The cache TTL was expressed in minutes instead of seconds. Corrected the configuration and verified fresh reads.'],
      ['The load balancer has chosen a favorite', 'All requests are being routed to one very tired dwarf. Healthy targets are available, but the sticky-session enchantment appears to be permanent.', 'SEV-2', 'Gateway of traffic', 'Gimli, SRE', 'monitoring', 'Removed the sticky-session enchantment. Traffic is balanced again; watching error rates before closing the quest.'],
      ['Certificate expired during the prophecy', 'The prophecy lasts a thousand years. The certificate lasted ninety days. Browsers are warning villagers that the oracle cannot be trusted.', 'SEV-2', 'Oracle API', 'Merlin, platform', 'investigating', 'Confirmed the certificate expired. Investigating why the renewal timer stopped running.'],
      ['Dragon consumed availability zone', 'A dragon mistook the primary data center for a particularly warm cave. Requests to the eastern realm are timing out. The dragon is not accepting calendar invites.', 'SEV-1', 'Eastern realm', 'Arwen, on-call', 'investigating', 'Confirmed the eastern realm is unreachable. Checking the recovery runbook and the most recent backup.'],
      ['Necromancer resurrected deprecated services', 'Retired services are answering requests again. A suspicious cron spell is running every midnight. Please do not feed the zombie containers.', 'SEV-2', 'Container crypt', 'Arwen, on-call', 'investigating', 'Found an old scheduled job that still references the retired deployment. Tracing its owner before removing it.'],
    ];
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO incidents (title,description,severity,service,assignee,status,created_at,updated_at,resolved_at) VALUES (?,?,?,?,?,?,?,?,?)');
      const event = db.prepare('INSERT INTO events (incident_id,body,status,created_at) VALUES (?,?,?,?)');
      for (const [index, item] of samples.entries()) {
        const [title, description, severity, service, assignee, status, note] = item;
        const created = new Date(Date.now() - (12 - index * 2) * 3600000).toISOString();
        const updated = new Date(Date.parse(created) + 25 * 60000).toISOString();
        const id = Number(insert.run(title, description, severity, service, assignee, status, created, updated, status === 'resolved' ? updated : null).lastInsertRowid);
        event.run(id, 'The alarm was sounded. An adventurer has been dispatched.', 'investigating', created);
        event.run(id, note, status, updated);
      }
      db.prepare("INSERT INTO metadata VALUES ('seeded','1')").run();
    });
  }
  return db;
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    throw fail(415, 'Send application/json.');
  let bytes = 0, chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw fail(413, 'That scroll is too long. Keep requests under 16 KB.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw fail(400, 'Send a valid JSON object.'); }
}

export function createApp({ dbPath = process.env.DATABASE_PATH || resolve(root, 'data/realm.sqlite'), seed = process.env.SEED_DEMO !== 'false' } = {}) {
  const db = openDatabase(dbPath, seed);
  const started = Date.now();
  // Keep the public demo bounded. Production would need identities and shared rate limiting.
  const writes = new Map();
  const server = createServer(async (req, res) => {
    const requestStarted = Date.now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.on('finish', () => console.log(JSON.stringify({ method: req.method, path: (req.url || '').split('?')[0], status: res.statusCode, durationMs: Date.now() - requestStarted })));
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        try {
          db.prepare('SELECT COUNT(*) AS count FROM incidents').get();
          return send(200, { status: 'ok', realm: 'operational', app: 'ok', database: 'ok', uptimeSeconds: Math.floor((Date.now() - started) / 1000), checkedAt: new Date().toISOString() });
        } catch { return send(503, { status: 'degraded', realm: 'under siege', app: 'ok', database: 'unavailable' }); }
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        const content = readFileSync(resolve(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/api/incidents') {
        return send(200, { incidents: db.prepare('SELECT * FROM incidents ORDER BY id DESC').all() });
      }
      const match = url.pathname.match(/^\/api\/incidents\/([1-9]\d*)$/);
      if (match && req.method === 'GET') {
        const incident = db.prepare('SELECT * FROM incidents WHERE id=?').get(Number(match[1]));
        if (!incident) throw fail(404, 'This incident is lost to legend.');
        return send(200, { ...incident, events: db.prepare('SELECT * FROM events WHERE incident_id=? ORDER BY id').all(incident.id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/incidents' || req.method === 'PATCH' && match) {
        // JSON-only writes and exact-origin checks prevent cross-site form submission.
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`)
          throw fail(403, 'Cross-realm requests are forbidden.');
        const ip = req.socket.remoteAddress || 'unknown';
        const minute = Math.floor(Date.now() / 60000);
        for (const [key, value] of writes) if (value.minute !== minute) writes.delete(key);
        const rate = writes.get(ip) || { minute, count: 0 };
        if (++rate.count > 30) { res.setHeader('Retry-After', '60'); throw fail(429, 'Too many spells. Try again in a minute.'); }
        writes.set(ip, rate);
        const body = await jsonBody(req);
        const now = new Date().toISOString();
        if (req.method === 'POST') {
          const title = field(body.title, 'Title', 3, 120);
          const description = field(body.description, 'Description', 10, 3000);
          const severity = choice(body.severity, 'severity', severityValues);
          const service = field(body.service, 'Affected service', 2, 60);
          const assignee = field(body.assignee, 'Adventurer', 2, 60);
          if (db.prepare('SELECT COUNT(*) AS count FROM incidents').get().count >= 500) throw fail(409, 'The demo ledger is full (500 incidents).');
          const id = transaction(db, () => {
            const id = Number(db.prepare("INSERT INTO incidents (title,description,severity,service,assignee,status,created_at,updated_at) VALUES (?,?,?,?,?,'investigating',?,?)").run(title, description, severity, service, assignee, now, now).lastInsertRowid);
            db.prepare('INSERT INTO events (incident_id,body,status,created_at) VALUES (?,?,?,?)').run(id, 'The alarm was sounded. An adventurer has been dispatched.', 'investigating', now);
            return id;
          });
          return send(201, db.prepare('SELECT * FROM incidents WHERE id=?').get(id));
        }
        const id = Number(match[1]);
        if (!db.prepare('SELECT id FROM incidents WHERE id=?').get(id)) throw fail(404, 'This incident is lost to legend.');
        const status = choice(body.status, 'status', statusValues);
        const note = field(body.note, 'Investigation note', 3, 3000);
        transaction(db, () => {
          if (db.prepare('SELECT COUNT(*) AS count FROM events WHERE incident_id=?').get(id).count >= 200) throw fail(409, 'This incident has reached its 200-update demo limit.');
          db.prepare('UPDATE incidents SET status=?, updated_at=?, resolved_at=? WHERE id=?').run(status, now, status === 'resolved' ? now : null, id);
          db.prepare('INSERT INTO events (incident_id,body,status,created_at) VALUES (?,?,?,?)').run(id, note, status, now);
        });
        return send(200, db.prepare('SELECT * FROM incidents WHERE id=?').get(id));
      }
      throw fail(404, 'No quest found at this path.');
    } catch (error) {
      if (!error.status) console.error('Request failed:', error.message);
      if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'The realm hit a snag. Please try again.' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, db };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const argument = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const port = Number(argument('--port') || process.env.PORT || 3000);
  const host = argument('--host') || process.env.HOST || '127.0.0.1';
  const { server, db } = createApp();
  server.listen(port, host, () => console.log(`DNS & Dragons is keeping watch at http://${host}:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => { db.close(); process.exit(0); });
  });
}
