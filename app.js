/* ==========================================================================
   RECRUIT EXPERT — App Logic
   ========================================================================== */
const CFG = window.APP_CONFIG || {};
const backendReady = !!(CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('YOUR-PROJECT') === -1 && window.supabase);
const sb = backendReady ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

const root = document.getElementById('root');
let currentUser = null;        // matched row from tbl_User after login
let currentAgencyId = null;    // AGENCYID chosen at login — every query is scoped to this
let currentAgencyName = '';
let currentEntityKey = 'dashboard';
let searchTerm = '';
let listFilterValue = ''; // selected value for entities with a listFilter dropdown (e.g. Agent Ledger by Agent)
let listDateFrom = '';    // "dd/mm/yyyy" text — Agent/Employer Ledger date-range filter
let listDateTo = '';
let currentPage = 1;
const PAGE_SIZE = 100;
let cache = {};       // table -> rows (raw)
let refCache = {};    // table -> {id: displayLabel} for FK dropdowns/labels

const SESSION_KEY = 're_session';
function loadSavedSession() {
  try { const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function saveSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
}
function clearSavedSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

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
// For plain "number" list-view fields (quantities, debit/credit, salary, etc.)
// — adds thousands separators for readability WITHOUT forcing 2 decimal
// places, so a whole number stays a whole number and no digits are dropped
// or rounded. (Identifier-like numbers — phone, mobile, NIC, permission no,
// passport no, file no — are now stored as type "text" in entities.js
// instead, specifically so they're never run through numeric formatting or
// an HTML number input, both of which silently strip leading zeros.)
function formatNumber(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
// Renders a stored date value as dd/mm/yyyy for display only — never touches
// what's actually saved. Handles true "date" fields (Supabase sends these as
// ISO yyyy-mm-dd) and text fields that already look like a date. Anything it
// doesn't confidently recognize is shown exactly as stored, rather than
// guessed at and possibly shown wrong.
function formatDateDMY(value) {
  if (value === null || value === undefined || value === '') return '—';
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO: yyyy-mm-dd (optionally with a time part)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/); // already d/m/yyyy or d-m-yyyy
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  return s; // unrecognized format — show unchanged rather than risk misreading it
}
// Parses a stored DATATABLE date value (ISO or d/m/yyyy-ish text) into a real
// Date for range comparisons. Returns null if the format isn't recognized —
// used by the search form so an unparsable value is excluded from a date
// range search rather than silently mis-matched.
function parseStoredDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])); // dd/mm/yyyy
  return null;
}
// Parses what someone types into a "dd/mm/yyyy" search box into a real Date.
function parseInputDMY(str) {
  const s = (str || '').trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}
function entityByKey(key) { return window.ENTITIES.find(e => e.key === key); }

// A category is hidden wherever it's picked/listed if the employer it's
// linked to (CATEGORY.EMPID -> EMPLOYER) has been marked inactive. Rows with
// no linked employer at all (EMPID empty) are left visible.
function isCategoryEmployerActive(categoryRow) {
  const empEnt = entityByKey('employer');
  if (!empEnt || categoryRow.EMPID === null || categoryRow.EMPID === undefined || categoryRow.EMPID === '') return true;
  const emp = (cache[empEnt.table] || []).find(e => String(e[empEnt.pk]) === String(categoryRow.EMPID));
  return !(emp && emp.ACTIVE === false);
}

// Supabase/PostgREST caps select('*') at 1000 rows by default (or your
// project's own "Max Rows" API setting, if lower). This fetches in pages,
// advancing by however many rows actually came back — not by the requested
// page size — so it works correctly even if a page is capped shorter than
// requested. It only stops once a page comes back genuinely empty.
// If agencyField is given (an entity's ent.agencyField) and someone is
// logged in, every page is additionally scoped with .eq(agencyField, currentAgencyId)
// so only that agency's rows are ever fetched from Supabase in the first place.
async function fetchAllRows(table, orderCol, agencyField) {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  let guard = 0;
  while (guard++ < 200) { // safety cap: 200 pages is 200k+ rows, far beyond any table here
    let query = sb.from(table).select('*');
    if (agencyField && currentAgencyId != null) query = query.eq(agencyField, currentAgencyId);
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

/* ---------------- AUTH ----------------
   NOTE ON SECURITY: this checks the typed password against tbl_User by
   querying it directly with the public anon key. That means the anon key
   must be able to SELECT from tbl_User (to populate the username dropdown
   and to check the password), which in turn means anyone who opens dev
   tools and inspects network requests — or just calls the Supabase REST
   API directly with your published anon key — can read every username and
   password in that table. This is fine for a low-stakes internal tool, but
   it is NOT safe for anything you actually want to protect. If these
   accounts guard sensitive data, ask me to switch this to a Supabase Edge
   Function (or a Postgres RPC using SECURITY DEFINER) that checks the
   password server-side and only returns a yes/no — never exposing the
   password column to the browser at all. */
async function checkSession() {
  if (!sb) { renderNoBackend(); return; }
  const saved = loadSavedSession();
  if (saved && saved.user && saved.agencyId != null) {
    currentUser = saved.user;
    currentAgencyId = saved.agencyId;
    currentAgencyName = saved.agencyName || '';
    await boot();
  } else {
    await renderLogin();
  }
}

function renderNoBackend() {
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'login-screen' }, el('div', { class: 'login-box' }, [
    el('h1', {}, 'Not connected'),
    el('p', { class: 'sub' }, 'Edit config.js with your Supabase project URL and anon key, then reload this page.'),
  ])));
}

async function renderLogin() {
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'login-screen' }, el('div', { class: 'login-box' }, el('p', { class: 'sub' }, 'Loading accounts…'))));

  const [{ data: users, error: userErr }, { data: companies, error: coErr }] = await Promise.all([
    sb.from('tbl_User').select('lngUserID, strUserName').order('strUserName', { ascending: true }),
    sb.from('COMPANY').select('AGENCYID, AGENCYNAME').order('AGENCYNAME', { ascending: true }),
  ]);

  root.innerHTML = '';
  const errBox = el('div', { class: 'login-err' }, '');
  if (userErr || coErr) errBox.textContent = 'Could not load login options: ' + (userErr || coErr).message;

  const userSelect = el('select', {}, [
    el('option', { value: '' }, '— Select user —'),
    ...(users || []).map(u => el('option', { value: u.lngUserID }, u.strUserName)),
  ]);
  const passInp = el('input', { type: 'password', autocomplete: 'off' });
  const agencySelect = el('select', {}, [
    el('option', { value: '' }, '— Select agency —'),
    ...(companies || []).map(c => el('option', { value: c.AGENCYID }, c.AGENCYNAME)),
  ]);
  const btn = el('button', {}, 'Log In');

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.textContent = '';
      if (!userSelect.value || !passInp.value || !agencySelect.value) {
        errBox.textContent = 'Please select a user, enter a password, and select an agency.';
        return;
      }
      btn.disabled = true; btn.textContent = 'Signing in…';
      const { data, error } = await sb.from('tbl_User').select('*')
        .eq('lngUserID', userSelect.value)
        .eq('strUserPassword', passInp.value)
        .limit(1);
      btn.disabled = false; btn.textContent = 'Log In';
      if (error || !data || !data.length) {
        errBox.textContent = 'Incorrect user or password.';
        return;
      }
      currentUser = data[0];
      currentAgencyId = agencySelect.value;
      const chosen = (companies || []).find(c => String(c.AGENCYID) === String(agencySelect.value));
      currentAgencyName = chosen ? chosen.AGENCYNAME : '';
      saveSession({ user: currentUser, agencyId: currentAgencyId, agencyName: currentAgencyName });
      await boot();
    }
  }, [
    el('label', {}, 'User'), userSelect,
    el('label', {}, 'Password'), passInp,
    el('label', {}, 'Agency'), agencySelect,
    errBox, btn,
  ]);

  root.appendChild(el('div', { class: 'login-screen' }, el('div', { class: 'login-box' }, [
    el('div', { class: 'login-logo' }, 'RE'),
    el('h1', {}, CFG.APP_NAME || 'Recruit Expert'),
    el('p', { class: 'sub' }, 'Select your account and agency to continue.'),
    form,
  ])));
}

