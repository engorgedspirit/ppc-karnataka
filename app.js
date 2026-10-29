/* PPC Karnataka planner — map, stamp tracker and ride planner.
 * Static data: data/sites.json. Your data: data/progress.csv + data/state.json in the GitHub repo,
 * written through the GitHub Contents API with a token kept only in this browser. */
'use strict';

// ---------- small helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
};
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200); };
const hav = (a, b) => {
  const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const toMin = hhmm => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); };
const fmt = min => { if (min == null || !isFinite(min)) return '—'; min = Math.round(min); const d = Math.floor(min / 1440); min -= d * 1440; const s = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; return d > 0 ? `${s} (+${d}d)` : d < 0 ? `${s} (prev day)` : s; };
const fmtDur = min => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
const uid = () => Math.random().toString(36).slice(2, 9);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- state ----------
let SITES = [];          // from sites.json
let POS = {};            // poKey -> {key, po, pin, type, lat, lon, district, sites: [...]}
let progress = {};       // siteId -> {stamped, date, page, notes}
let state = { settings: {}, poHours: {}, trips: [], activeTrip: null };
const DEFAULT_SETTINGS = {
  speedKmh: 20, stopMin: 20, bufferMin: 45,
  hours: { main: { wk: '10:00-17:00', sat: '10:00-13:00' }, branch: { wk: '09:00-12:00', sat: '09:00-12:00' } },
};
let local = ls.get('ppc.local', { home: null, gh: { owner: '', repo: '', branch: 'main', token: '' } });
const saveLocal = () => ls.set('ppc.local', local);

