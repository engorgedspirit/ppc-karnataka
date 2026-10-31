/* PPC Karnataka — Philately Passport map and stamp tracker.
 * Static data: data/sites.json (booklet 1-100 + unconfirmed extras).
 * Progress: Firestore document users/{uid} when signed in (Firebase Auth), otherwise this browser only.
 * Firebase Hosting serves the project's web config at /__/firebase/init.json; elsewhere (local copy) the site runs local-only. */
const firebaseConfig = await fetch('/__/firebase/init.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
};
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800); };
const today = () => new Date().toISOString().slice(0, 10);
const prettyDate = d => d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const hav = (a, b) => {
  const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const isPhone = () => matchMedia('(max-width: 760px)').matches;
const ICON = {
  stamp: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  route: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h6M18 9v6a4 4 0 0 1-4 4H8"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
};

// ---------- state ----------
let SITES = [], BY_ID = {};
let progress = {};   // siteId -> {stamped, date, notes}
let user = null;     // Firebase user when signed in
let selected = null; // siteId shown in the detail view
let me = null;       // [lat, lon] once location is shared
let view = { show: 'all', showExtras: false, q: '', sort: 'num', ...ls.get('ppc.view2', {}) };
const saveView = () => ls.set('ppc.view2', { show: view.show, showExtras: view.showExtras, sort: view.sort });
const isDone = s => !!progress[s.id]?.stamped;
const visible = s => (s.kind === 'passport' || view.showExtras) &&
  (view.show === 'all' || (view.show === 'stamped') === isDone(s));

// ---------- CSV (backup) ----------
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
let syncState = 'local';
function setSync(cls, text) { syncState = text; const d = $('#sync-dot'); d.className = `sync-dot ${cls}`; d.title = text; renderAccountStatus(); }

async function initFirebase() {
  if (!hasConfig) { setSync('', 'Saved on this device'); return; }
  const base = 'https://www.gstatic.com/firebasejs/10.12.2';
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
  if (!u) { progress = ls.get('ppc.progress', {}); setSync('', 'Not signed in – saved on this device'); refreshAll(); return; }
  const ref = F.doc(cloud.db, 'users', u.uid);
  // First sign-in on this device: carry over anything ticked while signed out.
  const local = ls.get('ppc.progress', {});
  if (Object.keys(local).length) {
    try {
      const snap = await F.getDoc(ref);
      const remote = snap.exists() ? snap.data().progress || {} : {};
      await F.setDoc(ref, { progress: { ...local, ...remote }, name: u.displayName || u.email || '', updated: F.serverTimestamp() }, { merge: true });
      ls.set('ppc.progress', {});
      toast(`Moved ${Object.keys(local).length} stamps from this device to your account`);
    } catch (e) { console.error(e); }
  }
  cloud.unsub = F.onSnapshot(ref, { includeMetadataChanges: true }, snap => {
    progress = snap.exists() ? snap.data().progress || {} : {};
    const m = snap.metadata;
    setSync(m.hasPendingWrites ? 'pending' : 'ok', m.hasPendingWrites ? 'Saving…' : m.fromCache ? 'Offline – changes will sync' : 'All changes saved');
    refreshAll();
  }, e => { console.error(e); setSync('err', 'Could not reach your account'); });
}
function saveEntry(id) {
  if (user && cloud.ready) {
    const F = cloud.fb;
    F.setDoc(F.doc(cloud.db, 'users', user.uid), { progress: { [id]: progress[id] }, name: user.displayName || user.email || '', updated: F.serverTimestamp() }, { merge: true })
      .catch(e => { console.error(e); setSync('err', 'Save failed – check your connection'); });
  } else ls.set('ppc.progress', progress);
}
async function saveAll() {
  if (user && cloud.ready) {
    const F = cloud.fb;
    await F.setDoc(F.doc(cloud.db, 'users', user.uid), { progress, name: user.displayName || user.email || '', updated: F.serverTimestamp() });
  } else ls.set('ppc.progress', progress);
}

// ---------- map ----------
let map, markers = {}, meMarker = null;
function pinClass(s) { return s.kind === 'extra' ? 'extra' : isDone(s) ? 'done' : 'todo'; }
function icon(s) {
  const extra = s.kind === 'extra';
  return L.divIcon({ className: 'pin-wrap', iconSize: extra ? [28, 28] : [28, 28], iconAnchor: [14, 14],
    html: `<i class="pin ${pinClass(s)}${selected === s.id ? ' sel' : ''}">${extra ? '' : s.num}</i>` });
}
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([14.6, 76.2], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  if (!isPhone()) L.control.zoom({ position: 'bottomleft' }).addTo(map);
  // Each entry is its own post office: if two ever share coordinates, fan them out (~40 m) so both dots stay visible.
  const spots = {};
  for (const s of SITES) if (s.lat != null) (spots[`${s.lat.toFixed(4)},${s.lon.toFixed(4)}`] ||= []).push(s);
  for (const group of Object.values(spots)) if (group.length > 1) group.forEach((s, i) => {
    const a = (2 * Math.PI * i) / group.length;
    s.lat += 0.00036 * Math.cos(a); s.lon += 0.00036 * Math.sin(a);
  });
  for (const s of SITES) {
    if (s.lat == null) continue;
    markers[s.id] = L.marker([s.lat, s.lon], { icon: icon(s), riseOnHover: true, keyboard: true, title: `${s.num ? s.num + '. ' : ''}${s.name}` })
      .on('click', () => openDetail(s.id, { pan: false }));
  }
  const fit = SITES.filter(s => s.kind === 'passport' && s.lat != null).map(s => [s.lat, s.lon]);
  map.fitBounds(fit, { paddingTopLeft: [20, 80], paddingBottomRight: isPhone() ? [20, innerHeight * .5] : [400, 20] });
  // Smaller pins when zoomed out to the whole state, so neighbouring sites don't pile up
  const scalePins = () => $('#map').classList.toggle('far', map.getZoom() < 8);
  map.on('zoomend', scalePins); scalePins();
  map.on('click', () => { if (isPhone() && $('#sheet').dataset.view === 'detail') setSize('peek'); });
}
function refreshMarkers() {
  for (const s of SITES) {
    const m = markers[s.id]; if (!m) continue;
    m.setIcon(icon(s));
    m.setZIndexOffset(selected === s.id ? 2000 : s.kind === 'extra' ? -1000 : isDone(s) ? -100 : 0);
    if (visible(s) || selected === s.id) m.addTo(map); else m.remove();
  }
}

// ---------- sheet: list / detail ----------
const sheet = () => $('#sheet');
function setView(v) { sheet().dataset.view = v; }
function setSize(sz) { if (isPhone()) sheet().dataset.size = sz; }
function openSheet() { sheet().classList.remove('closed'); if (isPhone() && sheet().dataset.size === 'peek') setSize('half'); }
function closeSheet() { if (isPhone()) setSize('peek'); else sheet().classList.add('closed'); }

function renderCounts() {
  const pass = SITES.filter(s => s.kind === 'passport');
  const n = pass.filter(isDone).length;
  $('#count').textContent = `${n} of ${pass.length} stamped`;
  $('#ring-fg').setAttribute('stroke-dasharray', `${(n / pass.length) * 100} 100`);
  $('#pill-text').textContent = `Sites · ${pass.length - n} to go`;
  $('#f-extra-count').textContent = `(${SITES.filter(s => s.kind === 'extra').length})`;
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.show === view.show)));
  $('#f-extra').checked = view.showExtras;
  $('#sort').setAttribute('aria-pressed', String(view.sort === 'near' && !!me));
}
function renderList() {
  const q = view.q.trim().toLowerCase();
  let list = SITES.filter(s => visible(s) && (!q || `${s.num ?? ''} ${s.name} ${s.po} ${s.official_po} ${s.district} ${s.pin} ${s.seal}`.toLowerCase().includes(q)));
  const near = view.sort === 'near' && me;
  if (near) list = list.map(s => ({ s, d: s.lat != null ? hav(me, [s.lat, s.lon]) : Infinity })).sort((a, b) => a.d - b.d).map(x => (x.s._d = x.d, x.s));
  const row = s => `<div class="item${selected === s.id ? ' sel' : ''}" data-open="${s.id}" role="button" tabindex="0">
      <i class="pin ${pinClass(s)}">${s.num ?? ''}</i>
      <div><div class="name">${esc(s.name)}</div><div class="sub">${esc(s.po)}, ${esc(s.district)}${isDone(s) ? ` · stamped ${esc(prettyDate(progress[s.id].date))}` : ''}</div></div>
      ${near && isFinite(s._d) ? `<span class="dist">${fmtKm(s._d)}</span>` : '<span></span>'}
    </div>`;
  let html;
  if (near) html = list.map(row).join('');
  else {
    const pass = list.filter(s => s.kind === 'passport'), ext = list.filter(s => s.kind === 'extra');
    html = pass.map(row).join('') + (ext.length ? `<div class="group-label">Not in the booklet (unconfirmed)</div>` + ext.map(row).join('') : '');
  }
  const empty = view.show === 'stamped' ? 'No stamps yet. Open a site and tap “Mark as stamped” after your visit.'
    : view.show === 'pending' ? 'Every site is stamped. Well done!' : 'No sites match your search.';
  $('#list').innerHTML = html || `<p class="list-empty">${q ? 'No sites match your search.' : empty}</p>`;
}