async function logout() {
  clearSavedSession();
  currentUser = null; currentAgencyId = null; currentAgencyName = '';
  await renderLogin();
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
    const { data, error } = await fetchAllRows(ent.table, null, ent.agencyField);
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
    el('div', { class: 'sidebar-item', 'data-key': 'searchform', onclick: () => selectEntity('searchform') }, [
      el('i', { class: 'fa-solid fa-magnifying-glass-chart' }), 'Search Candidates',
    ]),
    el('div', { class: 'sidebar-item', 'data-key': 'reports', onclick: () => selectEntity('reports') }, [
      el('i', { class: 'fa-solid fa-file-lines' }), 'Reports',
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
    el('div', { class: 'who' }, [
      currentAgencyName ? el('span', { class: 'agency-badge' }, [el('i', { class: 'fa-solid fa-building' }), ' ' + currentAgencyName]) : '',
      currentUser ? el('span', {}, ' ' + (currentUser.strUserName || '')) : '',
    ]),
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
  listFilterValue = '';
  listDateFrom = '';
  listDateTo = '';
  currentPage = 1;
  setActiveSidebar(key);
  if (key === 'dashboard') { await showDashboard(); return; }
  if (key === 'searchform') { await renderSearchForm(); return; }
  if (key === 'reports') { await renderReportsList(); return; }
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
      const { data, error } = await fetchAllRows(ent.table, null, ent.agencyField);
      if (error) return { label, value: '—', isMoney };
      const total = (data || []).reduce((s, r) => s + (Number(r[sumField]) || 0), 0);
      return { label, value: fmtMoney(total), isMoney };
    }
    // Exact row count via head request — no 1000-row cap, no row data transferred.
    let countQuery = sb.from(ent.table).select(ent.pk, { count: 'exact', head: true });
    if (ent.agencyField && currentAgencyId != null) countQuery = countQuery.eq(ent.agencyField, currentAgencyId);
    const { count, error } = await countQuery;
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

  const { data, error } = await fetchAllRows(ent.table, ent.pk, ent.agencyField);
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

/* ---------------- SEARCH CANDIDATES (combinable filters over DATATABLE) ----------------
   Filters are AND-combined and live: changing Agent, Employer, Status, or
   either date box immediately re-filters the results below — no submit
   button. Date range filters on TRAVELDATE by default (the field most
   recruitment searches care about); tell me if you meant a different
   DATATABLE date column and I'll repoint it. */
async function renderSearchForm() {
  document.getElementById('pageTitle').textContent = 'Search Candidates';
  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(el('div', { class: 'loading-state' }, 'Loading…'));

  const dtEnt = entityByKey('datatable');
  const agentEnt = entityByKey('agent');
  const employerEnt = entityByKey('employer');
  const { data, error } = await fetchAllRows(dtEnt.table, dtEnt.pk, dtEnt.agencyField);
  content.innerHTML = '';
  if (error) {
    content.appendChild(el('div', { class: 'empty-state' }, `Could not load DATATABLE: ${error.message}`));
    return;
  }
  cache[dtEnt.table] = data || [];

  const statusValues = [...new Set((cache[dtEnt.table] || [])
    .map(r => r.STATUS)
    .filter(v => v !== null && v !== undefined && v !== ''))]
    .sort((a, b) => String(a).localeCompare(String(b)));

  const agentSelect = el('select', {}, [
    el('option', { value: '' }, '— Any Agent —'),
    ...(cache[agentEnt.table] || []).map(r => el('option', { value: r[agentEnt.pk] }, r[agentEnt.displayField] ?? `#${r[agentEnt.pk]}`)),
  ]);
  const employerSelect = el('select', {}, [
    el('option', { value: '' }, '— Any Employer —'),
    ...(cache[employerEnt.table] || []).map(r => el('option', { value: r[employerEnt.pk] }, r[employerEnt.displayField] ?? `#${r[employerEnt.pk]}`)),
  ]);
  const statusSelect = el('select', {}, [
    el('option', { value: '' }, '— Any Status —'),
    ...statusValues.map(v => el('option', { value: v }, String(v))),
  ]);
  const dateFromInp = el('input', { type: 'text', placeholder: 'dd/mm/yyyy' });
  const dateToInp = el('input', { type: 'text', placeholder: 'dd/mm/yyyy' });

  const filterBar = el('div', { class: 'toolbar', style: 'flex-wrap:wrap;gap:16px;align-items:flex-end;' }, [
    el('div', { class: 'f-field' }, [el('label', {}, 'Agent'), agentSelect]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Employer'), employerSelect]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Status'), statusSelect]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Travel Date From'), dateFromInp]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Travel Date To'), dateToInp]),
  ]);
  content.appendChild(filterBar);

  const resultsBody = el('div', { id: 'searchResultsBody' }, []);
  content.appendChild(resultsBody);

  let searchPage = 1;
  function matchesFilters(row) {
    if (agentSelect.value && String(row.COID ?? '') !== String(agentSelect.value)) return false;
    if (employerSelect.value && String(row.EMPID ?? '') !== String(employerSelect.value)) return false;
    if (statusSelect.value && String(row.STATUS ?? '') !== String(statusSelect.value)) return false;
    const from = parseInputDMY(dateFromInp.value);
    const to = parseInputDMY(dateToInp.value);
    if (from || to) {
      const rowDate = parseStoredDate(row.TRAVELDATE);
      if (!rowDate) return false; // can't confirm it falls in range, so don't guess
      if (from && rowDate < from) return false;
      if (to && rowDate > to) return false;
    }
    return true;
  }

  function renderSearchResults() {
    const body = document.getElementById('searchResultsBody');
    body.innerHTML = '';
    const rows = (cache[dtEnt.table] || []).filter(matchesFilters);
    if (!rows.length) {
      body.appendChild(el('div', { class: 'data-card' }, el('div', { class: 'empty-state' }, 'No matching candidates.')));
      return;
    }
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (searchPage > totalPages) searchPage = totalPages;
    if (searchPage < 1) searchPage = 1;
    const pageRows = rows.slice((searchPage - 1) * PAGE_SIZE, searchPage * PAGE_SIZE);

    const goToPage = (p) => { searchPage = p; renderSearchResults(); };
    body.appendChild(buildPaginationBar(rows.length, searchPage, totalPages, goToPage));

    const visibleFields = dtEnt.fields;
    const thead = el('thead', {}, el('tr', {}, [
      ...visibleFields.map(f => el('th', {}, f.label)),
      el('th', {}, 'Actions'),
    ]));
    const tbody = el('tbody', {}, pageRows.map(row => el('tr', {}, [
      ...visibleFields.map(f => el('td', {}, formatCell(f, row[f.name]))),
      el('td', {}, el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn btn-outline btn-sm', onclick: () => openForm(dtEnt, row) }, 'Edit'),
        el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteRow(dtEnt, row) }, 'Delete'),
      ])),
    ])));
    const table = el('table', { class: 'data-table' }, [thead, tbody]);

    const topScrollInner = el('div', { style: 'height:1px;' });
    const topScrollBar = el('div', { class: 'top-scrollbar', style: 'overflow-x:auto;overflow-y:hidden;margin-bottom:6px;' }, topScrollInner);
    const tableWrap = el('div', { class: 'data-card', style: 'overflow-x:auto;' }, table);
    let syncingScroll = false;
    topScrollBar.addEventListener('scroll', () => { if (syncingScroll) return; syncingScroll = true; tableWrap.scrollLeft = topScrollBar.scrollLeft; syncingScroll = false; });
    tableWrap.addEventListener('scroll', () => { if (syncingScroll) return; syncingScroll = true; topScrollBar.scrollLeft = tableWrap.scrollLeft; syncingScroll = false; });

    body.appendChild(topScrollBar);
    body.appendChild(tableWrap);
    requestAnimationFrame(() => { topScrollInner.style.width = table.scrollWidth + 'px'; });
  }

  const runSearch = () => { searchPage = 1; renderSearchResults(); };
  [agentSelect, employerSelect, statusSelect].forEach(inp => inp.addEventListener('change', runSearch));
  [dateFromInp, dateToInp].forEach(inp => inp.addEventListener('input', runSearch));

  renderSearchResults();
}

