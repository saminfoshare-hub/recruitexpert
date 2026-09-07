/* ==========================================================================
   RECRUIT EXPERT — App Logic
   ========================================================================== */
const CFG = window.APP_CONFIG || {};
const backendReady = !!(CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('YOUR-PROJECT') === -1 && window.supabase);
const sb = backendReady ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

const root = document.getElementById('root');
let currentUser = null;
let currentEntityKey = 'dashboard';
let searchTerm = '';
let cache = {};       // table -> rows (raw)
let refCache = {};    // table -> {id: displayLabel} for FK dropdowns/labels

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}
function toast(msg) {
  const t = el('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function entityByKey(key) { return window.ENTITIES.find(e => e.key === key); }

/* ---------------- AUTH ---------------- */
async function checkSession() {
  if (!sb) { renderNoBackend(); return; }
  const { data } = await sb.auth.getSession();
  if (data.session) { currentUser = data.session.user; await boot(); }
  else { renderLogin(); }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { currentUser = null; renderLogin(); }
  });
}

function renderNoBackend() {
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'login-screen' }, el('div', { class: 'login-box' }, [
    el('h1', {}, 'Not connected'),
    el('p', { class: 'sub' }, 'Edit config.js with your Supabase project URL and anon key, then reload this page.'),
  ])));
}

function renderLogin() {
  root.innerHTML = '';
  const emailInp = el('input', { type: 'email', autocomplete: 'off' });
  const passInp = el('input', { type: 'password', autocomplete: 'off' });
  const errBox = el('div', { class: 'login-err' }, '');
  const btn = el('button', {}, 'Log In');

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.textContent = '';
      btn.disabled = true; btn.textContent = 'Signing in…';
      const { data, error } = await sb.auth.signInWithPassword({ email: emailInp.value, password: passInp.value });
      btn.disabled = false; btn.textContent = 'Log In';
      if (error) { errBox.textContent = 'Incorrect email or password.'; return; }
      currentUser = data.user;
      await boot();
    }
  }, [
    el('label', {}, 'Email'), emailInp,
    el('label', {}, 'Password'), passInp,
    errBox, btn,
  ]);

  root.appendChild(el('div', { class: 'login-screen' }, el('div', { class: 'login-box' }, [
    el('div', { class: 'login-logo' }, 'RE'),
    el('h1', {}, CFG.APP_NAME || 'Recruit Expert'),
    el('p', { class: 'sub' }, 'Sign in with your staff account to continue.'),
    form,
  ])));
}

async function logout() {
  if (sb) await sb.auth.signOut();
}

/* ---------------- BOOT / SHELL ---------------- */
async function boot() {
  currentEntityKey = 'dashboard';
  await preloadRefCaches();
  renderShell();
  await showDashboard();
}

// Preload small lookup tables used for FK dropdown labels across the whole app
async function preloadRefCaches() {
  const refTables = new Set();
  window.ENTITIES.forEach(ent => ent.fields.forEach(f => { if (f.type === 'select') refTables.add(f.ref); }));
  await Promise.all([...refTables].map(async (key) => {
    const ent = entityByKey(key);
    if (!ent) return;
    const { data, error } = await sb.from(ent.table).select('*');
    if (error) { console.warn('preload', ent.table, error.message); return; }
    cache[ent.table] = data || [];
    refCache[ent.table] = {};
    (data || []).forEach(row => { refCache[ent.table][row[ent.pk]] = row[ent.displayField] ?? `#${row[ent.pk]}`; });
  }));
}

function renderShell() {
  root.innerHTML = '';
  const groups = ['Core', 'Finance'];
  const sidebar = el('div', { class: 'sidebar', id: 'sidebar' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('div', { class: 'mark' }, 'RE'),
      el('div', { class: 'txt' }, CFG.APP_NAME || 'Recruit Expert'),
    ]),
    el('div', { class: 'sidebar-item', 'data-key': 'dashboard', onclick: () => selectEntity('dashboard') }, [
      el('i', { class: 'fa-solid fa-gauge' }), 'Dashboard',
    ]),
    ...groups.flatMap(g => [
      el('div', { class: 'sidebar-group-label' }, g),
      ...window.ENTITIES.filter(e => e.group === g).map(e =>
        el('div', { class: 'sidebar-item', 'data-key': e.key, onclick: () => selectEntity(e.key) }, [
          el('i', { class: `fa-solid ${e.icon}` }), e.label,
        ])
      ),
    ]),
    el('div', { class: 'sidebar-footer' }, [
      el('button', { onclick: logout }, [el('i', { class: 'fa-solid fa-right-from-bracket' }), ' Log Out']),
    ]),
  ]);

  const topbar = el('div', { class: 'topbar' }, [
    el('h2', { id: 'pageTitle' }, 'Dashboard'),
    el('div', { class: 'who' }, currentUser ? currentUser.email : ''),
  ]);
  const content = el('div', { class: 'content', id: 'content' }, []);
  const main = el('div', { class: 'main' }, [topbar, content]);

  root.appendChild(el('div', { class: 'app-shell' }, [sidebar, main]));
}

