const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { incidents: [], tab: 'active', query: '', severity: 'all', health: null, selected: null };
const labels = { investigating: 'Investigating', monitoring: 'Monitoring', resolved: 'Resolved' };
const severityLabels = { 'SEV-1': 'Critical', 'SEV-2': 'Major', 'SEV-3': 'Minor' };
// Never interpret user-supplied incident text as markup.
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const incidentId = (id) => `DNS-${String(id).padStart(3, '0')}`;
const date = (value) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function age(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
const badge = (status) => `<span class="status-badge status-${escape(status)}">${escape(labels[status])}</span>`;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The watchtower is unreachable. Please try again.');
  return data;
}
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function showDialog(selector) {
  const dialog = $(selector);
  if (!dialog.open) dialog.showModal();
}
$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) dialog.close();
    // Clicks on the backdrop are outside the dialog's bounds.
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
});

function render() {
  const active = state.incidents.filter((i) => i.status !== 'resolved').length;
  const resolved = state.incidents.length - active;
  $('#stat-active').textContent = active;
  $('#stat-critical').textContent = state.incidents.filter((i) => i.severity === 'SEV-1' && i.status !== 'resolved').length;
  $('#stat-resolved').textContent = resolved;
  $('#nav-count').textContent = active;
  $('#tab-active-count').textContent = active;
  $('#tab-all-count').textContent = state.incidents.length;
  $('#tab-resolved-count').textContent = resolved;
  $$('.tab').forEach((tab) => {
    tab.classList.toggle('current', tab.dataset.tab === state.tab);
    tab.setAttribute('aria-pressed', String(tab.dataset.tab === state.tab));
  });
  const hall = state.tab === 'resolved';
  $('#nav-victories').classList.toggle('selected', hall);
  $('#nav-ledger').classList.toggle('selected', !hall);
  $('#page-breadcrumb').textContent = hall ? 'Hall of victories' : 'Incident ledger';
  $('#page-title').textContent = hall ? 'Peace, briefly restored.' : 'Keep the realm running.';
  $('#page-subtitle').textContent = hall ? 'A toast to the fixes, the root causes, and the brave souls on call.' : 'Here be dragons. And occasionally, DNS issues.';
  $('#ledger-title').textContent = hall ? 'The hall of victories' : 'The incident ledger';
  const query = state.query.toLowerCase().trim();
  const list = state.incidents.filter((i) =>
    (state.tab === 'all' || (state.tab === 'resolved' ? i.status === 'resolved' : i.status !== 'resolved')) &&
    (state.severity === 'all' || state.severity === i.severity) &&
    (!query || [i.title, i.description, i.assignee, i.service, incidentId(i.id)].some((v) => v.toLowerCase().includes(query)))
  );
  $('#incident-list').setAttribute('aria-busy', 'false');
  if (!list.length) {
    const filtered = Boolean(query || state.severity !== 'all');
    $('#incident-list').innerHTML = `<div class="empty-state"><span class="empty-icon" aria-hidden="true">${hall ? '⚑' : '✧'}</span><h3>${filtered ? 'No tales match these scrolls.' : hall ? 'No victories recorded. Yet.' : state.tab === 'active' ? 'A suspiciously peaceful realm.' : 'A fresh chapter awaits.'}</h3><p>${filtered ? 'Try a different search or clear your filters.' : hall ? 'Resolve an incident and write the ending to its story.' : 'Sound the alarm when trouble arrives.'}</p>${filtered ? '<button class="secondary" id="clear-filters">Clear filters</button>' : ''}</div>`;
    $('#clear-filters')?.addEventListener('click', () => { state.query = ''; state.severity = 'all'; $('#search').value = ''; $('#severity-filter').value = 'all'; render(); });
  } else {
    $('#incident-list').innerHTML = list.map((i) => `<button class="incident-card" data-incident="${i.id}" aria-label="Open ${escape(incidentId(i.id))}: ${escape(i.title)}">
      <div class="encounter"><span class="severity-tile sev-${i.severity.slice(-1)}" aria-hidden="true">${i.severity.slice(-1)}</span><div class="encounter-copy"><div class="incident-meta"><span>${incidentId(i.id)}</span><span>·</span><span class="meta-severity sev-text-${i.severity.slice(-1)}">${i.severity} / ${severityLabels[i.severity]}</span></div><h3 class="incident-title">${escape(i.title)}</h3><span class="service-line"><span aria-hidden="true">◇</span> ${escape(i.service)}</span></div></div>
      ${badge(i.status)}<div class="assignee">${escape(i.assignee)}<span class="time">Updated ${age(i.updated_at)}</span></div><span class="card-arrow" aria-hidden="true">↗</span></button>`).join('');
  }
  $('#results-count').textContent = `${list.length} ${list.length === 1 ? 'encounter' : 'encounters'} in view · ${state.incidents.length} in the ledger`;
}
async function load() {
  try {
    const data = await api('/api/incidents');
    state.incidents = data.incidents;
    $('#load-error').hidden = true;
    render();
    return true;
  } catch (error) {
    $('#load-error').hidden = false;
    $('#load-error span').textContent = 'The ledger could not be loaded. Your data is safe on the server.';
    $('#incident-list').setAttribute('aria-busy', 'false');
    $('#incident-list').innerHTML = '';
    $('#results-count').textContent = 'The messenger is having trouble reaching the server.';
    return false;
  }
}
$('#retry').addEventListener('click', load);
$$('.tab').forEach((tab) => tab.addEventListener('click', () => { state.tab = tab.dataset.tab; render(); }));
$('#search').addEventListener('input', (event) => { state.query = event.target.value; render(); });
$('#severity-filter').addEventListener('change', (event) => { state.severity = event.target.value; render(); });
$('#nav-ledger').addEventListener('click', () => { state.tab = 'active'; render(); });
$('#nav-victories').addEventListener('click', () => { state.tab = 'resolved'; render(); });
$('#guide-button').addEventListener('click', () => showDialog('#guide-dialog'));
$('#new-incident').addEventListener('click', () => { $('#create-error').hidden = true; showDialog('#create-dialog'); });

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('[type=submit]');
  button.disabled = true;
  $('#create-error').hidden = true;
  try {
    const incident = await api('/api/incidents', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    $('#create-dialog').close();
    event.target.reset();
    state.tab = 'active'; state.query = ''; state.severity = 'all';
    $('#search').value = ''; $('#severity-filter').value = 'all';
    await load();
    toast(`${incidentId(incident.id)} recorded. Assemble the party.`);
  } catch (error) {
    $('#create-error').textContent = error.message;
    $('#create-error').hidden = false;
  } finally { button.disabled = false; }
});