function renderEntityList(ent) {
  const content = document.getElementById('content');
  content.innerHTML = '';

  // The toolbar (and the search/filter inputs inside it) is built exactly
  // once per entity view. Typing/selecting only ever rebuilds
  // #entityListBody below, never these inputs — recreating an input node on
  // every keystroke was what dropped focus after each character.
  // Some entities (e.g. Agent Ledger, Employer Ledger) use a picklist
  // dropdown instead of free-text search, via ent.listFilter = { field, ref },
  // plus a From/To date-range filter that combines with it (both apply
  // together — pick an agent AND a date range and both narrow the list).
  let searchControl;
  if (ent.listFilter) {
    const refEnt = entityByKey(ent.listFilter.ref);
    const labelFn = CUSTOM_OPTION_LABELS[`${ent.key}.${ent.listFilter.field}`];
    const options = [el('option', { value: '' }, `— All ${refEnt.label} —`)];
    (cache[refEnt.table] || []).forEach(r => {
      const label = labelFn ? labelFn(r) : (r[refEnt.displayField] ?? ('#' + r[refEnt.pk]));
      options.push(el('option', { value: String(r[refEnt.pk]) }, String(label)));
    });
    const filterSelect = el('select', {
      oninput: (e) => { listFilterValue = e.target.value; currentPage = 1; refreshEntityListBody(ent); },
    }, options);
    filterSelect.value = listFilterValue;
    const dateFromInp = el('input', {
      type: 'text', placeholder: 'From dd/mm/yyyy', value: listDateFrom,
      oninput: (e) => { listDateFrom = e.target.value; currentPage = 1; refreshEntityListBody(ent); },
    });
    const dateToInp = el('input', {
      type: 'text', placeholder: 'To dd/mm/yyyy', value: listDateTo,
      oninput: (e) => { listDateTo = e.target.value; currentPage = 1; refreshEntityListBody(ent); },
    });
    searchControl = el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;' }, [
      el('div', { class: 'search-box' }, [el('i', { class: 'fa-solid fa-filter' }), filterSelect]),
      el('div', { class: 'search-box' }, [el('i', { class: 'fa-solid fa-calendar' }), dateFromInp]),
      el('div', { class: 'search-box' }, [el('i', { class: 'fa-solid fa-calendar' }), dateToInp]),
    ]);
  } else {
    const searchLabel = ent.search
      ? ent.search.map(name => (ent.fields.find(f => f.name === name) || {}).label || name).join(' & ')
      : ent.label;
    const searchInput = el('input', {
      type: 'text', placeholder: `Search by ${searchLabel}…`, value: searchTerm,
      oninput: (e) => { searchTerm = e.target.value; currentPage = 1; refreshEntityListBody(ent); },
    });
    searchControl = el('div', { class: 'search-box' }, [el('i', { class: 'fa-solid fa-magnifying-glass' }), searchInput]);
  }
  // Search/filter controls sit on their own row, buttons on the row below —
  // stacked instead of side-by-side, so a wide filter row (picklist + two
  // date boxes) never overlaps or hides the action buttons.
  const buttonRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
    ...(ent.key === 'agentledger' || ent.key === 'employerledger'
      ? [
          el('button', { class: 'btn btn-outline', onclick: () => printLedgerReport(ent) }, [el('i', { class: 'fa-solid fa-print' }), ' Print Report']),
          el('button', { class: 'btn btn-outline', onclick: () => renderDuplicatesPanel(ent) }, [el('i', { class: 'fa-solid fa-clone' }), ' Find Duplicate Entries']),
        ]
      : []),
    ...(ent.key === 'datatable'
      ? [el('button', { class: 'btn btn-outline', onclick: () => openVisaFormKhi() }, [el('i', { class: 'fa-solid fa-print' }), ' Visa Form KHI'])]
      : []),
    el('button', { class: 'btn btn-outline', onclick: () => exportCsv(ent) }, [el('i', { class: 'fa-solid fa-download' }), ' Export Report (CSV)']),
    el('button', { class: 'btn btn-primary', onclick: () => openForm(ent, null) }, [el('i', { class: 'fa-solid fa-plus' }), ` Add ${ent.label.replace(/s$/, '')}`]),
  ]);
  const toolbar = el('div', { class: 'toolbar', style: 'display:flex;flex-direction:column;align-items:stretch;gap:12px;' }, [
    searchControl,
    buttonRow,
  ]);
  content.appendChild(toolbar);

  const listBody = el('div', { id: 'entityListBody' }, []);
  content.appendChild(listBody);

  refreshEntityListBody(ent);
}