function setActiveSidebar(key) {
  document.querySelectorAll('.sidebar-item').forEach(n => n.classList.toggle('active', n.getAttribute('data-key') === key));
}

async function selectEntity(key) {
  currentEntityKey = key;
  searchTerm = '';
  setActiveSidebar(key);
  if (key === 'dashboard') { await showDashboard(); return; }
  const ent = entityByKey(key);
  document.getElementById('pageTitle').textContent = ent.label;
  await showEntityList(ent);
}

/* ---------------- DASHBOARD ---------------- */
async function showDashboard() {
  document.getElementById('pageTitle').textContent = 'Dashboard';
  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(el('div', { class: 'loading-state' }, 'Loading dashboard…'));

  const cards = await Promise.all(window.DASHBOARD_CARDS.map(async ([key, label, isMoney, sumField]) => {
    const ent = entityByKey(key);
    const { data, error } = await sb.from(ent.table).select(isMoney ? sumField : ent.pk);
    if (error) return { label, value: '—', isMoney };
    if (isMoney) {
      const total = (data || []).reduce((s, r) => s + (Number(r[sumField]) || 0), 0);
      return { label, value: fmtMoney(total), isMoney };
    }
    return { label, value: (data || []).length, isMoney };
  }));

  content.innerHTML = '';
  content.appendChild(el('div', { class: 'stat-grid' }, cards.map(c =>
    el('div', { class: `stat-card ${c.isMoney ? 'money' : ''}` }, [
      el('div', { class: 'label' }, c.label),
      el('div', { class: 'value' }, String(c.value)),
    ])
  )));

  content.appendChild(el('div', { class: 'dash-section-title' }, 'Quick Access'));
  content.appendChild(el('div', { class: 'stat-grid' }, window.ENTITIES.map(ent =>
    el('div', { class: 'stat-card', style: 'cursor:pointer', onclick: () => selectEntity(ent.key) }, [
      el('div', { class: 'label' }, [el('i', { class: `fa-solid ${ent.icon}` }), ' ' + ent.group]),
      el('div', { class: 'value', style: 'font-size:1rem' }, ent.label),
    ])
  )));
}

/* ---------------- ENTITY LIST (generic table + search + CRUD) ---------------- */
async function showEntityList(ent) {
  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(el('div', { class: 'loading-state' }, 'Loading…'));

  const { data, error } = await sb.from(ent.table).select('*').order(ent.pk, { ascending: false });
  if (error) {
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'empty-state' }, `Could not load ${ent.label}: ${error.message}`));
    return;
  }
  cache[ent.table] = data || [];
  refCache[ent.table] = {};
  (data || []).forEach(row => { refCache[ent.table][row[ent.pk]] = row[ent.displayField] ?? `#${row[ent.pk]}`; });

  renderEntityList(ent);
}

function renderEntityList(ent) {
  const content = document.getElementById('content');
  content.innerHTML = '';

  const searchInput = el('input', {
    type: 'text', placeholder: `Search ${ent.label.toLowerCase()}…`, value: searchTerm,
    oninput: (e) => { searchTerm = e.target.value; renderEntityList(ent); },
  });
  const toolbar = el('div', { class: 'toolbar' }, [
    el('div', { class: 'search-box' }, [el('i', { class: 'fa-solid fa-magnifying-glass' }), searchInput]),
    el('div', { style: 'display:flex;gap:8px;' }, [
      el('button', { class: 'btn btn-outline', onclick: () => exportCsv(ent) }, [el('i', { class: 'fa-solid fa-download' }), ' Export Report (CSV)']),
      el('button', { class: 'btn btn-primary', onclick: () => openForm(ent, null) }, [el('i', { class: 'fa-solid fa-plus' }), ` Add ${ent.label.replace(/s$/, '')}`]),
    ]),
  ]);
  content.appendChild(toolbar);

  const rows = filteredRows(ent);
  if (!rows.length) {
    content.appendChild(el('div', { class: 'data-card' }, el('div', { class: 'empty-state' }, `No ${ent.label.toLowerCase()} found.`)));
    return;
  }

  const visibleFields = ent.fields.slice(0, 6); // keep table readable; full record shown in edit modal
  const thead = el('thead', {}, el('tr', {}, [
    ...visibleFields.map(f => el('th', {}, f.label)),
    el('th', {}, 'Actions'),
  ]));
  const tbody = el('tbody', {}, rows.map(row => el('tr', {}, [
    ...visibleFields.map(f => el('td', {}, formatCell(f, row[f.name]))),
    el('td', {}, el('div', { class: 'row-actions' }, [
      el('button', { class: 'btn btn-outline btn-sm', onclick: () => openForm(ent, row) }, 'Edit'),
      el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteRow(ent, row) }, 'Delete'),
    ])),
  ])));

  content.appendChild(el('div', { class: 'data-card' }, el('table', { class: 'data-table' }, [thead, tbody])));
}

