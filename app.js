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
let currentPage = 1;
const PAGE_SIZE = 100;
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

// Supabase/PostgREST caps select('*') at 1000 rows by default (or your
// project's own "Max Rows" API setting, if lower). This fetches in pages,
// advancing by however many rows actually came back — not by the requested
// page size — so it works correctly even if a page is capped shorter than
// requested. It only stops once a page comes back genuinely empty.
async function fetchAllRows(table, orderCol) {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  let guard = 0;
  while (guard++ < 200) { // safety cap: 200 pages is 200k+ rows, far beyond any table here
    let query = sb.from(table).select('*');
    if (orderCol) query = query.order(orderCol, { ascending: false });
    query = query.range(from, from + pageSize - 1);
    const { data, error } = await query;
    if (error) return { data: null, error };
    if (!data || data.length === 0) break;
    all = all.concat(data);
    from += data.length;
  }
  return { data: all, error: null };
}

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
    const { data, error } = await fetchAllRows(ent.table);
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
  currentPage = 1;
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
    if (isMoney) {
      // Sums need every row's amount, so page through with fetchAllRows.
      const { data, error } = await fetchAllRows(ent.table);
      if (error) return { label, value: '—', isMoney };
      const total = (data || []).reduce((s, r) => s + (Number(r[sumField]) || 0), 0);
      return { label, value: fmtMoney(total), isMoney };
    }
    // Exact row count via head request — no 1000-row cap, no row data transferred.
    const { count, error } = await sb.from(ent.table).select(ent.pk, { count: 'exact', head: true });
    if (error) return { label, value: '—', isMoney };
    return { label, value: count ?? 0, isMoney };
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

  const { data, error } = await fetchAllRows(ent.table, ent.pk);
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
    oninput: (e) => { searchTerm = e.target.value; currentPage = 1; renderEntityList(ent); },
  });
  const toolbar = el('div', { class: 'toolbar' }, [
    el('div', { class: 'search-box' }, [el('i', { class: 'fa-solid fa-magnifying-glass' }), searchInput]),
    el('div', { style: 'display:flex;gap:8px;' }, [
      el('button', { class: 'btn btn-outline', onclick: () => exportCsv(ent) }, [el('i', { class: 'fa-solid fa-download' }), ' Export Report (CSV)']),
      el('button', { class: 'btn btn-primary', onclick: () => openForm(ent, null) }, [el('i', { class: 'fa-solid fa-plus' }), ` Add ${ent.label.replace(/s$/, '')}`]),
    ]),
  ]);
  content.appendChild(toolbar);

  // rows are already newest-first (fetched ordered by primary key, descending)
  const rows = filteredRows(ent);
  if (!rows.length) {
    content.appendChild(el('div', { class: 'data-card' }, el('div', { class: 'empty-state' }, `No ${ent.label.toLowerCase()} found.`)));
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const goToPage = (p) => { currentPage = p; renderEntityList(ent); };
  content.appendChild(buildPaginationBar(rows.length, currentPage, totalPages, goToPage));

  const visibleFields = ent.fields; // show every column, matching the Supabase table exactly
  const thead = el('thead', {}, el('tr', {}, [
    ...visibleFields.map(f => el('th', {}, f.label)),
    el('th', {}, 'Actions'),
  ]));
  const tbody = el('tbody', {}, pageRows.map(row => el('tr', {}, [
    ...visibleFields.map(f => el('td', {}, formatCell(f, row[f.name]))),
    el('td', {}, el('div', { class: 'row-actions' }, [
      el('button', { class: 'btn btn-outline btn-sm', onclick: () => openForm(ent, row) }, 'Edit'),
      el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteRow(ent, row) }, 'Delete'),
    ])),
  ])));
  const table = el('table', { class: 'data-table' }, [thead, tbody]);

  // Two synced horizontal scrollbars: a thin one above the table (so you don't
  // have to scroll all the way down to shift the view sideways) and the
  // table's own scrollbar below. Dragging either one moves both together.
  const topScrollInner = el('div', { style: 'height:1px;' });
  const topScrollBar = el('div', { class: 'top-scrollbar', style: 'overflow-x:auto;overflow-y:hidden;margin-bottom:6px;' }, topScrollInner);
  const tableWrap = el('div', { class: 'data-card', style: 'overflow-x:auto;' }, table);

  let syncingScroll = false;
  topScrollBar.addEventListener('scroll', () => {
    if (syncingScroll) return;
    syncingScroll = true; tableWrap.scrollLeft = topScrollBar.scrollLeft; syncingScroll = false;
  });
  tableWrap.addEventListener('scroll', () => {
    if (syncingScroll) return;
    syncingScroll = true; topScrollBar.scrollLeft = tableWrap.scrollLeft; syncingScroll = false;
  });

  content.appendChild(topScrollBar);
  content.appendChild(tableWrap);
  // Match the shim's width to the real table's rendered width once it's laid out.
  requestAnimationFrame(() => { topScrollInner.style.width = table.scrollWidth + 'px'; });
}

// Page-number bar shown above the top scrollbar: "‹ Prev  1 2 3 … Next ›"
function buildPaginationBar(totalRows, current, totalPages, onPageChange) {
  const info = el('div', { class: 'page-info' }, `${totalRows} records — page ${current} of ${totalPages}`);
  if (totalPages <= 1) return el('div', { class: 'pagination-bar' }, [info]);

  const prevBtn = el('button', { class: 'btn btn-outline btn-sm', onclick: () => current > 1 && onPageChange(current - 1) }, '‹ Prev');
  prevBtn.disabled = current === 1;
  const nextBtn = el('button', { class: 'btn btn-outline btn-sm', onclick: () => current < totalPages && onPageChange(current + 1) }, 'Next ›');
  nextBtn.disabled = current === totalPages;

  const windowSize = 7;
  let start = Math.max(1, current - Math.floor(windowSize / 2));
  let end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);

  const pageBtns = [];
  if (start > 1) { pageBtns.push(pageBtn(1, current, onPageChange)); if (start > 2) pageBtns.push(el('span', { class: 'page-ellipsis' }, '…')); }
  for (let p = start; p <= end; p++) pageBtns.push(pageBtn(p, current, onPageChange));
  if (end < totalPages) { if (end < totalPages - 1) pageBtns.push(el('span', { class: 'page-ellipsis' }, '…')); pageBtns.push(pageBtn(totalPages, current, onPageChange)); }

  return el('div', { class: 'pagination-bar' }, [
    info,
    el('div', { class: 'page-btns', style: 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;' }, [prevBtn, ...pageBtns, nextBtn]),
  ]);
}
function pageBtn(p, current, onPageChange) {
  return el('button', { class: `btn btn-sm ${p === current ? 'btn-primary' : 'btn-outline'}`, onclick: () => onPageChange(p) }, String(p));
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