// Rebuilds only the results area (empty-state / pagination / scrollbars /
// table) — called on every keystroke and page change. Leaves the toolbar and
// search input untouched so focus and cursor position are never disturbed.
function refreshEntityListBody(ent) {
  const listBody = document.getElementById('entityListBody');
  if (!listBody) return;
  listBody.innerHTML = '';

  // rows are already newest-first (fetched ordered by primary key, descending)
  const rows = filteredRows(ent);
  if (!rows.length) {
    listBody.appendChild(el('div', { class: 'data-card' }, el('div', { class: 'empty-state' }, `No ${ent.label.toLowerCase()} found.`)));
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const pageRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const goToPage = (p) => { currentPage = p; refreshEntityListBody(ent); };
  listBody.appendChild(buildPaginationBar(rows.length, currentPage, totalPages, goToPage));

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

  listBody.appendChild(topScrollBar);
  listBody.appendChild(tableWrap);
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
  // True date columns, plus text columns whose name is clearly a date
  // (TRAVELDATE, DATEOFBIRTH, DATED, etc.) — displayed as dd/mm/yyyy.
  if (field.type === 'date' || /date/i.test(field.name) || field.name === 'DATED') return formatDateDMY(value);
  if (field.type === 'number') return formatNumber(value);
  return String(value);
}

function filteredRows(ent) {
  let rows = cache[ent.table] || [];
  // Candidates: show most recently added first (DID is the auto-incrementing
  // primary key, so the highest value is the newest record).
  if (ent.key === 'datatable') rows = [...rows].sort((a, b) => (b.DID ?? 0) - (a.DID ?? 0));
  // Categories tied to a now-inactive employer are hidden from the list —
  // same rule as the dropdowns, so the list and the pickers stay consistent.
  if (ent.key === 'category') rows = rows.filter(isCategoryEmployerActive);
  // Picklist filter (e.g. Agent Ledger by Agent, Employer Ledger by Company)
  if (ent.listFilter && listFilterValue) {
    rows = rows.filter(row => String(row[ent.listFilter.field]) === listFilterValue);
  }
  // Date-range filter, combines (AND) with the picklist filter above — pick
  // an Agent AND a date range and both narrow the list together.
  if (ent.listFilter && (listDateFrom || listDateTo)) {
    const from = parseInputDMY(listDateFrom);
    const to = parseInputDMY(listDateTo);
    if (from || to) {
      rows = rows.filter(row => {
        const d = parseStoredDate(row.DATE);
        if (!d) return false; // can't confirm it's in range, so don't guess
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
    }
  }
  const query = searchTerm.trim();
  if (!query) return rows;

  // Word-by-word matching: every typed word must be found somewhere in the
  // searchable fields (as a substring), independently — not the whole phrase
  // matched contiguously. So "ishaq khan" matches "SARDAR MUHAMMAD ISHAQ KHAN".
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Search only the fields configured on the entity (ent.search) — e.g.
  // DATATABLE searches NAME + PASSPORTNO only, not all 80 columns. Entities
  // without a configured search list fall back to checking every field.
  const searchFieldNames = ent.search || ent.fields.map(f => f.name);
  const searchFields = ent.fields.filter(f => searchFieldNames.includes(f.name));

  const valueForField = (row, f) => {
    const v = row[f.name];
    if (v === null || v === undefined) return '';
    if (f.type === 'select') {
      const refEnt = entityByKey(f.ref);
      return ((refCache[refEnt.table] && refCache[refEnt.table][v]) || '').toLowerCase();
    }
    return String(v).toLowerCase();
  };

  return rows.filter(row => {
    const fieldValues = searchFields.map(f => valueForField(row, f));
    return words.every(word => fieldValues.some(val => val.includes(word)));
  });
}

/* ---------------- FORM MODAL (Add / Edit) ---------------- */
// Some FK dropdowns need more than just the linked record's name to tell
// rows apart (e.g. two employers with a similar name) — this maps
// "entityKey.fieldName" to a function that builds a richer option label.
// Falls back to the entity's plain displayField when no override is listed.
const CUSTOM_OPTION_LABELS = {
  // Category → Employer: show company name, ID, and visa no together.
  'category.EMPID': (row) => {
    const parts = [row.NAMEOFEMPLOYER || '(no name)'];
    if (row.IDNO) parts.push(`ID: ${row.IDNO}`);
    if (row.VISANO) parts.push(`Visa: ${row.VISANO}`);
    return parts.join(' — ');
  },
  // Employer Ledger's filter dropdown: employer name + visa no, same idea.
  'employerledger.EMPID': (row) => {
    const parts = [row.NAMEOFEMPLOYER || '(no name)'];
    if (row.VISANO) parts.push(`Visa: ${row.VISANO}`);
    return parts.join(' — ');
  },
  // DATATABLE → Category: show category, plus the linked employer's name,
  // visa no, and demand (those live on EMPLOYER, joined via CATEGORY.EMPID).
  'datatable.CATEGORYID': (row) => {
    const parts = [row.CATEGORY || '(no category)'];
    const empEnt = entityByKey('employer');
    const emp = (cache[empEnt.table] || []).find(e => String(e[empEnt.pk]) === String(row.EMPID));
    if (emp) {
      if (emp.NAMEOFEMPLOYER) parts.push(emp.NAMEOFEMPLOYER);
      if (emp.VISANO) parts.push(`Visa: ${emp.VISANO}`);
      if (emp.DEMAND !== null && emp.DEMAND !== undefined && emp.DEMAND !== '') parts.push(`Demand: ${emp.DEMAND}`);
    }
    return parts.join(' — ');
  },
};

// DATATABLE auto-fill: picking a Category pulls matching values from
// CATEGORY, and — through CATEGORY.EMPID — from the linked EMPLOYER row.
// Separately, three fields always mirror the logged-in agency's own
// COMPANY record (set at login), the same way AGENCYID is already locked.
// All of these are derived, never hand-typed, so the form disables them.
const DATATABLE_CATEGORY_AUTOFILL = {
  CATEGORY: 'CATEGORY', SALARY: 'SALARY', QUANTITY: 'QUANTITY', REQTRADE: 'REQTRADE',
};
const DATATABLE_EMPLOYER_AUTOFILL = {
  NAMEOFEMPLOYER: 'NAMEOFEMPLOYER', ADDRESSOFEMPLOYER: 'ADDRESSOFEMPLOYER', VISANO: 'VISANO',
  IDNO: 'IDNO', VISADATE: 'VISADATE', DEMAND: 'DEMAND', CITY: 'CITY', VISATYPE: 'VISATYPE',
  FileNo: 'FILENO', Embassyin: 'EMBASSYIN',
};
const DATATABLE_AGENCY_AUTOFILL = {
  NAMEOFEGENCY: 'AGENCYNAME', NAMEOFOWNER: 'NAMEOFOWNER', LICNO: 'LICENCENUMBER',
};

async function openForm(ent, existingRow) {
  // make sure dropdown ref data is fresh
  await preloadRefCaches();

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const inputs = {};

  const fieldNodes = ent.fields.map(f => {
    let inputEl;
    const val = existingRow ? existingRow[f.name] : '';
    const isAgencyField = ent.agencyField && f.name === ent.agencyField;
    if (f.type === 'textarea') {
      inputEl = el('textarea', {}, '');
      inputEl.value = val ?? '';
    } else if (f.type === 'staticselect') {
      // A fixed list of choices defined right on the field (f.options) —
      // not looked up from another table, e.g. Active: True/False.
      const options = [el('option', { value: '' }, '— none —'), ...f.options.map(o => el('option', { value: o }, o))];
      inputEl = el('select', {}, options);
      inputEl.value = val ?? '';
    } else if (f.type === 'select') {
      const refEnt = entityByKey(f.ref);
      const labelFn = CUSTOM_OPTION_LABELS[`${ent.key}.${f.name}`];
      const options = [el('option', { value: '' }, '— none —')];
      const currentVal = val != null ? String(val) : '';
      (cache[refEnt.table] || []).forEach(r => {
        // Don't offer an inactive employer as a choice — but if this record
        // is already pointing at one (e.g. it was set before the employer
        // was deactivated), keep showing it so editing doesn't silently
        // blank the field out from under you.
        if (refEnt.key === 'employer' && r.ACTIVE === false && String(r[refEnt.pk]) !== currentVal) return;
        if (refEnt.key === 'category' && !isCategoryEmployerActive(r) && String(r[refEnt.pk]) !== currentVal) return;
        const label = labelFn ? labelFn(r) : (r[refEnt.displayField] ?? ('#' + r[refEnt.pk]));
        options.push(el('option', { value: r[refEnt.pk] }, String(label)));
      });
      inputEl = el('select', {}, options);
      // Lock this record to the logged-in agency: pre-fill and disable so it
      // can't be reassigned to a different agency while viewing this one.
      inputEl.value = isAgencyField ? String(currentAgencyId ?? '') : (val ?? '');
      if (isAgencyField) inputEl.disabled = true;
    } else {
      inputEl = el('input', { type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text' });
      if (f.type === 'number') inputEl.step = 'any';
      inputEl.value = val ?? '';
    }
    inputs[f.name] = inputEl;
    const wrapClass = (f.type === 'textarea') ? 'f-field full' : 'f-field';
    return el('div', { class: wrapClass }, [
      el('label', {}, f.label + (f.required ? ' *' : '') + (isAgencyField ? ' (locked to current agency)' : '')),
      inputEl,
    ]);
  });

  if (ent.key === 'datatable') {
    // Name of Agency / Name of Owner / Lic No: always the logged-in
    // agency's own COMPANY record, not something entered per-row.
    const companyEnt = entityByKey('company');
    const myCompany = (cache[companyEnt.table] || [])
      .find(c => String(c[companyEnt.pk]) === String(currentAgencyId));
    Object.entries(DATATABLE_AGENCY_AUTOFILL).forEach(([dtField, coField]) => {
      if (!inputs[dtField]) return;
      inputs[dtField].value = myCompany ? (myCompany[coField] ?? '') : '';
      inputs[dtField].disabled = true;
    });

    // Category (and, via CATEGORY.EMPID, Employer) -> the rest.
    const applyCategoryAutofill = (categoryId) => {
      const catEnt = entityByKey('category');
      const catRow = (cache[catEnt.table] || [])
        .find(c => String(c[catEnt.pk]) === String(categoryId));

      Object.entries(DATATABLE_CATEGORY_AUTOFILL).forEach(([dtField, catField]) => {
        if (!inputs[dtField]) return;
        inputs[dtField].value = catRow ? (catRow[catField] ?? '') : '';
        inputs[dtField].disabled = true;
      });

      const empEnt = entityByKey('employer');
      const empRow = (catRow && catRow.EMPID != null && catRow.EMPID !== '')
        ? (cache[empEnt.table] || []).find(e => String(e[empEnt.pk]) === String(catRow.EMPID))
        : null;
      Object.entries(DATATABLE_EMPLOYER_AUTOFILL).forEach(([dtField, empField]) => {
        if (!inputs[dtField]) return;
        inputs[dtField].value = empRow ? (empRow[empField] ?? '') : '';
        inputs[dtField].disabled = true;
      });
    };

    if (inputs.CATEGORYID) {
      inputs.CATEGORYID.addEventListener('change', () => applyCategoryAutofill(inputs.CATEGORYID.value));
      // Run once on open too — covers both a fresh Add (blank, so derived
      // fields just end up blank+locked) and editing an existing row
      // (so the derived fields reflect the currently-linked category /
      // employer rather than whatever was saved historically).
      applyCategoryAutofill(inputs.CATEGORYID.value);
    }
  }

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
        else if (f.type === 'select') {
          // Not every FK points at a numeric auto-ID — AGENT's primary key
          // (COID) and possibly others are TEXT business codes. Forcing
          // Number() on a non-numeric code produces NaN, which silently
          // serializes to null in the request body — the row saves, but the
          // link is quietly gone (this was breaking Receipts -> Agent
          // Ledger whenever the selected agent's COID wasn't plain digits).
          // Only convert when it actually parses as a real number; otherwise
          // keep the original text value intact.
          if (v === '') v = null;
          else {
            const n = Number(v);
            v = Number.isNaN(n) ? v : n;
          }
        }
        else v = v === '' ? null : v;
        if (f.required && (v === null || v === '')) valid = false;
        payload[f.name] = v;
      });
      if (!valid) { errBox.textContent = 'Please fill all required fields.'; return; }

      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      let result;
      if (existingRow) {
        result = await sb.from(ent.table).update(payload).eq(ent.pk, existingRow[ent.pk]);
      } else if (ent.key === 'pay' || ent.key === 'rec') {
        // Need the newly inserted row back so we can mirror it into the
        // matching ledger (linked via Payid / recid) right below.
        result = await sb.from(ent.table).insert(payload).select();
      } else {
        result = await sb.from(ent.table).insert(payload);
      }
      saveBtn.disabled = false; saveBtn.textContent = existingRow ? 'Save Changes' : 'Add ' + ent.label.replace(/s$/, '');

      if (result.error) { errBox.textContent = result.error.message; return; }

      // New Payments automatically get a matching Employer Ledger entry —
      // the amount goes in CREDIT, linked back to this payment via Payid.
      if (!existingRow && ent.key === 'pay' && result.data && result.data[0]) {
        const newPay = result.data[0];
        const elEnt = entityByKey('employerledger');
        const ledgerResult = await sb.from(elEnt.table).insert({
          EMPID: newPay.EMPID,
          AGENCYID: newPay.AGENCYID,
          DATE: newPay.PAYDATE,
          DESCRIPTION: newPay.DESCRIPTION || newPay.PAYTYPE || 'Payment',
          CREDIT: newPay.PAYAMOUNT,
          DEBIT: null,
          Payid: newPay[ent.pk],
        });
        if (ledgerResult.error) {
          toast('Payment saved, but the linked Employer Ledger entry failed: ' + ledgerResult.error.message);
        }
      }

      // New Receipts automatically get a matching Agent Ledger entry — the
      // amount goes in DEBIT, linked back to this receipt via recid.
      if (!existingRow && ent.key === 'rec' && result.data && result.data[0]) {
        const newRec = result.data[0];
        const alEnt = entityByKey('agentledger');
        const ledgerResult = await sb.from(alEnt.table).insert({
          COID: newRec.COID,
          AGENCYID: newRec.AGENCYID,
          DATE: newRec.RECEIVEDATE,
          DESCRIPTION: newRec.DESCRIPTION || newRec.TYPE || 'Receipt',
          DEBIT: newRec.AMOUNT,
          CREDIT: null,
          recid: newRec[ent.pk],
        });
        if (ledgerResult.error) {
          toast('Receipt saved, but the linked Agent Ledger entry failed: ' + ledgerResult.error.message);
        }
      }

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

// Print a proper statement-of-account for Agent Ledger / Employer Ledger:
// Date | Description | Debit | Credit | Balance (running total), styled as
// an invoice/statement rather than a plain data dump. If the list is
// currently filtered to one Agent/Employer, that party's name/details
// appear in the statement header and the running balance is a real
// opening-to-closing balance for that one account. Printing with no party
// filter selected still works, but the running balance then blends every
// party's rows together in date order — so it's most meaningful when
// printed from inside one Agent's or one Employer's ledger view.
// Finds likely-duplicate Agent/Employer Ledger entries and lets you delete
// the extras on the spot. Two different situations get told apart, because
// they mean two different things:
//  1. Multiple ledger rows linked to the SAME Receipt/Payment (same recid or
//     Payid) — this can only happen if something inserted more than once for
//     one transaction. This is the strongest signal of an actual save bug.
//  2. Rows with no Receipt/Payment link at all that otherwise look identical
//     (same party, date, debit, credit, description) — almost always means
//     someone entered the same ledger line by hand more than once; not a
//     code bug, just needs cleaning up.
function findDuplicateLedgerEntries(ent) {
  const rows = cache[ent.table] || [];
  const linkField = ent.key === 'agentledger' ? 'recid' : 'Payid';
  const partyField = ent.key === 'agentledger' ? 'COID' : 'EMPID';
  const hasEnumber = ent.fields.some(f => f.name === 'Enumber');
  const claimed = new Set(); // row primary keys already grouped by a stronger signal

  // Tier 1 (strongest): same recid/Payid — provably the same underlying
  // Receipt/Payment, so more than one ledger row for it is definitely wrong.
  const byLink = {};
  rows.forEach(r => {
    const link = r[linkField];
    if (link === null || link === undefined || link === '') return;
    (byLink[link] = byLink[link] || []).push(r);
  });
  const linkedDupes = Object.values(byLink).filter(g => g.length > 1);
  linkedDupes.forEach(g => g.forEach(r => claimed.add(r[ent.pk])));

  // Tier 2: same Enumber — a real reference number your agency assigns, so
  // two rows sharing one is a strong, direct signal of a duplicate entry.
  // Rows already caught by Tier 1 are skipped here to avoid listing the same
  // row twice under two different reasons.
  let enumberDupes = [];
  if (hasEnumber) {
    const byEnumber = {};
    rows.forEach(r => {
      if (claimed.has(r[ent.pk])) return;
      const en = r.Enumber;
      if (en === null || en === undefined || String(en).trim() === '') return;
      const key = String(en).trim();
      (byEnumber[key] = byEnumber[key] || []).push(r);
    });
    enumberDupes = Object.values(byEnumber).filter(g => g.length > 1);
    enumberDupes.forEach(g => g.forEach(r => claimed.add(r[ent.pk])));
  }

  // Tier 3 (weakest, last resort): same party + date + debit + credit +
  // description, for rows not already caught above. Only considered when
  // there's a real date AND a real, non-zero amount — rows missing those are
  // just sparse/incomplete data, not duplicates of each other, and grouping
  // them by their shared blankness was flagging huge numbers of unrelated
  // rows as false positives.
  const hasRealAmount = (r) => (Number(r.DEBIT) || 0) !== 0 || (Number(r.CREDIT) || 0) !== 0;
  const hasRealDate = (r) => r.DATE !== null && r.DATE !== undefined && String(r.DATE).trim() !== '';
  const unlinked = rows.filter(r =>
    !claimed.has(r[ent.pk]) && hasRealDate(r) && hasRealAmount(r)
  );
  const byFingerprint = {};
  unlinked.forEach(r => {
    const fp = [r[partyField], r.DATE, r.DEBIT, r.CREDIT, r.DESCRIPTION].map(v => String(v ?? '')).join('|');
    (byFingerprint[fp] = byFingerprint[fp] || []).push(r);
  });
  const unlinkedDupes = Object.values(byFingerprint).filter(g => g.length > 1);

  return { linkedDupes, enumberDupes, unlinkedDupes };
}

// Deletes a batch of rows with a single confirmation up front, instead of
// deleteRow's one-confirm-per-row (which is what made this tedious at scale).
// Deletes in chunks of 200 via .in(pk, [...ids]) instead of one request per
// row — far fewer round trips, and far less likely to look "stuck" on a
// large batch. onProgress(done, total) lets the caller show real progress.
// Stops and returns immediately on the first error (instead of silently
// failing 4,000+ times) so a permissions problem surfaces right away.
async function bulkDeleteRows(ent, rows, onProgress) {
  if (!rows.length) return { deleted: 0, failed: 0, error: null };
  const chunkSize = 200;
  let deleted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const ids = chunk.map(r => r[ent.pk]);
    const { error } = await sb.from(ent.table).delete().in(ent.pk, ids);
    if (error) return { deleted, failed: rows.length - deleted, error };
    deleted += chunk.length;
    if (onProgress) onProgress(deleted, rows.length);
  }
  return { deleted, failed: 0, error: null };
}

function renderDuplicatesPanel(ent) {
  const { linkedDupes, enumberDupes, unlinkedDupes } = findDuplicateLedgerEntries(ent);
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const allGroups = [...linkedDupes, ...enumberDupes, ...unlinkedDupes];
  // Keep the first row in each group (oldest, since rows are fetched newest-
  // first this is actually the last item — but consistently "keep index 0"
  // just needs to keep exactly one; which one survives rarely matters since
  // they're near-identical by definition) and delete the rest.
  const allExtras = allGroups.flatMap(g => g.slice(1));

  const refreshAfterDelete = async () => {
    overlay.remove();
    await showEntityList(ent);
    renderDuplicatesPanel(ent);
  };

  const renderGroup = (group, reason) => {
    const extras = group.slice(1);
    const extrasBtn = extras.length > 1 ? el('button', { class: 'btn btn-outline btn-sm' }, `Delete extras (${extras.length})`) : null;
    if (extrasBtn) {
      extrasBtn.onclick = async () => {
        if (!confirm(`Delete ${extras.length} duplicate entries from this group, keeping one? This cannot be undone.`)) return;
        extrasBtn.disabled = true;
        const { deleted, error } = await bulkDeleteRows(ent, extras, (done, total) => {
          extrasBtn.textContent = `Deleting… ${done} / ${total}`;
        });
        if (error) {
          alert(`Stopped after deleting ${deleted} of ${extras.length}.\n\nSupabase error: ${error.message}`);
        } else {
          toast(`Deleted ${deleted} duplicate entries.`);
        }
        await refreshAfterDelete();
      };
    }
    return el('div', { class: 'data-card', style: 'margin-bottom:14px;padding:12px;' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:12px;' }, [
        el('div', { style: 'font-weight:bold;' }, reason),
        extrasBtn || '',
      ]),
      ...group.map(r => el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #eee;gap:12px;' }, [
        el('span', {}, `${formatDateDMY(r.DATE)} — ${r.DESCRIPTION || '—'} — Dr ${r.DEBIT ?? '—'} / Cr ${r.CREDIT ?? '—'}`),
        el('button', { class: 'btn btn-danger btn-sm', onclick: async () => { await deleteRow(ent, r); await refreshAfterDelete(); } }, 'Delete this one'),
      ])),
    ]);
  };

  const body = [];
  if (allExtras.length) {
    const deleteAllBtn = el('button', { class: 'btn btn-danger' }, [el('i', { class: 'fa-solid fa-trash' }), ` Delete All Duplicates (${allExtras.length})`]);
    deleteAllBtn.onclick = async () => {
      if (!confirm(`Delete ${allExtras.length} duplicate entries across all groups, keeping one from each? This cannot be undone.`)) return;
      deleteAllBtn.disabled = true;
      const { deleted, error } = await bulkDeleteRows(ent, allExtras, (done, total) => {
        deleteAllBtn.textContent = `Deleting… ${done} / ${total}`;
      });
      if (error) {
        alert(`Stopped after deleting ${deleted} of ${allExtras.length}.\n\nSupabase error: ${error.message}\n\nThis is usually a Row Level Security permission issue — check that your anon key is allowed to DELETE from this table.`);
      } else {
        toast(`Deleted ${deleted} duplicate entries.`);
      }
      await refreshAfterDelete();
    };
    body.push(el('div', { style: 'margin-bottom:16px;' }, [deleteAllBtn]));
  }
  if (linkedDupes.length) {
    body.push(el('h4', { style: 'color:#b91c1c;' }, `⚠ ${linkedDupes.length} ${ent.key === 'agentledger' ? 'Receipt' : 'Payment'}(s) with more than one ledger entry — this points to a real duplicate-save bug`));
    linkedDupes.forEach(g => body.push(renderGroup(g, `${g.length} ledger entries linked to the same ${ent.key === 'agentledger' ? 'Receipt' : 'Payment'} — keep one, delete the rest`)));
  }
  if (enumberDupes.length) {
    body.push(el('h4', { style: 'color:#b91c1c;' }, `⚠ ${enumberDupes.length} Enumber(s) shared by more than one entry — a real duplicate signal`));
    enumberDupes.forEach(g => body.push(renderGroup(g, `${g.length} entries share Enumber "${g[0].Enumber}"`)));
  }
  if (unlinkedDupes.length) {
    body.push(el('h4', {}, `${unlinkedDupes.length} group(s) of identical-looking manual entries (same party/date/amount, not linked to any ${ent.key === 'agentledger' ? 'Receipt' : 'Payment'} or Enumber)`));
    unlinkedDupes.forEach(g => body.push(renderGroup(g, `${g.length} entries look identical`)));
  }
  if (!linkedDupes.length && !enumberDupes.length && !unlinkedDupes.length) {
    body.push(el('div', { class: 'empty-state' }, 'No duplicate-looking entries found in this table.'));
  }

  const box = el('div', { class: 'modal-box' }, [
    el('button', { class: 'modal-close', onclick: () => overlay.remove() }, '✕'),
    el('h3', {}, 'Possible Duplicate Ledger Entries'),
    ...body,
  ]);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function printLedgerReport(ent) {
  const rows = filteredRows(ent);
  if (!rows.length) { toast('Nothing to print.'); return; }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isAgent = ent.key === 'agentledger';

  // Resolve the party name/details for the statement header, if the view
  // is currently filtered down to a single Agent or Employer.
  let partyLabel = isAgent ? 'All Agents' : 'All Employers';
  let partyMeta = '';
  if (listFilterValue) {
    if (isAgent) {
      const agentEnt = entityByKey('agent');
      const agent = (cache[agentEnt.table] || []).find(r => String(r[agentEnt.pk]) === listFilterValue);
      if (agent) {
        partyLabel = agent.AGENTNAME || ('Agent #' + agent[agentEnt.pk]);
        partyMeta = [agent.AGENCY, agent.TEL || agent.MOB].filter(Boolean).join(' · ');
      }
    } else {
      const empEnt = entityByKey('employer');
      const emp = (cache[empEnt.table] || []).find(r => String(r[empEnt.pk]) === listFilterValue);
      if (emp) {
        partyLabel = emp.NAMEOFEMPLOYER || ('Employer #' + emp[empEnt.pk]);
        partyMeta = emp.VISANO ? `Visa No. ${emp.VISANO}` : '';
      }
    }
  }

  // Sort oldest -> newest so the running balance reads correctly top to bottom.
  const sorted = [...rows].sort((a, b) => new Date(a.DATE || 0) - new Date(b.DATE || 0));

  let balance = 0;
  let totalDebit = 0, totalCredit = 0;
  const bodyRows = sorted.map(row => {
    const debit = Number(row.DEBIT) || 0;
    const credit = Number(row.CREDIT) || 0;
    balance += debit - credit;
    totalDebit += debit;
    totalCredit += credit;
    return [
      formatDateDMY(row.DATE),
      esc(row.DESCRIPTION || '—'),
      debit ? formatNumber(debit) : '—',
      credit ? formatNumber(credit) : '—',
      formatNumber(balance),
    ];
  });

  const title = isAgent ? 'Agent Ledger — Statement of Account' : 'Employer Ledger — Statement of Account';
  const balanceWord = balance > 0 ? 'Dr' : balance < 0 ? 'Cr' : '';

  const html = `<!DOCTYPE html><html><head><title>${esc(title)}</title>
    <style>
      *{box-sizing:border-box;}
      body{font-family:Arial,Helvetica,sans-serif;padding:36px;color:#1a1a1a;}
      .letterhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1a1a1a;padding-bottom:16px;margin-bottom:22px;}
      .letterhead h1{margin:0;font-size:20px;letter-spacing:.02em;}
      .letterhead .sub{font-size:11px;color:#666;margin-top:3px;}
      .letterhead .doc-title{font-size:14px;font-weight:bold;text-align:right;}
      .letterhead .doc-date{font-size:11px;color:#666;text-align:right;margin-top:3px;}
      .party-box{display:flex;justify-content:space-between;margin-bottom:22px;}
      .party-box .label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:4px;}
      .party-box .name{font-size:15px;font-weight:bold;}
      .party-box .meta{font-size:11px;color:#555;margin-top:2px;}
      table{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:4px;}
      th{background:#1a1a1a;color:#fff;padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;}
      td{padding:7px 10px;border-bottom:1px solid #ddd;}
      td:nth-child(3),td:nth-child(4),td:nth-child(5),th:nth-child(3),th:nth-child(4),th:nth-child(5){text-align:right;}
      tbody tr:nth-child(even){background:#fafafa;}
      tfoot td{border-top:2px solid #1a1a1a;border-bottom:none;font-weight:bold;padding-top:10px;}
      .closing-row td{font-size:14px;padding-top:12px;}
      .footer-note{margin-top:30px;font-size:10.5px;color:#888;border-top:1px solid #ddd;padding-top:10px;}
      @media print{ body{padding:14px;} }
    </style></head><body>
    <div class="letterhead">
      <div>
        <h1>${esc(CFG.APP_NAME || 'Recruit Expert')}</h1>
        <div class="sub">Overseas Recruitment &amp; Manpower Services</div>
      </div>
      <div>
        <div class="doc-title">${esc(title)}</div>
        <div class="doc-date">Generated ${esc(formatDateDMY(new Date().toISOString()))}</div>
      </div>
    </div>
    <div class="party-box">
      <div>
        <div class="label">${isAgent ? 'Agent' : 'Employer'}</div>
        <div class="name">${esc(partyLabel)}</div>
        ${partyMeta ? `<div class="meta">${esc(partyMeta)}</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div class="label">Entries</div>
        <div class="name">${sorted.length}</div>
      </div>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
      <tbody>${bodyRows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
      <tfoot>
        <tr><td colspan="2">Totals</td><td>${formatNumber(totalDebit)}</td><td>${formatNumber(totalCredit)}</td><td></td></tr>
        <tr class="closing-row"><td colspan="4">Closing Balance</td><td>${formatNumber(Math.abs(balance))} ${balanceWord}</td></tr>
      </tfoot>
    </table>
    <div class="footer-note">This statement was generated automatically from ${esc(CFG.APP_NAME || 'Recruit Expert')} and reflects entries recorded as of the generation date above.</div>
    </body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}

/* ==========================================================================
   REPORT DESIGNER (Candidates only, saved in THIS BROWSER only)
   A free-form drag-and-drop canvas: drop Candidate fields, plain text
   labels, and images anywhere on a page, save the layout, then print it for
   any specific candidate later (field placeholders get replaced with that
   candidate's real data at print time).
   ========================================================================== */
const REPORTS_KEY = 'RE_SAVED_REPORTS';
const PAGE_SIZES = {
  letter: { w: 816, h: 1056, cssSize: 'letter' },   // 8.5in x 11in @ 96dpi
  a4:     { w: 794, h: 1123, cssSize: 'A4' },        // 210mm x 297mm @ 96dpi
};

function loadSavedReports() {
  try { return JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]'); }
  catch (e) { return []; }
}
function saveSavedReportsList(list) {
  try { localStorage.setItem(REPORTS_KEY, JSON.stringify(list)); return true; }
  catch (e) { toast('Could not save — your browser storage may be full (large images use a lot of space).'); return false; }
}

async function renderReportsList() {
  document.getElementById('pageTitle').textContent = 'Reports';
  const content = document.getElementById('content');
  content.innerHTML = '';
  const reports = loadSavedReports();

  const toolbar = el('div', { class: 'toolbar' }, [
    el('div', {}, 'Report designs are saved in this browser only.'),
    el('button', { class: 'btn btn-primary', onclick: () => renderReportDesigner(null) }, [el('i', { class: 'fa-solid fa-plus' }), ' New Report']),
  ]);
  content.appendChild(toolbar);

  if (!reports.length) {
    content.appendChild(el('div', { class: 'empty-state' }, 'No saved reports yet — click "New Report" to design one.'));
    return;
  }

  const rows = reports.map(r => el('tr', {}, [
    el('td', {}, r.name),
    el('td', {}, String((r.elements || []).filter(x => x.type === 'field').length) + ' fields'),
    el('td', {}, [
      el('button', { class: 'btn btn-outline btn-sm', onclick: () => renderReportDesigner(r) }, 'Edit'),
      ' ',
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => openReportPrintPicker(r) }, [el('i', { class: 'fa-solid fa-print' }), ' Print']),
      ' ',
      el('button', {
        class: 'btn btn-danger btn-sm',
        onclick: () => {
          if (!confirm(`Delete report "${r.name}"? This can't be undone.`)) return;
          saveSavedReportsList(loadSavedReports().filter(x => x.id !== r.id));
          renderReportsList();
        },
      }, 'Delete'),
    ]),
  ]));
  content.appendChild(el('table', { class: 'data-table' }, [
    el('thead', {}, el('tr', {}, [el('th', {}, 'Report Name'), el('th', {}, 'Fields'), el('th', {}, 'Actions')])),
    el('tbody', {}, rows),
  ]));
}