$('#incident-list').addEventListener('click', (event) => {
  const card = event.target.closest('[data-incident]');
  if (card) openIncident(Number(card.dataset.incident));
});
let detailRequest = 0;
async function openIncident(id) {
  const request = ++detailRequest;
  state.selected = id;
  $('#detail-content').innerHTML = '<div class="modal-top"><span class="eyebrow">UNROLLING THE SCROLL</span><button class="icon-button" data-close aria-label="Close incident">×</button></div><h2 id="detail-title">Loading encounter…</h2>';
  showDialog('#detail-dialog');
  try {
    const i = await api(`/api/incidents/${id}`);
    if (request !== detailRequest) return;
    renderDetail(i);
  } catch (error) {
    if (request !== detailRequest) return;
    $('#detail-content').innerHTML = `<div class="modal-top"><span class="eyebrow">A MISSING SCROLL</span><button class="icon-button" data-close aria-label="Close incident">×</button></div><h2 id="detail-title">Couldn’t open this encounter.</h2><p class="form-error">${escape(error.message)}</p><button class="secondary" id="retry-detail">Try again</button>`;
    $('#retry-detail').addEventListener('click', () => openIncident(id));
  }
}
function renderDetail(i) {
  $('#detail-content').innerHTML = `<div class="modal-top"><span class="eyebrow">${incidentId(i.id)} · ${i.severity} / ${severityLabels[i.severity].toUpperCase()}</span><button class="icon-button" data-close aria-label="Close incident">×</button></div>
    <h2 id="detail-title">${escape(i.title)}</h2><div class="detail-meta">${badge(i.status)}<span>Opened ${date(i.created_at)}</span></div><p class="detail-description">${escape(i.description)}</p>
    <div class="detail-info"><div><span>AFFECTED SERVICE</span><p>${escape(i.service)}</p></div><div><span>ADVENTURER ON DUTY</span><p>${escape(i.assignee)}</p></div></div>
    <h3 class="timeline-title">The investigation log</h3><div class="timeline">${i.events.map((e) => `<div class="timeline-event"><div class="event-meta">${labels[e.status].toUpperCase()} · ${date(e.created_at)}</div><p class="event-body">${escape(e.body)}</p></div>`).join('')}</div>
    <form id="update-form" class="update-form"><label for="update-status">Where does the quest stand?</label><select name="status" id="update-status">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${value === i.status ? 'selected' : ''}>${label}</option>`).join('')}</select><label for="update-note">Leave an investigation note</label><textarea name="note" id="update-note" required minlength="3" maxlength="3000" rows="3" placeholder="What did you discover? If it’s fixed, record the cause and the remedy."></textarea><p id="update-error" class="form-error" role="alert" hidden></p><div class="modal-actions"><button type="button" class="secondary" data-close>Close scroll</button><button class="primary" type="submit">Save update <span aria-hidden="true">↗</span></button></div></form>`;
  $('#update-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('[type=submit]');
    button.disabled = true;
    $('#update-error').hidden = true;
    try {
      const saved = await api(`/api/incidents/${i.id}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
      await load();
      // Avoid resubmitting a successful write if refreshing the timeline fails.
      $('#detail-dialog').close();
      toast(saved.status === 'resolved' ? 'Dragon slain. The realm owes you one.' : 'The scroll has been updated.');
    } catch (error) {
      $('#update-error').textContent = error.message;
      $('#update-error').hidden = false;
    } finally { button.disabled = false; }
  });
}