// ---------- CSV ----------
const PROGRESS_COLS = ['id', 'site', 'stamped', 'date', 'booklet_page', 'notes'];
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
  const lines = [PROGRESS_COLS.join(',')];
  for (const s of SITES) {
    const p = progress[s.id]; if (!p || (!p.stamped && !p.date && !p.page && !p.notes)) continue;
    lines.push([s.id, s.name, p.stamped ? 'Y' : 'N', p.date || '', p.page || '', p.notes || ''].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
function csvToProgress(text) {
  const out = {};
  for (const r of csvParse(text)) out[r.id] = { stamped: r.stamped === 'Y', date: r.date, page: r.booklet_page, notes: r.notes };
  return out;
}
const stateToJson = () => JSON.stringify({ settings: state.settings, poHours: state.poHours, trips: state.trips }, null, 1) + '\n';

// ---------- GitHub sync ----------
const sync = { sha: {}, remote: {}, dirty: ls.get('ppc.dirty', false), timer: null, status: 'local' };
const ghReady = () => local.gh.owner && local.gh.repo && local.gh.token;
const ghUrl = p => `https://api.github.com/repos/${local.gh.owner}/${local.gh.repo}/contents/${p}`;
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = s => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));
async function ghGet(path) {
  const r = await fetch(`${ghUrl(path)}?ref=${encodeURIComponent(local.gh.branch || 'main')}&t=${Date.now()}`, {
    headers: { Authorization: `Bearer ${local.gh.token}`, Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json(); sync.sha[path] = j.sha; return b64dec(j.content);
}
async function ghPut(path, content, msg) {
  const body = { message: msg, content: b64enc(content), branch: local.gh.branch || 'main' };
  if (sync.sha[path]) body.sha = sync.sha[path];
  let r = await fetch(ghUrl(path), { method: 'PUT', headers: { Authorization: `Bearer ${local.gh.token}`, Accept: 'application/vnd.github+json' }, body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) { await ghGet(path); body.sha = sync.sha[path]; r = await fetch(ghUrl(path), { method: 'PUT', headers: { Authorization: `Bearer ${local.gh.token}`, Accept: 'application/vnd.github+json' }, body: JSON.stringify(body) }); }
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  sync.sha[path] = (await r.json()).content.sha; sync.remote[path] = content;
}
function setSync(status, text) { sync.status = status; const p = $('#sync-pill'); p.className = status; p.textContent = text; }
function persist(reason = 'Update') {
  ls.set('ppc.progress', progress); ls.set('ppc.state', state);
  sync.dirty = true; ls.set('ppc.dirty', true);
  if (!ghReady()) { setSync('local', 'Saved on this device'); return; }
  setSync('pending', 'Saving…');
  clearTimeout(sync.timer); sync.timer = setTimeout(() => pushNow(reason), 1500);
}
async function pushNow(reason = 'Update') {
  if (!ghReady() || !navigator.onLine) { setSync('pending', navigator.onLine ? 'Not synced' : 'Offline – will sync'); return; }
  try {
    const csv = progressToCsv(), js = stateToJson();
    if (csv !== sync.remote['data/progress.csv']) await ghPut('data/progress.csv', csv, `progress: ${reason}`);
    if (js !== sync.remote['data/state.json']) await ghPut('data/state.json', js, `trips/settings: ${reason}`);
    sync.dirty = false; ls.set('ppc.dirty', false); setSync('ok', 'Synced ✓');
  } catch (e) { setSync('err', 'Sync failed'); console.error(e); }
}
async function pull() {
  // Remote is the source of truth unless this device has unsynced edits.
  try {
    let csv, js;
    if (ghReady()) { csv = await ghGet('data/progress.csv'); js = await ghGet('data/state.json'); }
    else {
      const [a, b] = await Promise.all([fetch('data/progress.csv', { cache: 'no-store' }), fetch('data/state.json', { cache: 'no-store' })]);
      csv = a.ok ? await a.text() : null; js = b.ok ? await b.text() : null;
    }
    sync.remote['data/progress.csv'] = csv; sync.remote['data/state.json'] = js;
    if (sync.dirty && ghReady()) { await pushNow('sync offline edits'); return; }
    if (sync.dirty) { setSync('local', 'Saved on this device'); return; }
    if (csv != null) progress = csvToProgress(csv);
    if (js) { const s = JSON.parse(js); state.settings = s.settings || {}; state.poHours = s.poHours || {}; state.trips = s.trips || []; }
    ls.set('ppc.progress', progress); ls.set('ppc.state', state);
    setSync(ghReady() ? 'ok' : 'local', ghReady() ? 'Synced ✓' : 'Read-only (add token)');
  } catch (e) { setSync('err', 'Offline copy'); console.error(e); }
}

// ---------- settings / hours ----------
const S = () => ({ ...DEFAULT_SETTINGS, ...state.settings, hours: { ...DEFAULT_SETTINGS.hours, ...(state.settings.hours || {}) } });
function windowFor(po, dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00') : new Date();
  const dow = d.getDay(); if (dow === 0) return { closed: true, label: 'Closed (Sunday)' };
  const o = state.poHours[po.key] || {};
  const def = S().hours[po.type === 'B.O' ? 'branch' : 'main'];
  const spec = dow === 6 ? (o.sat || def.sat) : (o.wk || def.wk);
  if (!spec || /closed/i.test(spec)) return { closed: true, label: 'Closed' };
  const [a, b] = spec.split('-');
  return { open: toMin(a), close: toMin(b), label: `${DOW[dow]} ${spec}${state.poHours[po.key] ? '' : ' (default)'}` };
}

// ---------- routing ----------
const routeCache = ls.get('ppc.routes', {});
async function fetchTimeout(url, ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await fetch(url, { signal: c.signal }); } finally { clearTimeout(t); } }
async function routeLeg(a, b) {
  const key = [a, b].map(p => p.map(x => x.toFixed(4)).join(',')).join(';');
  if (routeCache[key]) return routeCache[key];
  const coords = `${a[1]},${a[0]};${b[1]},${b[0]}`;
  const sources = [
    [`https://routing.openstreetmap.de/routed-bike/route/v1/bike/${coords}?overview=simplified&geometries=geojson`, 'bike route'],
    [`https://router.project-osrm.org/route/v1/driving/${coords}?overview=simplified&geometries=geojson`, 'road route'],
  ];
  for (const [url, src] of sources) {
    try {
      const r = await fetchTimeout(url, 8000); if (!r.ok) continue;
      const j = await r.json(); if (j.code !== 'Ok') continue;
      const leg = { km: j.routes[0].distance / 1000, line: j.routes[0].geometry.coordinates.map(([x, y]) => [y, x]), src };
      routeCache[key] = leg; ls.set('ppc.routes', routeCache); return leg;
    } catch { }
  }
  return { km: hav(a, b) * 1.3, line: [a, b], src: 'estimate (straight line ×1.3)' };
}

// ---------- trip model ----------
const activeTrip = () => state.trips.find(t => t.id === state.activeTrip) || null;
function newTrip(name) {
  const t = { id: uid(), name: name || 'New trip', days: [newDay()] };
  state.trips.push(t); state.activeTrip = t.id; persist('new trip'); return t;
}
function newDay(prev) {
  const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); // next Saturday
  let date = d.toISOString().slice(0, 10);
  if (prev?.date) { const p = new Date(prev.date + 'T00:00'); p.setDate(p.getDate() + 1); date = p.toISOString().slice(0, 10); }
  return { id: uid(), date, depart: '', start: prev ? { kind: 'prev' } : { kind: 'home' }, end: prev ? { kind: 'stay' } : { kind: 'home' }, stops: [] };
}
function pointOf(spec, day, trip) {
  if (!spec) return null;
  if (spec.kind === 'home') return local.home ? { label: local.home.label || 'Home', ll: [local.home.lat, local.home.lon] } : null;
  if (spec.kind === 'custom') return { label: spec.label || 'Custom point', ll: [spec.lat, spec.lon] };
  if (spec.kind === 'po') { const p = POS[spec.key]; return p ? { label: p.po, ll: [p.lat, p.lon] } : null; }
  if (spec.kind === 'prev') {
    const i = trip.days.indexOf(day); const pd = trip.days[i - 1]; if (!pd) return null;
    const pe = pd.end.kind === 'stay' ? (pd.stops.length ? pointOf({ kind: 'po', key: pd.stops.at(-1) }) : pointOf(pd.start, pd, trip)) : pointOf(pd.end, pd, trip);
    return pe && { label: `${pe.label} (overnight)`, ll: pe.ll };
  }
  if (spec.kind === 'stay') return null;
  return null;
}

async function planDay(day, trip) {
  const set = S();
  const start = pointOf(day.start, day, trip);
  const stops = day.stops.map(k => POS[k]).filter(Boolean);
  const end = day.end.kind === 'stay' ? null : pointOf(day.end, day, trip);
  if (!start) return { error: day.start.kind === 'home' ? 'Set your home location in Settings (or choose another start).' : 'Choose a start point.' };
  const pts = [start.ll, ...stops.map(p => [p.lat, p.lon]), ...(end ? [end.ll] : [])];
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) legs.push(await routeLeg(pts[i], pts[i + 1]));
  const ride = km => km / set.speedKmh * 60;
  const wins = stops.map(p => windowFor(p, day.date));
  // Latest departure so every counter is reached `bufferMin` before closing (backward pass).
  // A stop can't be left before it opens, so if open + stop time + ride already overshoots the next
  // counter's deadline, no departure time works: that pair is reported as the blocker.
  let latestArr = Infinity, blocker = null;
  for (let i = stops.length - 1; i >= 0; i--) {
    const w = wins[i]; const own = w.closed ? -Infinity : w.close - set.bufferMin;
    if (w.closed && !blocker) blocker = { stop: stops[i], why: `${stops[i].po} is closed that day` };
    const viaNext = i < stops.length - 1 ? latestArr - set.stopMin - ride(legs[i + 1].km) : Infinity;
    if (!w.closed && w.open > viaNext && !blocker) blocker = { stop: stops[i + 1], why: `even leaving ${stops[i].po} right when it opens (${fmt(w.open)}), you reach ${stops[i + 1].po} after its cut-off` };
    latestArr = Math.min(own, viaNext);
  }
  const latestDepart = stops.length && !blocker ? latestArr - ride(legs[0].km) : null;
  // Suggested start: reach the first counter as it opens (no point waiting outside), never after the latest.
  const ideal = stops.length && !wins[0].closed ? wins[0].open - ride(legs[0].km) : null;
  const suggested = latestDepart != null ? Math.min(latestDepart, ideal ?? latestDepart) : ideal;
  const depart = day.depart ? toMin(day.depart) : (suggested ?? 6 * 60);
  // Forward simulation from the chosen (or latest) departure.
  let t = depart; const rows = [];
  stops.forEach((p, i) => {
    t += ride(legs[i].km); const arrive = t, w = wins[i]; let status, wait = 0;
    if (w.closed) status = 'miss';
    else { if (arrive < w.open) { wait = w.open - arrive; t = w.open; } status = arrive > w.close ? 'miss' : arrive > w.close - set.bufferMin ? 'tight' : 'ok'; }
    rows.push({ po: p, leg: legs[i], arrive, wait, win: w, status, unstamped: p.sites.filter(s => !progress[s.id]?.stamped).length });
    t += set.stopMin;
  });
  const lastLeg = end ? legs.at(-1) : null;
  const finish = end ? t + ride(lastLeg.km) : t;
  const km = legs.reduce((a, l) => a + l.km, 0);
  return { start, end, rows, lastLeg, depart, latestDepart, suggested, blocker, finish, km, rideMin: ride(km), lines: legs.map(l => l.line) };
}

// Unstamped post offices close to the day's route, by extra distance (straight-line estimate ×1.3).
function nearby(day, trip, plan, maxDetour = 40) {
  if (!plan || plan.error) return [];
  const pts = [plan.start.ll, ...plan.rows.map(r => [r.po.lat, r.po.lon]), ...(plan.end ? [plan.end.ll] : [])];
  const inTrip = new Set(trip.days.flatMap(d => d.stops));
  const out = [];
  for (const p of Object.values(POS)) {
    if (inTrip.has(p.key) || p.lat == null || p.sites.every(s => progress[s.id]?.stamped)) continue;
    const x = [p.lat, p.lon]; let best = Infinity;
    if (pts.length === 1) best = 2 * hav(pts[0], x);
    for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, hav(pts[i], x) + hav(x, pts[i + 1]) - hav(pts[i], pts[i + 1]));
    if (!plan.end && pts.length > 1) best = Math.min(best, hav(pts.at(-1), x));
    best *= 1.3;
    if (best <= maxDetour) out.push({ po: p, detour: best });
  }
  return out.sort((a, b) => a.detour - b.detour).slice(0, 8);
}