function sealSvg(s) {
  const p = progress[s.id] || {}, done = !!p.stamped;
  const top = (s.name || '').toUpperCase().slice(0, 34);
  const bottom = `${(s.po || '').replace(/\s*(head |sub |branch )?post office$/i, '').toUpperCase()} · ${s.pin}`.slice(0, 38);
  const middle = done ? prettyDate(p.date).toUpperCase() : 'KARNATAKA';
  return `<svg class="seal${done ? ' done' : ''}" id="seal" viewBox="0 0 200 200" role="img" aria-label="${done ? 'Stamped' : 'Not stamped yet'}">
    <defs>
      <path id="arc-top" d="M 30 100 A 70 70 0 0 1 170 100"/>
      <path id="arc-bot" d="M 26 100 A 74 74 0 0 0 174 100"/>
    </defs>
    <circle class="outer" cx="100" cy="100" r="94" stroke-width="3"/>
    <circle cx="100" cy="100" r="86" stroke-width="1.2"/>
    <circle cx="100" cy="100" r="50" stroke-width="1.5"/>
    <text class="arc"><textPath href="#arc-top" startOffset="50%" text-anchor="middle">${esc(top)}</textPath></text>
    <text class="arc"><textPath href="#arc-bot" startOffset="50%" text-anchor="middle">${esc(bottom)}</textPath></text>
    <text class="big" x="100" y="108" text-anchor="middle">${s.num ?? '•'}</text>
    <text class="mid" x="100" y="128" text-anchor="middle">${esc(middle)}</text>
  </svg>`;
}
function renderDetail() {
  const s = BY_ID[selected]; if (!s) return;
  const p = progress[s.id] || {}, done = !!p.stamped;
  const pass = SITES.filter(x => x.kind === 'passport');
  const i = pass.indexOf(s);
  const prev = i > 0 ? pass[i - 1] : null, next = i >= 0 && i < pass.length - 1 ? pass[i + 1] : null;
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
  const poSearch = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.official_po || s.po} ${s.pin}`)}`;
  const approx = /check|PIN area|landmark|approx/.test(s.loc || '');
  const fact = (k, v) => v ? `<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>` : '';
  $('#detail').innerHTML = `
    <div class="detail-top">
      <button class="btn ghost" data-act="back">${ICON.back}All sites</button>
      ${s.num ? `<div class="detail-nav">
        <button class="icon-btn" data-goto="${prev?.id || ''}" ${prev ? '' : 'disabled'} aria-label="Previous site">${ICON.prev}</button>
        <button class="icon-btn" data-goto="${next?.id || ''}" ${next ? '' : 'disabled'} aria-label="Next site">${ICON.next}</button>
      </div>` : ''}
    </div>
    <div class="seal-wrap">${sealSvg(s)}</div>
    <div class="detail-body">
      <div class="detail-title">
        <h2>${esc(s.name)}</h2>
        <div class="muted">${esc(s.district)} district${s.num ? ` · booklet no. ${s.num}` : ''}</div>
        ${distTo(s) != null ? `<span class="tag">${fmtKm(distTo(s))} from you</span>` : ''}
        ${s.kind === 'extra' ? '<span class="tag">Not in the booklet – unconfirmed</span>' : ''}
      </div>
      <button class="stamp-btn${done ? ' done' : ''}" data-act="stamp">${ICON.stamp}${done ? `Stamped on ${esc(prettyDate(p.date))}` : 'Mark as stamped'}</button>
      ${done ? `<div class="stamp-meta">
        <input type="date" data-f="date" value="${esc(p.date || '')}" aria-label="Date stamped">
        <input data-f="notes" value="${esc(p.notes || '')}" placeholder="Add a note" aria-label="Note">
      </div>` : ''}
      <dl class="facts">
        ${fact('Seal', s.seal ? `${esc(s.seal)}${s.seal_date ? `<br><span class="muted">Introduced ${esc(s.seal_date)}</span>` : ''}` : '<span class="muted">Design not published – see your booklet</span>')}
        ${fact('Post office', `${esc(s.po)}${s.official_po && s.official_po.toLowerCase() !== s.po.toLowerCase() ? `<br><span class="muted">India Post name: ${esc(s.official_po)}</span>` : ''}${s.ho ? `<br><span class="muted">Under ${esc(s.ho)}</span>` : ''}`)}
        ${fact('PIN', `${esc(s.pin)}${s.pin_alt ? `<br><span class="muted">Also listed as ${esc(s.pin_alt)}</span>` : ''}`)}
        ${fact('Phone', s.phone ? `<a href="tel:${esc(s.phone.replace(/[^0-9+]/g, ''))}">${esc(s.phone)}</a>` : '')}
      </dl>
      <div class="actions">
        <a class="btn primary" target="_blank" rel="noopener" href="${dir}">${ICON.route}Directions</a>
        <a class="btn" target="_blank" rel="noopener" href="${poSearch}">${ICON.pin}Find post office</a>
      </div>
      ${approx ? `<p class="note">The map pin is approximate. Use “Find post office” to check the exact location.</p>` : ''}
      ${s.url ? `<p class="small"><a class="muted" target="_blank" rel="noopener" href="${esc(s.url)}">Community page for this site</a></p>` : ''}
    </div>`;
}
function openDetail(id, { pan = true } = {}) {
  const s = BY_ID[id]; if (!s) return;
  selected = id;
  setView('detail'); openSheet(); if (isPhone()) setSize('half');
  renderDetail(); refreshMarkers(); renderList();
  $('#detail').scrollTop = 0;
  if (pan && s.lat != null) {
    const off = isPhone() ? [0, innerHeight * .22] : [-(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sheet-w')) || 380) / 2, 0];
    const pt = map.project([s.lat, s.lon], Math.max(map.getZoom(), 10)).add(L.point(-off[0], off[1]));
    map.flyTo(map.unproject(pt, Math.max(map.getZoom(), 10)), Math.max(map.getZoom(), 10), { duration: .6 });
  }
}
function backToList() { selected = null; setView('list'); refreshMarkers(); renderList(); }

// ---------- stamping ----------
function setStamped(id, on) {
  const p = { ...(progress[id] || {}) };
  p.stamped = on; if (on && !p.date) p.date = today();
  progress[id] = p; saveEntry(id);
  refreshAll();
  if (on) { const seal = $('#seal'); seal?.classList.add('press'); toast(`Stamped: ${BY_ID[id].name}`); }
}

// ---------- account (in the menu) ----------
function renderAccountStatus() { const el = $('#acct-status'); if (el) el.textContent = syncState; }
function renderAccount() {
  const el = $('#account');
  if (!hasConfig) {
    el.innerHTML = `<h3>Your progress</h3><p class="muted small">Stamps are saved in this browser. Accounts are available on the published site.</p>`;
    return;
  }
  if (!cloud.ready) { el.innerHTML = `<p class="muted small">Connecting…</p>`; return; }
  if (user) {
    const name = user.displayName || user.email || 'You';
    el.innerHTML = `<div class="account-card">
        <div class="avatar">${user.photoURL ? `<img src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(name[0].toUpperCase())}</div>
        <div><b>${esc(name)}</b><div class="muted small">${esc(user.email || '')}</div></div>
      </div>
      <p class="small muted" id="acct-status">${esc(syncState)}</p>
      <button class="btn" id="sign-out">Sign out</button>`;
    $('#sign-out').onclick = () => cloud.fb.signOut(cloud.auth).then(() => toast('Signed out'));
    return;
  }
  el.innerHTML = `<h3>Sign in to save your stamps</h3>
    <p class="muted small">Your stamps follow you to every device, and friends keep their own. Stamps you've marked on this device move into your account.</p>
    <button class="btn primary" id="g-in" style="width:100%">Continue with Google</button>
    <div class="or">or with email</div>
    <label class="field">Email<input type="email" id="em" autocomplete="email"></label>
    <label class="field">Password<input type="password" id="pw" autocomplete="current-password"></label>
    <div class="btn-row" style="margin-top:12px"><button class="btn primary" id="e-in">Sign in</button><button class="btn" id="e-up">Create account</button></div>
    <p style="margin:10px 0 0"><button class="link-btn" id="e-reset">Forgot password?</button></p>`;
  const F = cloud.fb, A = cloud.auth, em = () => $('#em').value.trim(), pw = () => $('#pw').value;
  const run = p => p.then(() => closeDrawer()).catch(e => toast(authMsg(e)));
  $('#g-in').onclick = () => run(F.signInWithPopup(A, new F.GoogleAuthProvider()));
  $('#e-in').onclick = () => run(F.signInWithEmailAndPassword(A, em(), pw()));
  $('#e-up').onclick = () => run(F.createUserWithEmailAndPassword(A, em(), pw()));
  $('#e-reset').onclick = () => { if (!em()) return toast('Enter your email first'); F.sendPasswordResetEmail(A, em()).then(() => toast('Password reset email sent')).catch(e => toast(authMsg(e))); };
}
function authMsg(e) {
  const m = { 'auth/invalid-credential': 'Wrong email or password', 'auth/email-already-in-use': 'That email already has an account. Sign in instead.',
    'auth/weak-password': 'Use a password with at least 6 characters', 'auth/invalid-email': 'Check the email address',
    'auth/popup-closed-by-user': 'Sign-in window was closed', 'auth/popup-blocked': 'Allow pop-ups for this site to sign in with Google',
    'auth/unauthorized-domain': 'This address is not allowed to sign in yet (Firebase authorised domains)' };
  return m[e.code] || e.message;
}
function openDrawer() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#scrim').hidden = false; $('#menu-btn').setAttribute('aria-expanded', 'true'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#scrim').hidden = true; $('#menu-btn').setAttribute('aria-expanded', 'false'); }

// ---------- location ----------
// Live position: blue dot + accuracy circle, kept up to date while the page is open.
let watchId = null, meCircle = null, firstFixWaiters = [];
const distTo = s => me && s.lat != null ? hav(me, [s.lat, s.lon]) : null;
const fmtKm = d => d < 1 ? `${Math.round(d * 1000)} m` : d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`;
function startTracking(onFix) {
  if (!navigator.geolocation) return toast('Location is not available in this browser');
  if (onFix) firstFixWaiters.push(onFix);
  if (watchId != null) { if (me) firstFixWaiters.splice(0).forEach(f => f()); return; }
  $('#locate').classList.add('busy');
  watchId = navigator.geolocation.watchPosition(pos => {
    const first = !me;
    me = [pos.coords.latitude, pos.coords.longitude];
    const acc = Math.min(pos.coords.accuracy || 0, 2000);
    if (!meMarker) {
      meCircle = L.circle(me, { radius: acc, className: 'me-acc', interactive: false }).addTo(map);
      meMarker = L.marker(me, { icon: L.divIcon({ className: '', iconSize: [18, 18], html: '<div class="me-dot"></div>' }), interactive: false, zIndexOffset: 3000 }).addTo(map);
    } else { meMarker.setLatLng(me); meCircle.setLatLng(me).setRadius(acc); }
    $('#locate').classList.remove('busy'); $('#locate').classList.add('active');
    if (first) { renderList(); if (selected) renderDetail(); }
    firstFixWaiters.splice(0).forEach(f => f());
  }, err => {
    $('#locate').classList.remove('busy');
    navigator.geolocation.clearWatch(watchId); watchId = null; firstFixWaiters = [];
    toast(err.code === 1 ? 'Location is blocked. Allow it for this site in your browser settings.' : 'Could not find your location. Try again outdoors.');
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}
// "Near me": show where you are with the closest pending sites around you, and sort the list by distance.
function nearMe() {
  startTracking(() => {
    const pending = SITES.filter(s => s.kind === 'passport' && !isDone(s) && s.lat != null)
      .sort((a, b) => distTo(a) - distTo(b)).slice(0, 4);
    const pts = [me, ...pending.map(s => [s.lat, s.lon])];
    map.flyToBounds(pts, { paddingTopLeft: [40, 90], paddingBottomRight: isPhone() ? [40, innerHeight * .55] : [420, 40], maxZoom: 13, duration: .8 });
    view.sort = 'near'; saveView();
    if (selected) backToList();
    openSheet(); refreshAll();
    if (pending[0]) toast(`Closest pending: ${pending[0].num}. ${pending[0].name}, ${fmtKm(distTo(pending[0]))} away`);
  });
}


// ---------- events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-open],[data-act],[data-goto],[data-show]'); if (!t) return;
  if (t.dataset.open) openDetail(t.dataset.open);
  else if (t.dataset.goto) openDetail(t.dataset.goto);
  else if (t.dataset.show) { view.show = t.dataset.show; saveView(); refreshAll(); }
  else if (t.dataset.act === 'back') backToList();
  else if (t.dataset.act === 'stamp') setStamped(selected, !isDone(BY_ID[selected]));
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.open) { e.preventDefault(); openDetail(e.target.dataset.open); }
  if (e.key === 'Escape') { if ($('#drawer').classList.contains('open')) closeDrawer(); else if (selected) backToList(); }
});
document.addEventListener('change', e => {
  const f = e.target.dataset?.f; if (!f || !selected) return;
  progress[selected] = { ...(progress[selected] || {}), [f]: e.target.value }; saveEntry(selected);
  if (f === 'date') renderDetail();
});
$('#f-extra').addEventListener('change', e => { view.showExtras = e.target.checked; saveView(); refreshAll(); });
$('#q').addEventListener('input', e => { view.q = e.target.value; renderList(); });
$('#sort').addEventListener('click', () => {
  if (view.sort === 'near') { view.sort = 'num'; saveView(); refreshAll(); return; }
  startTracking(() => { view.sort = 'near'; saveView(); refreshAll(); });
});
$('#locate').addEventListener('click', nearMe);
$('#collapse').addEventListener('click', closeSheet);
$('#sheet-open').addEventListener('click', () => { openSheet(); });
$('#grab').addEventListener('click', () => { const s = sheet().dataset.size; setSize(s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek'); });
$('#menu-btn').addEventListener('click', openDrawer);
$('#drawer-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#exp').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([progressToCsv()], { type: 'text/csv' })); a.download = `ppc-stamps-${today()}.csv`; a.click(); });
$('#imp').addEventListener('click', () => $('#imp-file').click());
$('#imp-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const imported = csvToProgress(await f.text());
    if (!confirm(`Replace your stamps with the ${Object.keys(imported).length} rows in this file?`)) return;
    progress = imported; await saveAll(); refreshAll(); toast('Stamps loaded from file');
  } catch (err) { console.error(err); toast('That file could not be read. Use a CSV downloaded from this site.'); }
  e.target.value = '';
});
// Swipe the phone sheet handle up/down
(() => {
  let y0 = null;
  $('#grab').addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
  $('#grab').addEventListener('touchend', e => {
    if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (Math.abs(dy) < 30) return;
    const order = ['peek', 'half', 'full'], i = order.indexOf(sheet().dataset.size);
    setSize(order[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]);
  });
})();
function refreshAll() { refreshMarkers(); renderCounts(); renderList(); if (selected) renderDetail(); }

// ---------- boot ----------
(async function boot() {
  SITES = await (await fetch('data/sites.json', { cache: 'no-store' })).json();
  BY_ID = Object.fromEntries(SITES.map(s => [s.id, s]));
  progress = ls.get('ppc.progress', {});
  initMap(); refreshAll(); renderAccount();
  // Resume the location dot automatically if this site was already allowed to use location.
  navigator.permissions?.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') startTracking(); }).catch(() => {});
  try { await initFirebase(); } catch (e) { console.error(e); setSync('err', 'Offline – saved on this device'); }
})();
