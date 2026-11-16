import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

async function running(options, action) {
  const app = createApp(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  try { await action(request, app); }
  finally { await new Promise((done) => app.server.close(done)); try { app.db.close(); } catch {} }
}
const incident = { title: 'The firewall is literally on fire', description: 'The gateway has started breathing actual flames.', service: 'Enchanted gateway', assignee: 'Kanishka, SRE', severity: 'SEV-1' };

test('create, investigate, resolve, reopen, and persist across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dns-dragons-'));
  const dbPath = join(directory, 'realm.sqlite');
  try {
    await running({ dbPath, seed: false }, async (request) => {
      assert.equal((await request('/')).status, 200);
      const created = await request('/api/incidents', 'POST', incident);
      assert.equal(created.status, 201);
      const item = await created.json();
      assert.equal(item.status, 'investigating');
      assert.equal(item.title, incident.title);
      for (const status of ['monitoring', 'resolved', 'investigating']) {
        const update = await request(`/api/incidents/${item.id}`, 'PATCH', { status, note: `Observed and verified ${status}.` });
        assert.equal(update.status, 200);
        const saved = await update.json();
        assert.equal(saved.status, status);
        assert.equal(Boolean(saved.resolved_at), status === 'resolved');
      }
      const detail = await (await request(`/api/incidents/${item.id}`)).json();
      assert.equal(detail.events.length, 4);
    });
    await running({ dbPath, seed: false }, async (request) => {
      const { incidents } = await (await request('/api/incidents')).json();
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].title, incident.title);
      const detail = await (await request(`/api/incidents/${incidents[0].id}`)).json();
      assert.equal(detail.events.length, 4);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('validates fields, JSON, statuses, missing records and cross-origin writes', async () => {
  await running({ dbPath: ':memory:', seed: false }, async (request) => {
    for (const invalid of [{ ...incident, title: ' ' }, { ...incident, severity: 'SEV-999' }, { ...incident, service: 1 }, { ...incident, description: 'x'.repeat(3001) }, null, []])
      assert.equal((await request('/api/incidents', 'POST', invalid)).status, 400);
    assert.equal((await request('/api/incidents', 'POST', incident, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/incidents', 'POST', incident, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await request('/api/incidents/99999')).status, 404);
    assert.equal((await request('/api/incidents/99999', 'PATCH', { status: 'resolved', note: 'Fixed' })).status, 404);
    const item = await (await request('/api/incidents', 'POST', incident)).json();
    assert.equal((await request(`/api/incidents/${item.id}`, 'PATCH', { status: 'resolved', note: '' })).status, 400);
    assert.equal((await request(`/api/incidents/${item.id}`, 'PATCH', { status: 'banana', note: 'Fixed' })).status, 400);
    const detail = await (await request(`/api/incidents/${item.id}`)).json();
    assert.equal(detail.status, 'investigating');
    assert.equal(detail.events.length, 1);
  });
});

test('health reports a real database failure with HTTP 503', async () => {
  await running({ dbPath: ':memory:' }, async (request, { db }) => {
    const healthy = await request('/health');
    assert.equal(healthy.status, 200);
    assert.equal((await healthy.json()).database, 'ok');
    db.close();
    const unhealthy = await request('/health');
    assert.equal(unhealthy.status, 503);
    assert.equal((await unhealthy.json()).database, 'unavailable');
  });
});

test('seeds once and treats SQL-like strings as data', async () => {
  await running({ dbPath: ':memory:' }, async (request) => {
    assert.equal((await (await request('/api/incidents')).json()).incidents.length, 6);
    const hostile = { ...incident, title: "Robert'); DROP TABLE incidents; --", description: '<img src=x onerror=alert(1)> This is stored as plain text.' };
    assert.equal((await request('/api/incidents', 'POST', hostile)).status, 201);
    const records = (await (await request('/api/incidents')).json()).incidents;
    assert.equal(records.length, 7);
    assert.equal(records[0].title, hostile.title);
    const page = await request('/');
    assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self'/);
    assert.equal((await request('/server.mjs')).status, 404);
    assert.equal((await request('/data/realm.sqlite')).status, 404);
  });
});

test('public demo rate limits writes', async () => {
  await running({ dbPath: ':memory:', seed: false }, async (request) => {
    for (let i = 0; i < 30; i++) assert.equal((await request('/api/incidents', 'POST', incident)).status, 201);
    const limited = await request('/api/incidents', 'POST', incident);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
  });
});
