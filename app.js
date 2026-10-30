/* PPC Karnataka — Philately Passport map and stamp tracker.
 * Static data: data/sites.json (booklet 1-100 + unconfirmed extras).
 * Progress: Firestore document users/{uid} when signed in (Firebase Auth), otherwise this browser only.
 * firebase-config.js is generated at deploy time from a GitHub secret; without it the site runs local-only. */
const { firebaseConfig = {} } = await import('./firebase-config.js').catch(() => ({}));

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
};
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); };
const today = () => new Date().toISOString().slice(0, 10);

// ---------- state ----------
let SITES = [];
let progress = {};   // siteId -> {stamped, date, notes}
let user = null;     // Firebase user when signed in
let view = ls.get('ppc.view', { hideStamped: false, showExtras: false, q: '' });
const saveView = () => ls.set('ppc.view', view);
const isDone = s => !!progress[s.id]?.stamped;
const visible = s => (s.kind === 'passport' || view.showExtras) && !(view.hideStamped && isDone(s));

// ---------- CSV (export / import) ----------
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
  const lines = ['id,no,site,post_office,pin,stamped,date,notes'];
  for (const s of SITES) {
    const p = progress[s.id]; if (!p || (!p.stamped && !p.notes)) continue;
    lines.push([s.id, s.num ?? '', s.name, s.po, s.pin, p.stamped ? 'Y' : 'N', p.date || '', p.notes || ''].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
function csvToProgress(text) {
  const out = {};
  for (const r of csvParse(text)) if (r.id) out[r.id] = { stamped: r.stamped === 'Y', date: r.date || '', notes: r.notes || '' };
  return out;
}

// ---------- storage: Firestore when signed in, localStorage otherwise ----------
const cloud = { ready: false, fb: null, auth: null, db: null, unsub: null };
const hasConfig = !!firebaseConfig.apiKey;
function setSync(cls, text) { const p = $('#sync-pill'); p.className = cls; p.textContent = text; }

async function initFirebase() {
  if (!hasConfig) { setSync('local', 'Local only'); return; }
  const V = '10.12.2', base = `https://www.gstatic.com/firebasejs/${V}`;
  const [appM, authM, fsM] = await Promise.all([import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`)]);
  const app = appM.initializeApp(firebaseConfig);
  cloud.fb = { ...authM, ...fsM };
  cloud.auth = authM.getAuth(app);
  // Offline cache: ticks made without signal are queued and sent when back online.
  cloud.db = fsM.initializeFirestore(app, { localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }) });
  cloud.ready = true;
  authM.onAuthStateChanged(cloud.auth, onUser);
}
async function onUser(u) {
  const F = cloud.fb;
  cloud.unsub?.(); cloud.unsub = null; user = u;
  renderAccount();
  if (!u) { progress = ls.get('ppc.progress', {}); setSync('local', 'Not signed in'); refreshAll(); return; }
  const ref = F.doc(cloud.db, 'users', u.uid);
  // First sign-in on this device: carry over anything ticked while signed out.
  const local = ls.get('ppc.progress', {});
  if (Object.keys(local).length) {
    try {
      const snap = await F.getDoc(ref);
      const remote = snap.exists() ? snap.data().progress || {} : {};
      const merged = { ...local, ...remote };
      await F.setDoc(ref, { progress: merged, name: u.displayName || u.email || '', updated: F.serverTimestamp() }, { merge: true });
      ls.set('ppc.progress', {});
      toast(`Moved ${Object.keys(local).length} ticks from this device to your account`);
    } catch (e) { console.error(e); }
  }
  cloud.unsub = F.onSnapshot(ref, { includeMetadataChanges: true }, snap => {
    progress = snap.exists() ? snap.data().progress || {} : {};
    setSync(snap.metadata.hasPendingWrites ? 'pending' : 'ok', snap.metadata.hasPendingWrites ? 'Saving…' : snap.metadata.fromCache ? 'Offline copy' : 'Synced ✓');
    refreshAll();
  }, e => { console.error(e); setSync('err', 'Sync error'); });
}
function saveEntry(id) {
  if (user && cloud.ready) {
    const F = cloud.fb;
    F.setDoc(F.doc(cloud.db, 'users', user.uid), { progress: { [id]: progress[id] }, name: user.displayName || user.email || '', updated: F.serverTimestamp() }, { merge: true })
      .catch(e => { console.error(e); setSync('err', 'Save failed'); });
  } else ls.set('ppc.progress', progress);
}
async function saveAll() {
  if (user && cloud.ready) {
    const F = cloud.fb;
    await F.setDoc(F.doc(cloud.db, 'users', user.uid), { progress, name: user.displayName || user.email || '', updated: F.serverTimestamp() });
  } else ls.set('ppc.progress', progress);
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
  const p = { ...(progress[id] || {}) };
  p.stamped = on; if (on && !p.date) p.date = today();
  progress[id] = p; saveEntry(id);
  refreshAll();
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

// ---------- account ----------
function renderAccount() {
  const btn = $('#account-btn');
  btn.textContent = user ? (user.displayName || user.email || 'Account').split(' ')[0] : 'Sign in';
  const el = $('#tab-account');
  if (!hasConfig) {
    el.innerHTML = `<p class="muted">Accounts aren't set up yet, so ticks are saved in this browser only.</p>${backupHtml()}`;
  } else if (!cloud.ready) {
    el.innerHTML = `<p class="muted">Connecting…</p>${backupHtml()}`;
  } else if (user) {
    el.innerHTML = `<h3>Signed in</h3><p><b>${esc(user.displayName || '')}</b> <span class="muted">${esc(user.email || '')}</span></p>
      <p class="muted small">Your stamps are saved to your account and appear on every device you sign in on. Ticks made offline are sent when you're back online.</p>
      <button class="btn" id="sign-out">Sign out</button>${backupHtml()}`;
    $('#sign-out').onclick = () => cloud.fb.signOut(cloud.auth);
  } else {
    el.innerHTML = `<h3>Sign in to save your progress</h3>
      <p class="muted small">Each person gets their own progress. Anything you tick before signing in is moved into your account.</p>
      <button class="btn primary wide" id="g-in">Continue with Google</button>
      <div class="or">or with email</div>
      <label>Email</label><input type="email" id="em" autocomplete="email">
      <label>Password</label><input type="password" id="pw" autocomplete="current-password">
      <div class="row" style="margin-top:8px"><button class="btn primary" id="e-in">Sign in</button><button class="btn" id="e-up">Create account</button></div>
      <p class="small"><a href="#" id="e-reset">Forgot password?</a></p>${backupHtml()}`;
    const F = cloud.fb, A = cloud.auth, em = () => $('#em').value.trim(), pw = () => $('#pw').value;
    const run = p => p.catch(e => toast(authMsg(e)));
    $('#g-in').onclick = () => run(F.signInWithPopup(A, new F.GoogleAuthProvider()));
    $('#e-in').onclick = () => run(F.signInWithEmailAndPassword(A, em(), pw()));
    $('#e-up').onclick = () => run(F.createUserWithEmailAndPassword(A, em(), pw()));
    $('#e-reset').onclick = e => { e.preventDefault(); if (!em()) return toast('Enter your email first'); run(F.sendPasswordResetEmail(A, em()).then(() => toast('Reset email sent'))); };
  }
  bindBackup();
}
function authMsg(e) {
  const m = { 'auth/invalid-credential': 'Wrong email or password', 'auth/email-already-in-use': 'That email already has an account – sign in instead',
    'auth/weak-password': 'Password needs at least 6 characters', 'auth/invalid-email': 'That email address looks wrong',
    'auth/popup-closed-by-user': 'Sign-in window was closed', 'auth/unauthorized-domain': 'This site address is not authorised in Firebase yet' };
  return m[e.code] || e.message;
}
const backupHtml = () => `<h3>Backup</h3><div class="row"><button class="btn" id="exp">Export CSV</button><button class="btn" id="imp">Import CSV</button></div><input type="file" id="imp-file" accept=".csv" hidden>
  <h3>Legend</h3><p class="small"><span class="pin todo inline">7</span> pending &nbsp; <span class="pin done inline">7</span> stamped &nbsp; <span class="pin extra inline">•</span> not in booklet (unconfirmed)</p>
  <h3>About the data</h3><p class="muted small">Sites 1–100 follow the Karnataka Philately Passport booklet. Post offices were checked against the India Post pincode directory (2017 copy); seal designs and dates come from indianphilatelics.com and indianphilately.net where published. Extras are from the community site philatelypassport.in and are not in the booklet. Pin positions are geocoded with OpenStreetMap, so some are approximate.</p>`;
function bindBackup() {
  $('#exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([progressToCsv()], { type: 'text/csv' })); a.download = `ppc-progress-${today()}.csv`; a.click(); };
  $('#imp').onclick = () => $('#imp-file').click();
  $('#imp-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const imported = csvToProgress(await f.text()); if (!confirm(`Replace your progress with ${Object.keys(imported).length} rows from this file?`)) return; progress = imported; await saveAll(); refreshAll(); toast('Imported'); }
    catch (err) { console.error(err); toast('Could not import that file'); }
  };
}

// ---------- events ----------
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset?.stamp) setStamped(t.dataset.stamp, t.checked);
  for (const [attr, field] of [['data-pdate', 'date'], ['data-pnotes', 'notes']]) {
    const id = t.getAttribute(attr); if (id) { progress[id] = { ...(progress[id] || {}), [field]: t.value }; saveEntry(id); }
  }
});
document.addEventListener('click', e => { const id = e.target.dataset?.fly; if (id) flyTo(id); });
$('#f-hide').addEventListener('change', e => { view.hideStamped = e.target.checked; saveView(); refreshMarkers(); renderList(); });
$('#f-extra').addEventListener('change', e => { view.showExtras = e.target.checked; saveView(); refreshMarkers(); renderList(); });
$('#q').addEventListener('input', e => { view.q = e.target.value; saveView(); renderList(); });
$('#account-btn').addEventListener('click', () => showTab('account'));
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
}
function refreshAll() { refreshMarkers(); renderProgress(); renderFilters(); renderList(); }

// ---------- boot ----------
(async function boot() {
  SITES = await (await fetch('data/sites.json', { cache: 'no-store' })).json();
  progress = ls.get('ppc.progress', {});
  $('#q').value = view.q || '';
  initMap(); refreshAll(); renderAccount();
  try { await initFirebase(); } catch (e) { console.error(e); setSync('err', 'Offline – local only'); }
})();