// Reorder stops: nearest-neighbour from the start, then 2-opt on straight-line distance.
function optimizeOrder(day, trip) {
  const start = pointOf(day.start, day, trip); if (!start || day.stops.length < 3) return;
  const P = k => [POS[k].lat, POS[k].lon];
  let rest = [...day.stops], cur = start.ll, order = [];
  while (rest.length) { rest.sort((a, b) => hav(cur, P(a)) - hav(cur, P(b))); const n = rest.shift(); order.push(n); cur = P(n); }
  const end = pointOf(day.end, day, trip);
  const len = o => { let d = hav(start.ll, P(o[0])); for (let i = 1; i < o.length; i++) d += hav(P(o[i - 1]), P(o[i])); return d + (end ? hav(P(o.at(-1)), end.ll) : 0); };
  let improved = true;
  while (improved) { improved = false; for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) { const c = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)]; if (len(c) < len(order) - 0.01) { order = c; improved = true; } } }
  day.stops = order;
}

// ---------- map ----------
let map, markers = {}, routeLayer, pickHandler = null;
function poColor(p) {
  const trip = activeTrip(); const inTrip = trip && trip.days.some(d => d.stops.includes(p.key));
  const done = p.sites.filter(s => progress[s.id]?.stamped).length;
  if (inTrip) return { color: '#e8590c', fill: '#e8590c' };
  if (done === p.sites.length) return { color: '#2f9e44', fill: '#2f9e44' };
  if (done > 0) return { color: '#2f9e44', fill: '#b2f2bb' };
  return p.sites.every(s => s.kind === 'extra') ? { color: '#7048e8', fill: '#d0bfff' } : { color: '#495057', fill: '#adb5bd' };
}
function initMap() {
  map = L.map('map', { zoomControl: true }).setView([14.6, 76.2], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  for (const p of Object.values(POS)) {
    if (p.lat == null) continue;
    const m = L.circleMarker([p.lat, p.lon], { radius: 6 + Math.min(p.sites.length, 5), weight: 2, fillOpacity: .85 });
    m.bindPopup(() => popupHtml(p), { maxWidth: 300 });
    m.bindTooltip(`${p.po} · ${p.sites.length} PPC`, { direction: 'top' });
    m.addTo(map); markers[p.key] = m;
  }
  map.on('click', e => { if (pickHandler) { const h = pickHandler; pickHandler = null; document.body.classList.remove('picking'); h(e.latlng); } });
  refreshMarkers();
}
function refreshMarkers() { for (const [k, m] of Object.entries(markers)) { const c = poColor(POS[k]); m.setStyle({ color: c.color, fillColor: c.fill }); } }
function popupHtml(p) {
  const trip = activeTrip(); const w = windowFor(p, trip?.days[0]?.date);
  const sites = p.sites.map(s => `<label><input type="checkbox" data-stamp="${s.id}" ${progress[s.id]?.stamped ? 'checked' : ''}> <span>${esc(s.name)}${s.kind === 'extra' ? ' <span class="badge extra">other PPC</span>' : ''}${s.design ? `<br><span class="muted small">${esc(s.design)}</span>` : ''}</span></label>`).join('');
  const dayOpts = trip ? trip.days.map((d, i) => `<option value="${d.id}">Day ${i + 1} · ${d.date}</option>`).join('') : '';
  const flag = p.sites.map(s => s.notes).filter(Boolean).join('; ');
  return `<h4>${esc(p.po)}</h4>
    <div class="muted small">${esc(p.district || '')} · PIN ${esc(p.pin || '?')} · ${esc(p.type || 'type ?')}${p.geo === 'site location' ? ' · 📍 pin at landmark, PO location approx.' : ''}</div>
    <div class="small">Hours: ${esc(w.label)} <a href="#" data-hours="${esc(p.key)}">edit</a></div>
    <div class="popup-sites">${sites}</div>
    ${flag ? `<div class="small muted">⚠ ${esc(flag)}</div>` : ''}
    <div class="row" style="margin-top:6px">
      ${trip ? `<select data-day-for="${esc(p.key)}">${dayOpts}</select><button class="btn small primary" data-add="${esc(p.key)}">Add to trip</button>` : `<button class="btn small primary" data-newtrip="${esc(p.key)}">Start a trip here</button>`}
    </div>
    <div class="small" style="margin-top:6px"><a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.po + ' ' + (p.pin || '') + ' Karnataka')}">Google Maps: post office</a>
    · <a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=bicycling">Directions</a></div>`;
}
function flyTo(key) { const p = POS[key]; if (!p || p.lat == null) return; map.flyTo([p.lat, p.lon], 12); setTimeout(() => markers[key]?.openPopup(), 600); if (innerWidth < 800) $('#map').scrollIntoView({ behavior: 'smooth' }); }
function pickOnMap(msg, cb) { pickHandler = cb; document.body.classList.add('picking'); toast(msg); if (innerWidth < 800) $('#map').scrollIntoView({ behavior: 'smooth' }); }

// ---------- stamping ----------
function setStamped(id, on) {
  const p = progress[id] || (progress[id] = {});
  p.stamped = on; if (on && !p.date) p.date = new Date().toISOString().slice(0, 10);
  persist(`${on ? 'stamped' : 'unstamped'} ${SITES.find(s => s.id === id)?.name}`); refreshMarkers(); renderProgress();
  if ($('#tab-sites').classList.contains('active')) renderSites();
}
function renderProgress() {
  const pass = SITES.filter(s => s.kind === 'passport'), ext = SITES.filter(s => s.kind === 'extra');
  const n = a => a.filter(s => progress[s.id]?.stamped).length;
  $('#progress-pill').textContent = `${n(pass)}/${pass.length} passport · ${n(ext)}/${ext.length} other`;
}

// ---------- Trip tab ----------
let renderSeq = 0;
async function renderTrip() {
  const el = $('#tab-trip'), seq = ++renderSeq, trip = activeTrip();
  const tripOpts = state.trips.map(t => `<option value="${t.id}" ${t.id === state.activeTrip ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  let html = `<div class="row">
      <div><label>Trip</label><select id="trip-select">${tripOpts || '<option value="">— none —</option>'}</select></div>
      <button class="btn" id="trip-new">+ New</button>
    </div>`;
  if (!trip) { el.innerHTML = html + `<p class="muted">Create a trip, then tap post offices on the map to add them. Example: a Saturday ride to Kolar.</p>`; bindTrip(); return; }
  html += `<div class="row"><div><label>Name</label><input id="trip-name" value="${esc(trip.name)}"></div>
      <button class="btn" id="trip-del" title="Delete trip">🗑</button></div>`;
  el.innerHTML = html + trip.days.map((d, i) => `<div class="card" id="day-${d.id}"><b>Day ${i + 1}</b> <span class="muted">planning…</span></div>`).join('') +
    `<button class="btn" id="day-add">+ Add day</button>`;
  bindTrip();
  routeLayer.clearLayers();
  const colors = ['#e8590c', '#1971c2', '#2f9e44', '#9c36b5', '#f08c00'];
  for (const [i, d] of trip.days.entries()) {
    const plan = await planDay(d, trip); if (seq !== renderSeq) return;
    const card = $(`#day-${d.id}`); if (!card) continue;
    card.innerHTML = dayHtml(d, i, trip, plan);
    if (!plan.error) plan.lines.forEach(line => L.polyline(line, { color: colors[i % colors.length], weight: 4, opacity: .75 }).addTo(routeLayer));
    bindDay(card, d, trip);
  }
}
function pointSelect(name, spec, isStart, i) {
  const opts = [['home', 'Home'], ...(isStart && i > 0 ? [['prev', 'Where previous day ended']] : []), ...(!isStart ? [['stay', 'Stay at last stop (no return)']] : []), ['custom', spec.kind === 'custom' ? `📍 ${spec.label || 'Custom point'}` : 'Pick on map…']];
  return `<select data-point="${name}">${opts.map(([v, l]) => `<option value="${v}" ${spec.kind === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function dayHtml(d, i, trip, plan) {
  const dow = DOW[new Date(d.date + 'T00:00').getDay()];
  let h = `<div class="day-head"><b>Day ${i + 1} · ${dow}</b>
      <span>${trip.days.length > 1 ? `<button class="btn small" data-act="del-day">Remove day</button>` : ''}</span></div>
    <div class="row"><div><label>Date</label><input type="date" data-f="date" value="${d.date}"></div>
      <div><label>Depart (blank = suggested)</label><input type="time" data-f="depart" value="${d.depart || ''}"></div></div>
    <div class="row"><div><label>Start</label>${pointSelect('start', d.start, true, i)}</div><div><label>End</label>${pointSelect('end', d.end, false, i)}</div></div>`;
  if (plan.error) return h + `<p class="muted">⚠ ${esc(plan.error)}</p>`;
  if (!plan.rows.length) return h + `<p class="muted">Tap a post office on the map and choose “Add to trip”.</p>`;
  const anyMiss = plan.rows.some(r => r.status === 'miss'), anyTight = plan.rows.some(r => r.status === 'tight');
  h += plan.blocker
    ? `<div class="card" style="border-color:var(--bad);margin-top:8px"><b style="color:var(--bad)">This day doesn't work as planned.</b><div class="small">${esc(plan.blocker.why)}. Try “Optimise order”, move a stop to another day, or correct the hours if you know them.</div></div>`
    : `<div style="margin-top:8px">Start at <span class="leave-by">${fmt(plan.suggested)}</span> <span class="muted">· latest ${fmt(plan.latestDepart)}</span>
      ${d.depart ? `<span class="muted"> · your plan ${d.depart}</span>` : ''}</div>
    <div class="muted small">start = reach the first counter as it opens · latest = every counter still ${S().bufferMin} min before closing</div>`;
  h += `
    <div class="summary"><div><b>${plan.km.toFixed(0)} km</b>total</div><div><b>${fmtDur(plan.rideMin)}</b>riding</div><div><b>${fmt(plan.finish)}</b>${plan.end ? 'back' : 'last stop done'}</div></div>
    ${anyMiss ? '<div class="badge miss">✖ a counter will be closed – reorder, leave earlier or split the day</div>' : anyTight ? '<div class="badge tight">⚠ inside the buffer at one stop</div>' : ''}
    <ol class="stops"><li class="leg">🚩 ${esc(plan.start.label)} · depart ${fmt(plan.depart)}</li>`;
  plan.rows.forEach((r, j) => {
    h += `<li class="leg">↓ ${r.leg.km.toFixed(1)} km · ${fmtDur(r.leg.km / S().speedKmh * 60)}${r.leg.src.startsWith('estimate') ? ' · est.' : ''}</li>
      <li class="${r.status}"><div class="stop-title"><span><b>${esc(r.po.po)}</b> <span class="muted small">${esc(r.po.pin || '')}</span></span>
        <span class="acts"><button class="btn small" data-act="up" data-i="${j}" ${j ? '' : 'disabled'}>↑</button><button class="btn small" data-act="down" data-i="${j}" ${j < plan.rows.length - 1 ? '' : 'disabled'}>↓</button><button class="btn small" data-act="rm" data-i="${j}">✕</button></span></div>
        <div class="small">Arrive ${fmt(r.arrive)}${r.wait ? ` · wait ${Math.round(r.wait)} min` : ''} · ${esc(r.win.label)} <span class="badge ${r.status}">${{ ok: 'ok', tight: 'tight', miss: 'closed' }[r.status]}</span></div>
        <div class="small muted">${r.po.sites.length} PPC${r.po.sites.length > 1 ? 's' : ''}${r.unstamped < r.po.sites.length ? ` · ${r.po.sites.length - r.unstamped} already stamped` : ''}: ${r.po.sites.map(s => esc(s.name)).join(', ')}</div></li>`;
  });
  if (plan.end) h += `<li class="leg">↓ ${plan.lastLeg.km.toFixed(1)} km · ${fmtDur(plan.lastLeg.km / S().speedKmh * 60)}</li><li class="leg">🏁 ${esc(plan.end.label)} · ${fmt(plan.finish)}</li>`;
  h += `</ol>${d.stops.length > 2 ? '<button class="btn small" data-act="opt">Optimise order</button>' : ''}`;
  const nb = nearby(d, trip, plan);
  if (nb.length) h += `<h3>Nearby, not in trip</h3>` + nb.map(n => `<div class="stop-title small" style="padding:3px 0"><span><a href="#" data-fly="${esc(n.po.key)}">${esc(n.po.po)}</a> <span class="muted">+${n.detour.toFixed(0)} km · ${n.po.sites.length} PPC</span></span><button class="btn small" data-act="add" data-key="${esc(n.po.key)}">+ add</button></div>`).join('');
  return h;
}
function bindTrip() {
  $('#trip-select')?.addEventListener('change', e => { state.activeTrip = e.target.value; persist('switch trip'); refreshMarkers(); renderTrip(); });
  $('#trip-new')?.addEventListener('click', () => { const n = prompt('Trip name', 'Kolar Saturday'); if (n == null) return; newTrip(n); refreshMarkers(); renderTrip(); });
  $('#trip-name')?.addEventListener('change', e => { activeTrip().name = e.target.value; persist('rename trip'); renderTrip(); });
  $('#trip-del')?.addEventListener('click', () => { const t = activeTrip(); if (!confirm(`Delete “${t.name}”?`)) return; state.trips = state.trips.filter(x => x !== t); state.activeTrip = state.trips[0]?.id || null; persist('delete trip'); refreshMarkers(); renderTrip(); });
  $('#day-add')?.addEventListener('click', () => { const t = activeTrip(); t.days.push(newDay(t.days.at(-1))); persist('add day'); renderTrip(); });
}
function bindDay(card, d, trip) {
  const save = (why) => { persist(why); refreshMarkers(); renderTrip(); };
  card.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', () => { d[inp.dataset.f] = inp.value; save('edit day'); }));
  card.querySelectorAll('[data-point]').forEach(sel => sel.addEventListener('change', () => {
    const which = sel.dataset.point, v = sel.value;
    if (v === 'custom') pickOnMap('Tap the map to set the point', ll => { const label = prompt('Name this point', which === 'start' ? 'Start' : 'End') || 'Custom point'; d[which] = { kind: 'custom', lat: ll.lat, lon: ll.lng, label }; save('set point'); });
    else { d[which] = { kind: v }; save('set point'); }
  }));
  card.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault(); const i = +b.dataset.i, a = b.dataset.act;
    if (a === 'up') [d.stops[i - 1], d.stops[i]] = [d.stops[i], d.stops[i - 1]];
    if (a === 'down') [d.stops[i + 1], d.stops[i]] = [d.stops[i], d.stops[i + 1]];
    if (a === 'rm') d.stops.splice(i, 1);
    if (a === 'opt') optimizeOrder(d, trip);
    if (a === 'add') d.stops.push(b.dataset.key);
    if (a === 'del-day') { if (!confirm('Remove this day?')) return; trip.days = trip.days.filter(x => x !== d); }
    save(a === 'add' ? 'add stop' : 'edit stops');
  }));
  card.querySelectorAll('[data-fly]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); flyTo(a.dataset.fly); }));
}

// ---------- Sites tab ----------
let siteFilter = { q: '', show: 'all', kind: 'all' };
function renderSites() {
  const el = $('#tab-sites');
  const f = siteFilter, q = f.q.toLowerCase();
  const list = SITES.filter(s => (f.kind === 'all' || s.kind === f.kind) &&
    (f.show === 'all' || (f.show === 'done') === !!progress[s.id]?.stamped) &&
    (!q || `${s.name} ${s.po} ${s.district} ${s.pin} ${s.design}`.toLowerCase().includes(q)));
  const byD = {}; list.forEach(s => (byD[s.district || '—'] ||= []).push(s));
  el.innerHTML = `<input id="site-q" placeholder="Search site, post office, district, PIN" value="${esc(f.q)}">
    <div class="row" style="margin-top:6px">
      <select id="site-show"><option value="all">All</option><option value="todo">Not stamped</option><option value="done">Stamped</option></select>
      <select id="site-kind"><option value="all">Passport + other PPCs</option><option value="passport">Passport sites</option><option value="extra">Other known PPCs</option></select>
    </div>
    <div class="muted small" style="margin-top:6px">${list.length} shown</div>
    <div class="site-list">${Object.keys(byD).sort().map(dn => `<div class="district">${esc(dn)} <span class="muted small">${byD[dn].filter(s => progress[s.id]?.stamped).length}/${byD[dn].length}</span></div>` +
      byD[dn].map(s => { const p = progress[s.id] || {}; return `<div class="site-item"><input type="checkbox" data-stamp="${s.id}" ${p.stamped ? 'checked' : ''}>
        <div style="flex:1"><div class="name" data-fly="${esc(s.poKey)}">${esc(s.name)} ${s.kind === 'extra' ? '<span class="badge extra">other PPC</span>' : ''}</div>
        <div class="muted small">${esc(s.po)} · ${esc(s.pin || '?')}${p.stamped ? ` · ✅ ${esc(p.date || '')}` : ''}${p.page ? ` · p.${esc(p.page)}` : ''}</div>
        ${p.stamped ? `<div class="row small"><input type="date" data-pdate="${s.id}" value="${esc(p.date || '')}"><input placeholder="Booklet page" data-ppage="${s.id}" value="${esc(p.page || '')}"></div><input class="small" placeholder="Notes" data-pnotes="${s.id}" value="${esc(p.notes || '')}" style="margin-top:4px">` : ''}
        </div></div>`; }).join('')).join('')}</div>`;
  $('#site-show').value = f.show; $('#site-kind').value = f.kind;
  const qi = $('#site-q'); qi.addEventListener('input', () => { f.q = qi.value; const pos = qi.selectionStart; renderSites(); const n = $('#site-q'); n.focus(); n.setSelectionRange(pos, pos); });
  $('#site-show').addEventListener('change', e => { f.show = e.target.value; renderSites(); });
  $('#site-kind').addEventListener('change', e => { f.kind = e.target.value; renderSites(); });
  el.querySelectorAll('[data-fly]').forEach(n => n.addEventListener('click', () => flyTo(n.dataset.fly)));
  const upd = (attr, field) => el.querySelectorAll(`[${attr}]`).forEach(inp => inp.addEventListener('change', () => { const id = inp.getAttribute(attr); (progress[id] ||= {})[field] = inp.value; persist(`edit ${field}`); }));
  upd('data-pdate', 'date'); upd('data-ppage', 'page'); upd('data-pnotes', 'notes');
}

// ---------- Settings tab ----------
function renderSettings() {
  const s = S(), g = local.gh;
  $('#tab-settings').innerHTML = `
    <h3>Home (stays on this device)</h3>
    <div class="row"><div class="small">${local.home ? `📍 ${esc(local.home.label)} (${local.home.lat.toFixed(3)}, ${local.home.lon.toFixed(3)})` : '<span class="muted">Not set</span>'}</div>
      <button class="btn" id="home-pick">Pick on map</button><button class="btn" id="home-gps">Use GPS</button></div>
    <h3>Riding</h3>
    <div class="row"><div><label>Average speed incl. short breaks (km/h)</label><input type="number" min="8" max="40" step="0.5" data-s="speedKmh" value="${s.speedKmh}"></div>
      <div><label>Minutes at each post office</label><input type="number" min="0" max="120" data-s="stopMin" value="${s.stopMin}"></div></div>
    <label>Buffer before counter closes (min)</label><input type="number" min="0" max="240" data-s="bufferMin" value="${s.bufferMin}">
    <h3>Default post office hours</h3>
    <div class="row"><div><label>Head/Sub office · Mon–Fri</label><input data-h="main.wk" value="${s.hours.main.wk}"></div><div><label>Saturday</label><input data-h="main.sat" value="${s.hours.main.sat}"></div></div>
    <div class="row"><div><label>Branch office · Mon–Fri</label><input data-h="branch.wk" value="${s.hours.branch.wk}"></div><div><label>Saturday</label><input data-h="branch.sat" value="${s.hours.branch.sat}"></div></div>
    <p class="muted small">Format HH:MM-HH:MM or “closed”. Override a single post office from its map popup (“edit”). ${Object.keys(state.poHours).length} overrides saved.</p>
    <h3>GitHub sync</h3>
    <p class="muted small">Progress is written to <code>data/progress.csv</code> and trips to <code>data/state.json</code> in your repo. The token stays in this browser only.</p>
    <div class="row"><div><label>Owner</label><input data-g="owner" value="${esc(g.owner)}"></div><div><label>Repo</label><input data-g="repo" value="${esc(g.repo)}"></div><div style="flex:.6"><label>Branch</label><input data-g="branch" value="${esc(g.branch)}"></div></div>
    <label>Fine-grained token (Contents: read &amp; write on this repo only)</label><input type="password" data-g="token" value="${esc(g.token)}" placeholder="github_pat_…">
    <div class="row" style="margin-top:8px"><button class="btn primary" id="gh-sync">Sync now</button><button class="btn" id="exp">Export backup</button><button class="btn" id="imp">Import</button></div>
    <input type="file" id="imp-file" accept=".json" hidden>
    <h3>About the data</h3>
    <p class="muted small">${SITES.filter(x => x.kind === 'passport').length} passport sites from philatelypassport.in (community list, verify against your booklet) + ${SITES.filter(x => x.kind === 'extra').length} other known PPCs from indianphilatelics.com, indianphilately.net and globalcoinsandstamps.com. Post office details cross-checked with the India Post pincode directory. Routing © OpenStreetMap / OSRM.</p>`;
  const el = $('#tab-settings');
  el.querySelectorAll('[data-s]').forEach(i => i.addEventListener('change', () => { state.settings[i.dataset.s] = +i.value; persist('settings'); }));
  el.querySelectorAll('[data-h]').forEach(i => i.addEventListener('change', () => { const [k, w] = i.dataset.h.split('.'); state.settings.hours = S().hours; state.settings.hours[k] = { ...state.settings.hours[k], [w]: i.value.trim() }; persist('hours'); }));
  el.querySelectorAll('[data-g]').forEach(i => i.addEventListener('change', () => { local.gh[i.dataset.g] = i.value.trim(); saveLocal(); }));
  $('#home-pick').onclick = () => pickOnMap('Tap your home on the map', ll => { local.home = { lat: ll.lat, lon: ll.lng, label: prompt('Label', 'Home') || 'Home' }; saveLocal(); renderSettings(); renderTrip(); });
  $('#home-gps').onclick = () => navigator.geolocation?.getCurrentPosition(p => { local.home = { lat: p.coords.latitude, lon: p.coords.longitude, label: 'Home' }; saveLocal(); renderSettings(); renderTrip(); toast('Home set from GPS'); }, () => toast('Location not available'));
  $('#gh-sync').onclick = async () => { saveLocal(); setSync('pending', 'Syncing…'); await pull(); refreshAll(); };
  $('#exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ progress, state, home: local.home }, null, 1)], { type: 'application/json' })); a.download = `ppc-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
  $('#imp').onclick = () => $('#imp-file').click();
  $('#imp-file').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); progress = j.progress || {}; state = { ...state, ...j.state }; if (j.home) { local.home = j.home; saveLocal(); } persist('import backup'); refreshAll(); toast('Imported'); } catch { toast('Not a valid backup file'); } };
}