function renderReportDesigner(existingReport) {
  document.getElementById('pageTitle').textContent = (existingReport && existingReport.id) ? `Edit Report: ${existingReport.name}` : 'New Report';
  const content = document.getElementById('content');
  content.innerHTML = '';

  const dtEnt = entityByKey('datatable');
  const nameInput = el('input', { type: 'text', placeholder: 'Report name', value: existingReport ? existingReport.name : '', style: 'width:220px' });

  let pageSizeKey = (existingReport && existingReport.pageSize) || 'letter';
  const pageSizeSelect = el('select', {
    onchange: (e) => { pageSizeKey = e.target.value; const s = PAGE_SIZES[pageSizeKey]; canvas.style.width = s.w + 'px'; canvas.style.height = s.h + 'px'; },
  }, [
    el('option', { value: 'letter', selected: pageSizeKey === 'letter' ? 'selected' : undefined }, 'Letter (8.5×11in)'),
    el('option', { value: 'a4', selected: pageSizeKey === 'a4' ? 'selected' : undefined }, 'A4 (210×297mm)'),
  ]);
  pageSizeSelect.value = pageSizeKey;

  const fieldSelect = el('select', {}, [
    el('option', { value: '' }, '— Add a field —'),
    ...dtEnt.fields.map(f => el('option', { value: f.name }, f.label)),
  ]);
  const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });

  const initialSize = PAGE_SIZES[pageSizeKey];
  const canvas = el('div', {
    id: 'reportCanvas',
    style: `position:relative;width:${initialSize.w}px;height:${initialSize.h}px;background:#fff;` +
           `border:1px solid #bbb;box-shadow:0 2px 10px rgba(0,0,0,.15);margin:20px auto;overflow:hidden;`,
  }, []);

  let nextStack = 0; // staggers newly-added elements so they don't all land on top of each other
  function nextPos() {
    const pos = { x: 40 + (nextStack % 8) * 18, y: 40 + (nextStack % 8) * 18 };
    nextStack++;
    return pos;
  }

  function addElement(data) {
    const node = buildDesignerElement(data);
    canvas.appendChild(node);
  }

  fieldSelect.addEventListener('change', () => {
    const name = fieldSelect.value;
    if (!name) return;
    const f = dtEnt.fields.find(x => x.name === name);
    const pos = nextPos();
    addElement({ type: 'field', field: name, label: f ? f.label : name, x: pos.x, y: pos.y, w: 180, h: 28, fontSize: 14 });
    fieldSelect.value = '';
  });

  const addTextBtn = el('button', { class: 'btn btn-outline', onclick: () => {
    const pos = nextPos();
    addElement({ type: 'text', text: 'Double-click to edit', x: pos.x, y: pos.y, w: 200, h: 28, fontSize: 14 });
  } }, [el('i', { class: 'fa-solid fa-font' }), ' Add Text']);

  const addImageBtn = el('button', { class: 'btn btn-outline', onclick: () => fileInput.click() }, [el('i', { class: 'fa-solid fa-image' }), ' Add Image']);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const pos = nextPos();
      addElement({ type: 'image', src: reader.result, x: pos.x, y: pos.y, w: 140, h: 140 });
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  const saveBtn = el('button', { class: 'btn btn-primary', onclick: () => {
    const name = nameInput.value.trim();
    if (!name) { toast('Give the report a name first.'); return; }
    const elements = Array.from(canvas.children).map(readDesignerElement);
    const reports = loadSavedReports();
    const record = { id: (existingReport && existingReport.id) ? existingReport.id : ('rpt_' + Date.now()), name, pageSize: pageSizeKey, elements };
    const idx = reports.findIndex(r => r.id === record.id);
    if (idx >= 0) reports[idx] = record; else reports.push(record);
    if (saveSavedReportsList(reports)) { toast('Report saved.'); renderReportsList(); }
  } }, [el('i', { class: 'fa-solid fa-floppy-disk' }), ' Save Report']);

  const backBtn = el('button', { class: 'btn btn-outline', onclick: () => renderReportsList() }, 'Back to Reports');

  const toolbar = el('div', { class: 'toolbar', style: 'flex-wrap:wrap;gap:10px' }, [
    nameInput, pageSizeSelect, fieldSelect, addTextBtn, addImageBtn, fileInput,
    el('div', { style: 'flex:1' }),
    backBtn, saveBtn,
  ]);
  const hint = el('div', { style: 'text-align:center;color:#888;font-size:12px;margin-top:4px' },
    'Drag any element to reposition it. Images have a resize handle in the bottom-right corner. Double-click text to edit it. Hover an element for its delete (×) button.');

  content.appendChild(toolbar);
  content.appendChild(canvas);
  content.appendChild(hint);

  // Load existing elements, if editing a saved report.
  (existingReport ? existingReport.elements : []).forEach(data => addElement(data));
}