function formatCell(field, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'select') {
    const refEnt = entityByKey(field.ref);
    return (refCache[refEnt.table] && refCache[refEnt.table][value]) || `#${value}`;
  }
  if (field.type === 'number') return fmtMoney(value);
  return String(value);
}

function filteredRows(ent) {
  const rows = cache[ent.table] || [];
  if (!searchTerm.trim()) return rows;
  const q = searchTerm.toLowerCase();
  return rows.filter(row =>
    ent.fields.some(f => {
      const v = row[f.name];
      if (v === null || v === undefined) return false;
      if (f.type === 'select') {
        const refEnt = entityByKey(f.ref);
        const label = (refCache[refEnt.table] && refCache[refEnt.table][v]) || '';
        return label.toLowerCase().includes(q);
      }
      return String(v).toLowerCase().includes(q);
    })
  );
}

/* ---------------- FORM MODAL (Add / Edit) ---------------- */
async function openForm(ent, existingRow) {
  // make sure dropdown ref data is fresh
  await preloadRefCaches();

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const inputs = {};

  const fieldNodes = ent.fields.map(f => {
    let inputEl;
    const val = existingRow ? existingRow[f.name] : '';
    if (f.type === 'textarea') {
      inputEl = el('textarea', {}, '');
      inputEl.value = val ?? '';
    } else if (f.type === 'select') {
      const refEnt = entityByKey(f.ref);
      const options = [el('option', { value: '' }, '— none —')];
      (cache[refEnt.table] || []).forEach(r => {
        options.push(el('option', { value: r[refEnt.pk] }, `${r[refEnt.displayField] ?? ('#' + r[refEnt.pk])}`));
      });
      inputEl = el('select', {}, options);
      inputEl.value = val ?? '';
    } else {
      inputEl = el('input', { type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text' });
      if (f.type === 'number') inputEl.step = 'any';
      inputEl.value = val ?? '';
    }
    inputs[f.name] = inputEl;
    const wrapClass = (f.type === 'textarea') ? 'f-field full' : 'f-field';
    return el('div', { class: wrapClass }, [
      el('label', {}, f.label + (f.required ? ' *' : '')),
      inputEl,
    ]);
  });

  const errBox = el('div', { class: 'login-err' }, '');
  const saveBtn = el('button', { class: 'btn btn-primary' }, existingRow ? 'Save Changes' : 'Add ' + ent.label.replace(/s$/, ''));

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.textContent = '';
      const payload = {};
      let valid = true;
      ent.fields.forEach(f => {
        let v = inputs[f.name].value;
        if (f.type === 'number') v = v === '' ? null : Number(v);
        else if (f.type === 'select') v = v === '' ? null : Number(v);
        else v = v === '' ? null : v;
        if (f.required && (v === null || v === '')) valid = false;
        payload[f.name] = v;
      });
      if (!valid) { errBox.textContent = 'Please fill all required fields.'; return; }

      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      let result;
      if (existingRow) result = await sb.from(ent.table).update(payload).eq(ent.pk, existingRow[ent.pk]);
      else result = await sb.from(ent.table).insert(payload);
      saveBtn.disabled = false; saveBtn.textContent = existingRow ? 'Save Changes' : 'Add ' + ent.label.replace(/s$/, '');

      if (result.error) { errBox.textContent = result.error.message; return; }
      overlay.remove();
      toast(existingRow ? 'Updated successfully.' : 'Added successfully.');
      await showEntityList(ent);
    },
  }, [
    el('div', { class: 'form-grid' }, fieldNodes),
    errBox,
    el('div', { class: 'modal-actions' }, [
      el('button', { type: 'button', class: 'btn btn-outline', onclick: () => overlay.remove() }, 'Cancel'),
      saveBtn,
    ]),
  ]);

  const box = el('div', { class: 'modal-box' }, [
    el('button', { class: 'modal-close', onclick: () => overlay.remove() }, '✕'),
    el('h3', {}, existingRow ? `Edit ${ent.label.replace(/s$/, '')}` : `Add ${ent.label.replace(/s$/, '')}`),
    form,
  ]);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

async function deleteRow(ent, row) {
  if (!confirm(`Delete this ${ent.label.toLowerCase().replace(/s$/, '')} record? This cannot be undone.`)) return;
  const { error } = await sb.from(ent.table).delete().eq(ent.pk, row[ent.pk]);
  if (error) { toast('Delete failed: ' + error.message); return; }
  toast('Deleted.');
  await showEntityList(ent);
}

/* ---------------- CSV EXPORT (Reports) ---------------- */
function exportCsv(ent) {
  const rows = filteredRows(ent);
  if (!rows.length) { toast('Nothing to export.'); return; }
  const headers = ent.fields.map(f => f.label);
  const lines = [headers.join(',')];
  rows.forEach(row => {
    const line = ent.fields.map(f => {
      let v = formatCell(f, row[f.name]);
      v = String(v).replace(/"/g, '""');
      return `"${v}"`;
    });
    lines.push(line.join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${ent.table}-report.csv`; a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- INIT ---------------- */
checkSession();