async function checkHealth() {
  const button = $('#refresh-health');
  button.disabled = true;
  try {
    const response = await fetch('/health', { signal: AbortSignal.timeout(8000) });
    const health = await response.json();
    state.health = health;
    const good = response.ok && health.status === 'ok';
    $$('.health-dot').forEach((dot) => { dot.classList.toggle('good', good); dot.classList.toggle('bad', !good); });
    $('#health-label').textContent = good ? 'Watchtower operational' : 'Watchtower degraded';
    $('#health-content').innerHTML = `<div class="health-row"><span>Application</span><b>${health.app === 'ok' ? 'Operational' : 'Unavailable'}</b></div><div class="health-row"><span>SQLite database query</span><b>${health.database === 'ok' ? 'Connected' : 'Unavailable'}</b></div><div class="health-row"><span>Process uptime</span><span>${health.uptimeSeconds == null ? '—' : `${Math.floor(health.uptimeSeconds / 60)}m ${health.uptimeSeconds % 60}s`}</span></div><p class="health-note">Checked ${date(health.checkedAt || new Date().toISOString())}. This checks the running process and a real query against the incidents table. It does not measure historical uptime.</p>`;
  } catch {
    $$('.health-dot').forEach((dot) => { dot.classList.remove('good'); dot.classList.add('bad'); });
    $('#health-label').textContent = 'Watchtower unreachable';
    $('#health-content').innerHTML = '<p class="form-error">The watchtower isn’t responding. Check the server and try again.</p>';
  } finally { button.disabled = false; }
}
for (const selector of ['#nav-health', '#top-health']) $(selector).addEventListener('click', () => { showDialog('#health-dialog'); checkHealth(); });
$('#refresh-health').addEventListener('click', checkHealth);
load();
checkHealth();
setInterval(checkHealth, 60000);
