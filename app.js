/* PPC Karnataka — Philately Passport map and stamp tracker.
 * Static data: data/sites.json (booklet 1-100 + unconfirmed extras). Your stamps: data/progress.csv in the GitHub repo,
 * written through the GitHub Contents API with a token kept only in this browser. */
'use strict';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
};
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200); };
const today = () => new Date().toISOString().slice(0, 10);

// ---------- state ----------
let SITES = [];
let progress = {};   // siteId -> {stamped, date, page, notes}
let view = ls.get('ppc.view', { hideStamped: false, showExtras: false, q: '' });
let local = ls.get('ppc.local', { gh: { owner: '', repo: '', branch: 'main', token: '' } });
const saveLocal = () => ls.set('ppc.local', local);
const saveView = () => ls.set('ppc.view', view);
const isDone = s => !!progress[s.id]?.stamped;
const visible = s => (s.kind === 'passport' || view.showExtras) && !(view.hideStamped && isDone(s));

// ---------- CSV ----------
function csvParse(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.some(x => x)).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
const csvCell = v => /[",\n\r]/.test(v = String(v ?? '')) ? `"${v.replace(/"/g, '""')}"` : v;
function progressToCsv() {
  const lines = ['id,no,site,stamped,date,booklet_page,notes'];
  for (const s of SITES) {
    const p = progress[s.id]; if (!p || (!p.stamped && !p.date && !p.page && !p.notes)) continue;
    lines.push([s.id, s.num ?? '', s.name, p.stamped ? 'Y' : 'N', p.date || '', p.page || '', p.notes || ''].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
function csvToProgress(text) {
  const out = {};
  for (const r of csvParse(text)) out[r.id] = { stamped: r.stamped === 'Y', date: r.date, page: r.booklet_page, notes: r.notes };
  return out;
}

// ---------- GitHub sync ----------
const PATH = 'data/progress.csv';
const sync = { sha: null, remote: null, dirty: ls.get('ppc.dirty', false), timer: null };
const ghReady = () => local.gh.owner && local.gh.repo && local.gh.token;
const ghUrl = () => `https://api.github.com/repos/${local.gh.owner}/${local.gh.repo}/contents/${PATH}`;
const ghHeaders = () => ({ Authorization: `Bearer ${local.gh.token}`, Accept: 'application/vnd.github+json' });
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = s => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));
async function ghGet() {
  const r = await fetch(`${ghUrl()}?ref=${encodeURIComponent(local.gh.branch || 'main')}&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) { sync.sha = null; return null; }
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json(); sync.sha = j.sha; return b64dec(j.content);
}
async function ghPut(content, msg) {
  const put = () => fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ message: msg, content: b64enc(content), branch: local.gh.branch || 'main', ...(sync.sha && { sha: sync.sha }) }) });
  let r = await put();
  if (r.status === 409 || r.status === 422) { await ghGet(); r = await put(); }  // stale sha: refetch once, last write wins
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  sync.sha = (await r.json()).content.sha; sync.remote = content;
}
function setSync(cls, text) { const p = $('#sync-pill'); p.className = cls; p.textContent = text; }
function persist(reason) {
  ls.set('ppc.progress', progress); sync.dirty = true; ls.set('ppc.dirty', true);
  if (!ghReady()) { setSync('local', 'Saved on this device'); return; }
  setSync('pending', 'Saving…'); clearTimeout(sync.timer); sync.timer = setTimeout(() => pushNow(reason), 1500);
}
async function pushNow(reason = 'update') {
  if (!ghReady() || !navigator.onLine) { setSync('pending', navigator.onLine ? 'Not synced' : 'Offline – will sync'); return; }
  try {
    const csv = progressToCsv();
    if (csv !== sync.remote) await ghPut(csv, `stamps: ${reason}`);
    sync.dirty = false; ls.set('ppc.dirty', false); setSync('ok', 'Synced ✓');
  } catch (e) { setSync('err', 'Sync failed'); console.error(e); }
}
async function pull() {
  // Remote is the source of truth unless this device has unsynced edits.
  try {
    let csv;
    if (ghReady()) csv = await ghGet();
    else { const r = await fetch(PATH, { cache: 'no-store' }); csv = r.ok ? await r.text() : null; }
    sync.remote = csv;
    if (sync.dirty) { if (ghReady()) await pushNow('sync offline edits'); else setSync('local', 'Saved on this device'); return; }
    if (csv != null) progress = csvToProgress(csv);
    ls.set('ppc.progress', progress);
    setSync(ghReady() ? 'ok' : 'local', ghReady() ? 'Synced ✓' : 'Read-only (add token)');
  } catch (e) { setSync('err', 'Offline copy'); console.error(e); }
}

// ---------- map ----------
let map, markers = {};
function icon(s) {
  const cls = s.kind === 'extra' ? 'extra' : isDone(s) ? 'done' : 'todo';
  return L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12],
    html: `<div class="pin ${cls}">${s.kind === 'extra' ? '•' : s.num}</div>` });
}
function initMap() {
  map = L.map('map').setView([14.6, 76.2], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
  for (const s of SITES) {
    if (s.lat == null) continue;
    markers[s.id] = L.marker([s.lat, s.lon], { icon: icon(s), riseOnHover: true })
      .bindPopup(() => popupHtml(s), { maxWidth: 320 })
      .bindTooltip(`${s.num ? '#' + s.num + ' ' : ''}${s.name}`, { direction: 'top', offset: [0, -12] });
  }
  refreshMarkers();
}
function refreshMarkers() {
  for (const s of SITES) {
    const m = markers[s.id]; if (!m) continue;
    m.setIcon(icon(s)); m.setZIndexOffset(s.kind === 'extra' ? -1000 : 0);
    if (visible(s)) m.addTo(map); else m.remove();
  }
}
function popupHtml(s) {
  const p = progress[s.id] || {};
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`;
  const poSearch = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.official_po || s.po} ${s.pin} Karnataka`)}`;
  const row = (k, v) => v ? `<tr><th>${k}</th><td>${v}</td></tr>` : '';
  return `<div class="pop">
    <div class="pop-head">${s.num ? `<span class="pop-num">${s.num}</span>` : '<span class="badge extra">not in booklet</span>'} <b>${esc(s.name)}</b></div>
    <div class="muted small">${esc(s.district)}</div>
    <table>
      ${row('Seal', s.seal ? `${esc(s.seal)}${s.seal_date ? ` <span class="muted">(${esc(s.seal_date)})</span>` : ''}` : '<span class="muted">see booklet</span>')}
      ${row('Post office', esc(s.po))}
      ${row('PIN', `${esc(s.pin)}${s.pin_alt ? `<div class="muted small">also seen: ${esc(s.pin_alt)}</div>` : ''}`)}
      ${row('India Post', s.official_po ? esc(`${s.official_po}${s.ho ? ' · under ' + s.ho : ''}`) : `<span class="muted">${esc(s.check)}</span>`)}
      ${row('Phone', esc(s.phone))}
      ${row('Location', `<a target="_blank" rel="noopener" href="${gmaps}">Open map</a> · <a target="_blank" rel="noopener" href="${poSearch}">Find PO</a>${/check|PIN area|landmark|approx/.test(s.loc) ? `<div class="muted small">pin is approx. (${esc(s.loc)})</div>` : ''}`)}
    </table>
    <label class="stamp"><input type="checkbox" data-stamp="${s.id}" ${p.stamped ? 'checked' : ''}> Stamped${p.stamped && p.date ? ` on ${esc(p.date)}` : ''}</label>
    ${s.url ? `<div class="small"><a target="_blank" rel="noopener" href="${esc(s.url)}">Community page</a></div>` : ''}
  </div>`;
}
function flyTo(id) {
  const s = SITES.find(x => x.id === id); if (!s || s.lat == null) return;
  if (!visible(s)) { if (s.kind === 'extra') view.showExtras = true; if (isDone(s)) view.hideStamped = false; saveView(); renderFilters(); refreshMarkers(); }
  map.flyTo([s.lat, s.lon], 11); setTimeout(() => markers[s.id]?.openPopup(), 700);
  if (innerWidth < 800) $('#map').scrollIntoView({ behavior: 'smooth' });
}

// ---------- stamping ----------
function setStamped(id, on) {
  const p = progress[id] || (progress[id] = {});
  p.stamped = on; if (on && !p.date) p.date = today();
  const s = SITES.find(x => x.id === id);
  persist(`${on ? 'stamped' : 'unstamped'} ${s.num ? '#' + s.num + ' ' : ''}${s.name}`);
  refreshMarkers(); renderProgress(); renderList();
  if (on && view.hideStamped) map.closePopup();
}
function renderProgress() {
  const pass = SITES.filter(s => s.kind === 'passport');
  const n = pass.filter(isDone).length;
  $('#progress-pill').textContent = `${n}/${pass.length} stamped`;
  $('#progress-bar').style.width = `${(n / pass.length) * 100}%`;
}

// ---------- filters + list ----------
function renderFilters() {
  $('#f-hide').checked = view.hideStamped; $('#f-extra').checked = view.showExtras;
  $('#f-extra-count').textContent = SITES.filter(s => s.kind === 'extra').length;
}
function renderList() {
  const q = view.q.toLowerCase();
  const list = SITES.filter(s => visible(s) && (!q || `${s.num ?? ''} ${s.name} ${s.po} ${s.district} ${s.pin} ${s.seal}`.toLowerCase().includes(q)));
  $('#list-count').textContent = `${list.length} shown`;
  $('#list').innerHTML = list.map(s => {
    const p = progress[s.id] || {};
    return `<div class="item ${s.kind} ${p.stamped ? 'done' : ''}">
      <input type="checkbox" data-stamp="${s.id}" ${p.stamped ? 'checked' : ''} aria-label="Stamped">
      <span class="num">${s.num ?? '–'}</span>
      <div class="body"><div class="name" data-fly="${s.id}">${esc(s.name)}${s.kind === 'extra' ? ' <span class="badge extra">not in booklet</span>' : ''}</div>
        <div class="muted small">${esc(s.po)} · ${esc(s.pin)} · ${esc(s.district)}${p.stamped ? ` · ✅ ${esc(p.date || '')}` : ''}</div>
        ${p.stamped ? `<div class="row small"><input type="date" data-pdate="${s.id}" value="${esc(p.date || '')}"><input placeholder="Notes" data-pnotes="${s.id}" value="${esc(p.notes || '')}"></div>` : ''}
      </div></div>`;
  }).join('') || '<p class="muted">Nothing to show with these filters.</p>';
}

// ---------- settings ----------
function renderSettings() {
  const g = local.gh;
  $('#tab-settings').innerHTML = `
    <h3>GitHub sync</h3>
    <p class="muted small">Stamps are saved to <code>data/progress.csv</code> in your repo (one commit per change). The token stays in this browser only.</p>
    <div class="row"><div><label>Owner</label><input data-g="owner" value="${esc(g.owner)}"></div><div><label>Repo</label><input data-g="repo" value="${esc(g.repo)}"></div><div style="flex:.6"><label>Branch</label><input data-g="branch" value="${esc(g.branch)}"></div></div>
    <label>Fine-grained token (Contents: read &amp; write, this repo only)</label><input type="password" data-g="token" value="${esc(g.token)}" placeholder="github_pat_…">
    <div class="row" style="margin-top:8px"><button class="btn primary" id="gh-sync">Sync now</button><button class="btn" id="exp">Export backup</button><button class="btn" id="imp">Import</button></div>
    <input type="file" id="imp-file" accept=".csv" hidden>
    <h3>Legend</h3>
    <p class="small"><span class="pin todo inline">7</span> pending &nbsp; <span class="pin done inline">7</span> stamped &nbsp; <span class="pin extra inline">•</span> not in booklet (unconfirmed)</p>
    <h3>About the data</h3>
    <p class="muted small">Sites 1–100 follow the Karnataka Philately Passport booklet. Post offices were checked against the India Post pincode directory (2017 copy); seal designs and dates come from indianphilatelics.com and indianphilately.net where published. Extras are from the community site philatelypassport.in and are not in the booklet. Pin positions are geocoded with OpenStreetMap, so some are approximate.</p>`;
  const el = $('#tab-settings');
  el.querySelectorAll('[data-g]').forEach(i => i.addEventListener('change', () => { local.gh[i.dataset.g] = i.value.trim(); saveLocal(); }));
  $('#gh-sync').onclick = async () => { saveLocal(); setSync('pending', 'Syncing…'); await pull(); refreshAll(); };
  $('#exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([progressToCsv()], { type: 'text/csv' })); a.download = `ppc-progress-${today()}.csv`; a.click(); };
  $('#imp').onclick = () => $('#imp-file').click();
  $('#imp-file').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { progress = csvToProgress(await f.text()); persist('import backup'); refreshAll(); toast('Imported'); } catch { toast('Not a valid progress file'); } };
}

// ---------- events ----------
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset?.stamp) setStamped(t.dataset.stamp, t.checked);
  const upd = (attr, field) => { const id = t.getAttribute(attr); if (id) { (progress[id] ||= {})[field] = t.value; persist(`edit ${field}`); } };
  upd('data-pdate', 'date'); upd('data-pnotes', 'notes');
});
document.addEventListener('click', e => { const id = e.target.dataset?.fly; if (id) flyTo(id); });
$('#f-hide').addEventListener('change', e => { view.hideStamped = e.target.checked; saveView(); refreshMarkers(); renderList(); });
$('#f-extra').addEventListener('change', e => { view.showExtras = e.target.checked; saveView(); refreshMarkers(); renderList(); });
$('#q').addEventListener('input', e => { view.q = e.target.value; saveView(); renderList(); });
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
  if (name === 'settings') renderSettings();
}
window.addEventListener('online', () => sync.dirty && pushNow('sync offline edits'));
function refreshAll() { refreshMarkers(); renderProgress(); renderFilters(); renderList(); }

// ---------- boot ----------
(async function boot() {
  SITES = await (await fetch('data/sites.json', { cache: 'no-store' })).json();
  progress = ls.get('ppc.progress', {});
  $('#q').value = view.q || '';
  initMap(); refreshAll(); setSync('local', 'Loading…');
  await pull(); refreshAll();
})();