function buildDesignerElement(data) {
  const node = el('div', {
    class: 're-el',
    style: `position:absolute;left:${data.x}px;top:${data.y}px;` +
           (data.w ? `width:${data.w}px;` : '') + (data.h ? `min-height:${data.h}px;` : '') +
           `cursor:move;user-select:none;`,
  }, []);
  node.dataset.type = data.type;

  const delBtn = el('div', {
    class: 're-del-btn',
    style: 'position:absolute;top:-10px;right:-10px;width:18px;height:18px;border-radius:50%;background:#e53e3e;' +
           'color:#fff;font-size:12px;line-height:18px;text-align:center;cursor:pointer;display:none;z-index:5;',
    onclick: (e) => { e.stopPropagation(); node.remove(); },
  }, '×');
  node.addEventListener('mouseenter', () => { delBtn.style.display = 'block'; });
  node.addEventListener('mouseleave', () => { delBtn.style.display = 'none'; });

  if (data.type === 'field') {
    node.dataset.field = data.field;
    node.dataset.label = data.label;
    const inner = el('div', {
      style: `font-size:${data.fontSize || 14}px;color:#1a56db;font-style:italic;padding:3px 6px;` +
             `background:#eef3ff;border:1px dashed #93b4f5;border-radius:4px;white-space:nowrap;`,
    }, `{{${data.label}}}`);
    node.appendChild(inner);
  } else if (data.type === 'text') {
    const inner = el('div', {
      contenteditable: 'false',
      style: `font-size:${data.fontSize || 14}px;padding:3px 6px;min-width:40px;min-height:20px;` +
             `border:1px dashed transparent;`,
      ondblclick: (e) => { e.stopPropagation(); inner.contentEditable = 'true'; inner.style.borderColor = '#999'; inner.focus(); },
      onblur: () => { inner.contentEditable = 'false'; inner.style.borderColor = 'transparent'; },
    }, data.text || 'Text');
    node.appendChild(inner);
  } else if (data.type === 'image') {
    const img = el('img', {
      src: data.src, style: 'display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;',
    });
    node.style.width = (data.w || 140) + 'px';
    node.style.height = (data.h || 140) + 'px';
    node.appendChild(img);
    const handle = el('div', {
      style: 'position:absolute;right:-6px;bottom:-6px;width:14px;height:14px;background:#1a56db;' +
             'border-radius:3px;cursor:nwse-resize;z-index:5;',
    });
    node.appendChild(handle);
    makeResizable(handle, node);
  }

  node.appendChild(delBtn);
  makeDraggable(node);
  return node;
}