// ---------- global events ----------
document.addEventListener('change', e => { const id = e.target.dataset?.stamp; if (id) setStamped(id, e.target.checked); });
document.addEventListener('click', e => {
  const t = e.target;
  if (t.dataset?.add) { const trip = activeTrip(); const sel = document.querySelector(`[data-day-for="${CSS.escape(t.dataset.add)}"]`); const d = trip.days.find(x => x.id === sel.value) || trip.days[0]; if (!d.stops.includes(t.dataset.add)) d.stops.push(t.dataset.add); persist('add stop'); map.closePopup(); refreshMarkers(); showTab('trip'); renderTrip(); toast('Added to trip'); }
  if (t.dataset?.newtrip) { const n = prompt('Trip name', `${POS[t.dataset.newtrip].po} ride`); if (n == null) return; newTrip(n).days[0].stops.push(t.dataset.newtrip); persist('new trip'); map.closePopup(); refreshMarkers(); showTab('trip'); renderTrip(); }
  if (t.dataset?.hours) {
    e.preventDefault(); const p = POS[t.dataset.hours], o = state.poHours[p.key] || {};
    const wk = prompt(`${p.po}: Mon–Fri hours (HH:MM-HH:MM, “closed”, blank = default)`, o.wk || ''); if (wk == null) return;
    const sat = prompt(`${p.po}: Saturday hours`, o.sat || ''); if (sat == null) return;
    if (wk || sat) state.poHours[p.key] = { ...(wk && { wk }), ...(sat && { sat }) }; else delete state.poHours[p.key];
    persist(`hours ${p.po}`); map.closePopup(); renderTrip();
  }
});
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
  ({ trip: renderTrip, sites: renderSites, settings: renderSettings })[name]();
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
window.addEventListener('online', () => sync.dirty && pushNow('sync offline edits'));
function refreshAll() { refreshMarkers(); renderProgress(); showTab(document.querySelector('.tabs .active').dataset.tab); }

// ---------- boot ----------
(async function boot() {
  SITES = await (await fetch('data/sites.json', { cache: 'no-store' })).json();
  for (const s of SITES) {
    const p = POS[s.poKey] ||= { key: s.poKey, po: s.po, pin: s.pin, type: s.po_type, district: s.district, lat: s.po_lat, lon: s.po_lon, geo: s.po_geo, sites: [] };
    p.sites.push(s);
  }
  progress = ls.get('ppc.progress', {}); state = { ...state, ...ls.get('ppc.state', {}) };
  initMap(); renderProgress(); setSync('local', 'Loading…'); showTab('trip');
  await pull(); refreshAll();
})();