function readDesignerElement(node) {
  const x = parseInt(node.style.left) || 0;
  const y = parseInt(node.style.top) || 0;
  const type = node.dataset.type;
  if (type === 'field') {
    return { type, field: node.dataset.field, label: node.dataset.label, x, y };
  }
  if (type === 'text') {
    const inner = node.querySelector('div');
    return { type, text: inner ? inner.innerText : '', x, y };
  }
  if (type === 'image') {
    const img = node.querySelector('img');
    return { type, src: img ? img.src : '', x, y, w: node.offsetWidth, h: node.offsetHeight };
  }
  return { type, x, y };
}

// Generic free-drag: mousedown on the element (but not its delete button or
// an image's resize handle) starts tracking mouse movement on the whole
// document, so dragging still works even if the cursor briefly leaves the
// element while moving quickly.
function makeDraggable(node) {
  node.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('re-del-btn')) return;
    if (node.dataset.type === 'text' && document.activeElement === node.querySelector('[contenteditable="true"]')) return;
    if (e.target.style && e.target.style.cursor === 'nwse-resize') return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = parseInt(node.style.left) || 0;
    const startTop = parseInt(node.style.top) || 0;
    function onMove(ev) {
      node.style.left = Math.max(0, startLeft + (ev.clientX - startX)) + 'px';
      node.style.top = Math.max(0, startTop + (ev.clientY - startY)) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
function makeResizable(handle, targetNode) {
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = targetNode.offsetWidth, startH = targetNode.offsetHeight;
    function onMove(ev) {
      targetNode.style.width = Math.max(30, startW + (ev.clientX - startX)) + 'px';
      targetNode.style.height = Math.max(30, startH + (ev.clientY - startY)) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Printing: pick which candidate to print this report for, then render the
// same layout with {{field}} placeholders replaced by that candidate's real
// data, in a new tab, and trigger the browser's print dialog.
function openReportPrintPicker(report) {
  const dtEnt = entityByKey('datatable');
  const candidates = [...(cache[dtEnt.table] || [])].sort((a, b) => (b.DID ?? 0) - (a.DID ?? 0));
  const options = [el('option', { value: '' }, '— Select a candidate —')]
    .concat(candidates.map(c => el('option', { value: String(c[dtEnt.pk]) }, `${c.NAME || '(no name)'}${c.PASSPORTNO ? ' — ' + c.PASSPORTNO : ''}`)));
  const select = el('select', { style: 'width:100%' }, options);

  const overlay = el('div', { class: 'modal-overlay' }, [
    el('div', { class: 'modal-box', style: 'max-width:420px' }, [
      el('h3', {}, `Print "${report.name}" for…`),
      select,
      el('div', { style: 'margin-top:16px;display:flex;justify-content:flex-end;gap:8px' }, [
        el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: () => {
          const id = select.value;
          if (!id) { toast('Pick a candidate first.'); return; }
          const cand = candidates.find(c => String(c[dtEnt.pk]) === id);
          overlay.remove();
          printReportForCandidate(report, cand);
        } }, 'Print'),
      ]),
    ]),
  ]);
  document.body.appendChild(overlay);
}

// The "Visa Form KHI" button on the Candidates page just looks for a saved
// report named "Visa Form Karachi" / "Visa Form KHI" and opens the normal
// print picker for it — so design that report once via the Reports tab
// (any layout you like) and this button always prints the latest version.
function openVisaFormKhi() {
  const reports = loadSavedReports();
  const match = reports.find(r => /visa\s*form\s*(karachi|khi)/i.test(r.name));
  if (match) { openReportPrintPicker(match); return; }
  if (confirm('No "Visa Form Karachi" report has been designed yet. Design it now?')) {
    renderReportDesigner({ id: null, name: 'Visa Form Karachi', elements: [] });
  }
}

function printReportForCandidate(report, candidate) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const size = PAGE_SIZES[report.pageSize] || PAGE_SIZES.letter;
  const pieces = (report.elements || []).map(elData => {
    const base = `position:absolute;left:${elData.x}px;top:${elData.y}px;`;
    if (elData.type === 'field') {
      const val = candidate ? candidate[elData.field] : '';
      return `<div style="${base}font-size:14px;">${esc(val ?? '')}</div>`;
    }
    if (elData.type === 'text') {
      return `<div style="${base}font-size:14px;">${esc(elData.text)}</div>`;
    }
    if (elData.type === 'image') {
      return `<img src="${elData.src}" style="${base}width:${elData.w}px;height:${elData.h}px;object-fit:contain;">`;
    }
    return '';
  }).join('\n');

  // Explicitly declaring the physical page size (not "auto") is what stops
  // the browser from silently shrinking the page to fit its own guess of
  // the printable area — this is what was making the preview look smaller
  // than the design.
  const html = `<!DOCTYPE html><html><head><title>${esc(report.name)}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin:0; padding:0; }
      .page { position:relative; width:${size.w}px; height:${size.h}px; margin:0 auto; font-family:Arial,sans-serif; color:#111; }
      @page { size: ${size.cssSize}; margin: 0; }
      @media print {
        html, body { width:${size.w}px; height:${size.h}px; }
        .page { margin:0; }
      }
    </style></head><body>
    <div class="page">${pieces}</div>
    </body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}


checkSession();
