/* ==========================================================================
   RECRUIT EXPERT — App Logic
   ========================================================================== */
const CFG = window.APP_CONFIG || {};
const backendReady = !!(CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('YOUR-PROJECT') === -1 && window.supabase);
const sb = backendReady ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

const root = document.getElementById('root');
let currentUser = null;        // matched row from tbl_User after login

// tbl_User.Permission is a free-text column ("Admin" / "User" / "Developer"),
// so this is deliberately tolerant of case. Anyone with no Permission value
// set at all (every account created before this existed) is treated as the
// most permissive tier (Admin/Developer) — an existing account should keep
// working exactly as it did before this was added, not suddenly get locked
// out. Only an explicit "User" value is restricted.
//
// isAdmin(): can add/edit/delete data records (candidates, employers,
// categories, ledger entries, etc). True for Admin and Developer.
function isAdmin() {
  if (!currentUser) return false;
  const p = String(currentUser.Permission ?? '').trim().toLowerCase();
  return p === '' || p === 'admin' || p === 'developer';
}
// isDeveloper(): the three admin-tool tabs (Reports, User Accounts,
// Companies) — a narrower group than isAdmin() above. Admin can add/edit/
// delete data but does NOT get these; only Developer (and legacy blank-
// Permission accounts, same backward-compatibility reasoning as isAdmin())
// does.
function isDeveloper() {
  if (!currentUser) return false;
  const p = String(currentUser.Permission ?? '').trim().toLowerCase();
  return p === '' || p === 'developer';
}
let currentAgencyId = null;    // AGENCYID chosen at login — every query is scoped to this
let currentAgencyName = '';
let currentEntityKey = 'dashboard';
let searchTerm = '';
let listFilterValue = ''; // selected value for entities with a listFilter dropdown (e.g. Agent Ledger by Agent)
let listDateFrom = '';    // "dd/mm/yyyy" text — Agent/Employer Ledger date-range filter
let listDateTo = '';
let currentPage = 1;
let agentCheckFilter = ''; // '', 'true', or 'false' — the Active/Non Active buttons on the Agent list
let employerActiveFilter = ''; // same idea, Employer.ACTIVE
let categorySelectFilter = ''; // same idea, Category.SELECT
let printSelectedIds = new Set(); // checked rows for entities with ent.printReports (e.g. Employer)
const PAGE_SIZE = 100;
let cache = {};       // table -> rows (raw)
let refCache = {};    // table -> {id: displayLabel} for FK dropdowns/labels

// Registered once, not per-modal — checks at event time whether the Add
// Candidate form's status line is currently in the DOM, so it doesn't need
// cleanup when the modal closes. Fed by the (optional) KSA SmartForm Bridge
// browser extension's content-app.js in response to the "Get Data from KSA
// Tab" button below; does nothing if that extension isn't installed.
document.addEventListener('re-ksa-pull-result', (e) => {
  const msgEl = document.getElementById('re-ksa-status-msg');
  if (!msgEl) return;
  const detail = e.detail || {};
  msgEl.style.color = detail.ok ? '' : 'var(--danger)';
  msgEl.textContent = detail.message || '';
});

// Mirror image of the KSA listener above, but for pushing OUT to the BEOE
// (Bureau of Emigration & Overseas Employment) "oep-portal" emigrant
// registration page instead of pulling IN from KSA's SmartForm. Fed by the
// (optional) BEOE SmartForm Bridge browser extension's content-app.js in
// response to the "Send to BEOE Tab" button below; does nothing if that
// extension isn't installed.
document.addEventListener('re-beoe-push-result', (e) => {
  const msgEl = document.getElementById('re-beoe-status-msg');
  if (!msgEl) return;
  const detail = e.detail || {};
  msgEl.style.color = detail.ok ? '' : 'var(--danger)';
  msgEl.textContent = detail.message || '';
});

// Same again for the BEOE permission page, which is pushed from the
// Employer form rather than the Candidate one.
document.addEventListener('re-beoe-permission-push-result', (e) => {
  const msgEl = document.getElementById('re-beoe-perm-status-msg');
  if (!msgEl) return;
  const detail = e.detail || {};
  msgEl.style.color = detail.ok ? '' : 'var(--danger)';
  msgEl.textContent = detail.message || '';
});

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
// Prefills for a NEW record (never an existing one — editing always shows
// what's actually stored). A field's defaultValue in entities.js is used
// as-is, except for the special token "__TODAY__", which becomes today's
// date in dd/mm/yyyy — the same format these text date columns are shown
// and typed in, so it round-trips through formatDateDMY/parseStoredDate.
// Auto-transliteration for the Add Candidate / Add Employer forms below.
// Uses Google Translate's public "gtx" endpoint — the same one many
// no-signup translate widgets use. IMPORTANT CAVEAT: this is an unofficial,
// undocumented endpoint, not the official paid Google Cloud Translation
// API. It works with no API key or signup, which is why it's used here to
// get this working immediately, but Google could rate-limit, change, or
// block it without notice, and heavy production use of it isn't officially
// sanctioned. If this ever starts failing silently, that's almost certainly
// why — the fix at that point is to switch to the official Cloud
// Translation API (or Microsoft Translator, which has a comparable free
// tier), both of which need a real API key I'd wire in here in place of
// this URL. Also worth knowing: this transliterates NAMES phonetically,
// which Google Translate does reasonably well for proper nouns but not
// perfectly — treat the result as a fillable draft, not a guaranteed-correct
// value, which is why every use below only fills an EMPTY target field and
// never overwrites something already typed.
async function translateText(text, sourceLang, targetLang) {
  const q = String(text || '').trim();
  if (!q) return '';
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const data = await res.json();
    return (data[0] || []).map(chunk => chunk[0]).join('').trim();
  } catch (e) {
    console.error('Translation failed:', e);
    return '';
  }
}

// Wires an auto-fill: when sourceInput loses focus with new text, and
// targetInput is still empty, translate sourceInput's value and drop it
// into targetInput. Only runs for NEW records (existingRow is checked by
// the caller before wiring this at all) — never for edits, so it can't
// silently overwrite a real saved value.
function wireAutoTranslate(sourceInput, targetInput, sourceLang, targetLang) {
  if (!sourceInput || !targetInput) return;
  let lastValue = '';
  sourceInput.addEventListener('blur', async () => {
    const val = sourceInput.value.trim();
    if (!val || val === lastValue || targetInput.value.trim()) return;
    lastValue = val;
    const translated = await translateText(val, sourceLang, targetLang);
    if (translated && !targetInput.value.trim()) {
      targetInput.value = translated;
      targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function resolveDefaultValue(field) {
  if (field.defaultValue === undefined) return '';
  if (field.defaultValue === '__TODAY__') {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    // A real <input type="date"> only accepts yyyy-mm-dd and silently shows
    // nothing if handed anything else — so the format has to follow the
    // field's type, not one fixed shape. Text fields keep dd/mm/yyyy, which
    // is what the rest of this app stores and displays.
    if (field.type === 'date') return `${d.getFullYear()}-${mm}-${dd}`;
    return `${dd}/${mm}/${d.getFullYear()}`;
  }
  return field.defaultValue;
}

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

// The logged-in agency's own COMPANY record — already sitting in cache
// (preloadRefCaches fetches it, scoped to currentAgencyId, at every boot),
// so this never needs its own network call. Used for autofilled
// Agency/Owner/License fields, and below for per-agency report letterheads.
function currentAgencyRow() {
  const companyEnt = entityByKey('company');
  return (cache[companyEnt.table] || []).find(c => String(c[companyEnt.pk]) === String(currentAgencyId)) || null;
}

// CATEGORY.AgencyID is its own column, separate from EMPLOYER.AGENCYID, and
// on older/imported rows it's sometimes never been filled in — even though
// the category's EMPID clearly points at an employer that does belong to
// this agency. Filtering on CATEGORY.AgencyID alone was quietly hiding
// those rows, so the Categories list showed fewer records than Employers.
// This instead fetches employers for the current agency first, then pulls
// in any category matching EITHER its own AgencyID OR an EMPID in that
// employer list — same paging approach as fetchAllRows, just with an
// .or() filter instead of a plain .eq().
async function fetchAllRowsForCategory(ent) {
  if (currentAgencyId == null) return fetchAllRows(ent.table, ent.pk, null);
  const employerEnt = entityByKey('employer');
  let employerIds = [];
  if (employerEnt) {
    const { data: empData, error: empErr } = await fetchAllRows(employerEnt.table, null, employerEnt.agencyField);
    if (empErr) return { data: null, error: empErr };
    employerIds = (empData || []).map(r => r[employerEnt.pk]).filter(id => id != null);
  }
  // '-1' is a harmless placeholder EMPID that will never match a real row,
  // used only so the .in.() clause is never left syntactically empty.
  const idList = employerIds.length ? employerIds.join(',') : '-1';
  const orFilter = `AgencyID.eq.${currentAgencyId},EMPID.in.(${idList})`;
  const pageSize = 1000;
  let from = 0;
  let all = [];
  let guard = 0;
  while (guard++ < 200) {
    let query = sb.from(ent.table).select('*').or(orFilter);
    if (ent.pk) query = query.order(ent.pk, { ascending: false });
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
   Two layers, in order:

   1. DEVICE / SUPABASE AUTH GATE (renderAuthGate) — a real Supabase Auth
      sign-in (email + password against Supabase's own auth.users), done
      once per browser. supabase-js persists that session in localStorage on
      its own, so this normally only has to happen the first time the app is
      opened on a given PC/browser. This is what makes Row Level Security
      policies that require `auth.role() = 'authenticated'` work — without
      it, an anon-key request from a brand-new browser has no authenticated
      session yet, and Supabase quietly returns zero rows for anything RLS
      protects (no error — the dropdowns just look empty), which is exactly
      what was happening on a PC that had never signed in here before.
   2. STAFF / AGENCY LOGIN (renderLogin) — the existing per-person login
      against tbl_User plus an Agency picker, unchanged from before. This is
      the login staff actually see and use day to day.

   NOTE ON SECURITY: staff login checks the typed password against tbl_User
   by querying it directly with the public anon key. That means the anon key
   must be able to SELECT from tbl_User (to populate the username dropdown
   and to check the password), which in turn means anyone who opens dev
   tools and inspects network requests — or just calls the Supabase REST
   API directly with your published anon key — can read every username and
   password in that table. Requiring the Supabase Auth sign-in above (layer
   1) before any of that is reachable is a real improvement — an anon key on
   its own is no longer enough to read tbl_User if you write your RLS
   policies to require `auth.role() = 'authenticated'` — but it's still one
   shared device credential, not a per-person one, so this is fine for a
   low-stakes internal tool but not for anything you actually want to
   protect at the individual level. If these accounts guard sensitive data,
   ask me to switch staff login to a Supabase Edge Function (or a Postgres
   RPC using SECURITY DEFINER) that checks the password server-side and only
   returns a yes/no — never exposing the password column to the browser at
   all. */
async function checkSession() {
  if (!sb) { renderNoBackend(); return; }

  let hasAuthSession = false;
  try {
    const { data } = await sb.auth.getSession();
    hasAuthSession = !!(data && data.session);
  } catch (e) { hasAuthSession = false; }
  if (!hasAuthSession) { await renderAuthGate(); return; }

  const saved = loadSavedSession();
  if (saved && saved.user && saved.agencyId != null) {
    currentUser = saved.user;
    currentAgencyId = saved.agencyId;
    currentAgencyName = saved.agencyName || '';
    // A session saved by an OLDER version of this app (from before
    // agencyName was part of it) restores fine otherwise, but would show a
    // permanently blank agency name — since nothing else ever re-derives
    // it. Fix it once here, and re-save so it's correct from now on.
    if (!currentAgencyName) {
      try {
        const { data } = await sb.from('COMPANY').select('AGENCYNAME').eq('AGENCYID', currentAgencyId).limit(1);
        if (data && data[0]) {
          currentAgencyName = data[0].AGENCYNAME || '';
          saveSession({ user: currentUser, agencyId: currentAgencyId, agencyName: currentAgencyName });
        }
      } catch (e) { /* non-critical — worst case it just stays blank this time too */ }
    }
    await boot();
  } else {
    await renderLogin();
  }
}

// One-time-per-device Supabase Auth sign-in. This has nothing to do with
// which staff member or agency is using the app — it's what tells Supabase
// "this browser is allowed to talk to the database at all". Needs a real
// user created under Authentication -> Users in your Supabase project
// dashboard (any email/password works; it's shared across everyone using
// the app on this device, not a per-agency account).
async function renderAuthGate() {
  root.innerHTML = '';
  const emailInp = el('input', { type: 'email', autocomplete: 'username' });
  const passInp = el('input', { type: 'password', autocomplete: 'current-password' });
  const errBox = el('div', { class: 'login-err' }, '');
  const btn = el('button', {}, 'Connect');

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.textContent = '';
      if (!emailInp.value || !passInp.value) {
        errBox.textContent = 'Enter the email and password for this device\u2019s Supabase account.';
        return;
      }
      btn.disabled = true; btn.textContent = 'Connecting…';
      let result;
      try {
        result = await sb.auth.signInWithPassword({ email: emailInp.value, password: passInp.value });
      } catch (e) {
        result = { error: e };
      }
      btn.disabled = false; btn.textContent = 'Connect';
      if (result.error || !result.data || !result.data.session) {
        errBox.textContent = (result.error && result.error.message) || 'Could not sign in with those details.';
        return;
      }
      await renderLogin();
    },
  }, [
    el('label', {}, 'Email'), emailInp,
    el('label', {}, 'Password'), passInp,
    errBox, btn,
  ]);

  root.appendChild(el('div', { class: 'login-screen' }, el('div', { class: 'login-box' }, [
    el('div', { class: 'login-logo' }, 'RE'),
    el('h1', {}, CFG.APP_NAME || 'Recruit Expert'),
    el('p', { class: 'sub' }, 'Connect this device to Supabase to continue. You\u2019ll only need to do this once per browser.'),
    form,
  ])));
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

  // A network-level failure (blocked/broken CORS preflight, no internet,
  // DNS failure, etc.) can make these calls THROW instead of cleanly
  // returning { data: null, error }, depending on exactly how it fails —
  // catching both means a broken connection always shows a real, visible
  // message instead of silently leaving the dropdowns empty with no
  // explanation at all.
  let users = null, companies = null, loadError = null;
  try {
    const [userRes, coRes] = await Promise.all([
      sb.from('tbl_User').select('lngUserID, strUserName').order('strUserName', { ascending: true }),
      sb.from('COMPANY').select('AGENCYID, AGENCYNAME').order('AGENCYNAME', { ascending: true }),
    ]);
    users = userRes.data; companies = coRes.data;
    loadError = userRes.error || coRes.error || null;
  } catch (e) {
    loadError = e;
  }

  root.innerHTML = '';
  const errBox = el('div', { class: 'login-err' }, '');
  if (loadError) {
    errBox.style.cssText = 'background:#fee;border:1px solid #e53e3e;color:#c53030;padding:10px 12px;' +
      'border-radius:6px;margin-bottom:12px;font-size:13px;line-height:1.5;';
    errBox.innerHTML = `<b>Could not load the login list.</b><br>${(loadError.message || String(loadError))}<br>` +
      `This usually means this device/network can't reach the server right now — check your internet connection, ` +
      `or try a different network/browser if it keeps happening.`;
  }
  const retryBtn = loadError
    ? el('button', { type: 'button', class: 'btn btn-outline', style: 'margin-bottom:12px', onclick: () => renderLogin() }, 'Retry')
    : null;

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
    ...(retryBtn ? [retryBtn] : []),
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
    el('p', { class: 'sub', style: 'margin-top:14px;text-align:center;' }, [
      el('a', {
        href: '#', style: 'font-size:12px;',
        onclick: async (e) => { e.preventDefault(); await sb.auth.signOut(); await renderAuthGate(); },
      }, 'Not this device\u2019s Supabase account? Disconnect it'),
    ]),
  ])));
}

// Staff logout only ends the current person's session (tbl_User + chosen
// Agency) and returns to the staff/agency login above — it deliberately
// does NOT sign this device out of Supabase Auth, since that's a per-device
// setting shared by everyone using the app here, not something tied to one
// staff member. Use the "Disconnect it" link on the login screen for that.
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
    const { data, error } = key === 'category'
      ? await fetchAllRowsForCategory(ent)
      : await fetchAllRows(ent.table, null, ent.agencyField);
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
    // Reports is now visible to every role — Admin and User can view/print
    // existing reports, but can't design/edit/delete them (see
    // renderReportsList and renderReportDesigner's own isDeveloper()
    // guards below). User Accounts and Companies stay Developer-only, as
    // do Receivables, Transactions, and Accounts. Visa Expenses is hidden
    // from every role, Developer included — see isDeveloper() above.
    el('div', { class: 'sidebar-item', 'data-key': 'reports', onclick: () => selectEntity('reports') }, [
      el('i', { class: 'fa-solid fa-file-lines' }), 'Reports',
    ]),
    ...groups.flatMap(g => [
      el('div', { class: 'sidebar-group-label' }, g),
      ...window.ENTITIES.filter(e =>
        e.group === g && e.key !== 'visaexpense' &&
        (isDeveloper() || !['tbl_user', 'company', 'receivable', 'transition', 'account'].includes(e.key))
      ).map(e =>
        el('div', { class: 'sidebar-item', 'data-key': e.key, onclick: () => selectEntity(e.key) }, [
          el('i', { class: `fa-solid ${e.icon}` }), e.label,
        ])
      ),
    ]),
    el('div', { class: 'sidebar-footer' }, [
      el('button', { onclick: logout }, [el('i', { class: 'fa-solid fa-right-from-bracket' }), ' Log Out']),
    ]),
  ]);

  const quickSearchInput = el('input', {
    type: 'text',
    placeholder: 'Search by Name / Passport No / Enumber…',
    style: 'width:260px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:.85rem;',
  });
  const quickSearchGo = () => runQuickCandidateSearch(quickSearchInput.value);
  quickSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') quickSearchGo(); });
  const quickSearchBox = el('div', { style: 'position:relative;display:flex;align-items:center;gap:6px;' }, [
    quickSearchInput,
    el('button', { class: 'btn btn-outline btn-sm', onclick: quickSearchGo, title: 'Search candidates' }, [el('i', { class: 'fa-solid fa-magnifying-glass' })]),
  ]);

  const topbar = el('div', { class: 'topbar' }, [
    el('h2', { id: 'pageTitle' }, 'Dashboard'),
    el('div', { class: 'who' }, [
      quickSearchBox,
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

// Topbar quick search — separate from the full "Search Candidates" page,
// this is meant for a fast lookup from anywhere in the app: type a Name,
// Passport No, or Enumber and hit Enter, and a results list pops up over
// whatever page you're currently on. Always fetches fresh from Supabase
// (rather than trusting whatever's already in `cache`) since it needs to
// work correctly no matter which page you searched from — the DATATABLE
// cache is only guaranteed populated while you're actually on a DATATABLE
// page.
const QUICK_SEARCH_RESULT_FIELDS = [
  'NAME', 'FATHERSNAME', 'PASSPORTNO', 'Enumber', 'CATEGORY', 'REQTRADE',
  'STATUS', 'VISASTAMPED', 'TRAVELDATE', 'COID', 'REMARKS',
];
async function runQuickCandidateSearch(term) {
  const q = term.trim();
  if (!q) { toast('Type a name, passport number, or Enumber to search.'); return; }
  const dtEnt = entityByKey('datatable');
  const { data, error } = await fetchAllRows(dtEnt.table, dtEnt.pk, dtEnt.agencyField);
  if (error) { toast('Search failed: ' + error.message); return; }
  cache[dtEnt.table] = data || [];
  refCache[dtEnt.table] = {};
  (data || []).forEach(row => { refCache[dtEnt.table][row[dtEnt.pk]] = row[dtEnt.displayField] ?? `#${row[dtEnt.pk]}`; });

  const qLower = q.toLowerCase();
  const matches = (data || []).filter(r =>
    String(r.NAME ?? '').toLowerCase().includes(qLower) ||
    String(r.PASSPORTNO ?? '').toLowerCase().includes(qLower) ||
    String(r.Enumber ?? '').toLowerCase().includes(qLower)
  );
  showQuickSearchResults(dtEnt, q, matches);
}

function showQuickSearchResults(dtEnt, term, matches) {
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
  const fields = QUICK_SEARCH_RESULT_FIELDS.map(name => dtEnt.fields.find(f => f.name === name)).filter(Boolean);

  const body = matches.length
    ? el('div', { style: 'overflow:auto;max-height:65vh;' }, el('table', { class: 'data-table' }, [
        el('thead', {}, el('tr', {}, fields.map(f => el('th', {}, f.label)))),
        el('tbody', {}, matches.map(row => el('tr', {
          style: 'cursor:pointer;',
          title: 'Click to open this candidate',
          onclick: () => { overlay.remove(); openForm(dtEnt, row); },
        }, fields.map(f => el('td', {}, formatCell(f, row[f.name], dtEnt, row)))))),
      ]))
    : el('div', { class: 'empty-state' }, `No candidates matched "${term}".`);

  const box = el('div', { class: 'modal-box', style: 'max-width:1100px;width:95vw;' }, [
    el('button', { class: 'modal-close', onclick: () => overlay.remove() }, '✕'),
    el('h3', {}, `Search results for "${term}" (${matches.length})`),
    body,
  ]);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

async function selectEntity(key) {
  currentEntityKey = key;
  searchTerm = '';
  listFilterValue = '';
  listDateFrom = '';
  listDateTo = '';
  currentPage = 1;
  agentCheckFilter = '';
  employerActiveFilter = '';
  categorySelectFilter = '';
  printSelectedIds = new Set();
  setActiveSidebar(key);
  if (key === 'dashboard') { await showDashboard(); return; }
  if (key === 'searchform') { await renderSearchForm(); return; }
  if (key === 'reports') {
    await renderReportsList(); return;
  }
  if (key === 'tbl_user' && !isDeveloper()) {
    toast('User Accounts is only available to Developer accounts.'); await showDashboard(); return;
  }
  if (key === 'company' && !isDeveloper()) {
    toast('Companies is only available to Developer accounts.'); await showDashboard(); return;
  }
  if (['receivable', 'transition', 'account'].includes(key) && !isDeveloper()) {
    toast('This section is only available to Developer accounts.'); await showDashboard(); return;
  }
  if (key === 'visaexpense') {
    toast('Visa Expenses is no longer available.'); await showDashboard(); return;
  }
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

  const { data, error } = ent.key === 'category'
    ? await fetchAllRowsForCategory(ent)
    : await fetchAllRows(ent.table, ent.pk, ent.agencyField);
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
   any date box immediately re-filters the results below — no submit
   button. Two independent date ranges are offered: Travel Date and FSA
   Date (FSADate). */
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
  // Only "real" employers (ACTIVE = True) show up here — this is also what
  // hides test/junk rows like a stray "this is my first entry" employer:
  // it was never marked Active, so it simply won't be offered as an option
  // to pick anymore, rather than being pickable but always returning zero
  // matching candidates.
  const activeEmployers = (cache[employerEnt.table] || [])
    .filter(r => String(r.ACTIVE ?? '').trim().toLowerCase() === 'true')
    // Most recently added employer first (highest EMPID = newest row).
    .sort((a, b) => (b[employerEnt.pk] ?? 0) - (a[employerEnt.pk] ?? 0));
  const employerSelect = el('select', {}, [
    el('option', { value: '' }, '— Any Employer —'),
    ...activeEmployers.map(r => el('option', { value: r[employerEnt.pk] }, r[employerEnt.displayField] ?? `#${r[employerEnt.pk]}`)),
  ]);
  const statusSelect = el('select', {}, [
    el('option', { value: '' }, '— Any Status —'),
    ...statusValues.map(v => el('option', { value: v }, String(v))),
  ]);
  const dateFromInp = el('input', { type: 'text', placeholder: 'dd/mm/yyyy' });
  const dateToInp = el('input', { type: 'text', placeholder: 'dd/mm/yyyy' });
  const fsaDateFromInp = el('input', { type: 'text', placeholder: 'dd/mm/yyyy' });
  const fsaDateToInp = el('input', { type: 'text', placeholder: 'dd/mm/yyyy' });
  // Free-text search by Name, Passport No, or Enumber — combines (AND) with
  // every other filter below, same as they already combine with each other.
  const nameSearchInput = el('input', { type: 'text', placeholder: 'Search by Name, Passport No, or Enumber…' });

  // Checkbox selection, tracked by DID, so it survives filter/page changes —
  // select some candidates, adjust a filter, they're still selected.
  const selectedIds = new Set();

  // Report buttons, grouped in display order as requested (Karachi group,
  // then the second group, then anything else) but rendered as ONE row so
  // they sit side by side with no visual gap between the groups. Demand
  // Letter, Permission Exp, Permission Letter, and Undertaking Permission
  // moved to the Categories list instead (those are per-category documents,
  // not per-candidate) — see buildPrintReportsSection() and the 'category'
  // entity's printReports list.
  const ROW1_NAMES = ['visa form karachi', 'visa form isb', 'isb undertaking', 'isb barcodes'];
  const ROW2_NAMES = ['insurance form g', 'bc', 'fsa letter', 'fsa', 'nbp', 'service card'];
  const MOVED_TO_CATEGORY = ['demand letter', 'permission exp', 'permission letter', 'undertaking permission', 'exp trade'];
  const savedReports = loadSavedReports().filter(r => !MOVED_TO_CATEGORY.includes(r.name.trim().toLowerCase()));
  const getSelectedCandidates = () => (cache[dtEnt.table] || []).filter(row => selectedIds.has(row[dtEnt.pk]));
  const row1Reports = savedReports.filter(r => ROW1_NAMES.includes(r.name.trim().toLowerCase()));
  const row2Reports = savedReports.filter(r => ROW2_NAMES.includes(r.name.trim().toLowerCase()));
  const otherReports = savedReports.filter(r => !ROW1_NAMES.includes(r.name.trim().toLowerCase()) && !ROW2_NAMES.includes(r.name.trim().toLowerCase()));

  content.appendChild(buildReportButtonsRow([...row1Reports, ...row2Reports, ...otherReports], getSelectedCandidates));
  if (!savedReports.length) {
    content.appendChild(el('div', { class: 'toolbar' }, el('div', { class: 'empty-state', style: 'padding:8px 0;' }, 'No saved reports yet — build one in Reports first.')));
  }

  // "Selected" narrows the results to just the ticked rows; "Show All" drops
  // that narrowing again. It sits on TOP of the normal filters rather than
  // replacing them, and selectedIds is keyed by DID, so ticking rows, hitting
  // Selected, then changing a filter all behave sensibly together.
  let showOnlySelected = false;
  const selectedOnlyBtn = el('button', {
    class: 'btn btn-outline',
    onclick: () => { showOnlySelected = true; searchPage = 1; renderSearchResults(); },
  }, 'Selected');
  const showAllBtn = el('button', {
    class: 'btn btn-primary',
    onclick: () => { showOnlySelected = false; searchPage = 1; renderSearchResults(); },
  }, 'Show All');

  const filterBar = el('div', { class: 'toolbar', style: 'flex-wrap:wrap;gap:16px;align-items:flex-end;' }, [
    el('div', { class: 'f-field' }, [el('label', {}, 'Search (Name / Passport No / Enumber)'), nameSearchInput]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Agent'), agentSelect]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Employer'), employerSelect]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Status'), statusSelect]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Travel Date From'), dateFromInp]),
    el('div', { class: 'f-field' }, [el('label', {}, 'Travel Date To'), dateToInp]),
    el('div', { class: 'f-field' }, [el('label', {}, 'FSA Date From'), fsaDateFromInp]),
    el('div', { class: 'f-field' }, [el('label', {}, 'FSA Date To'), fsaDateToInp]),
    el('div', { class: 'f-field' }, [
      el('label', {}, 'Ticked rows'),
      el('div', { style: 'display:flex;gap:8px;' }, [selectedOnlyBtn, showAllBtn]),
    ]),
  ]);
  content.appendChild(filterBar);

  const resultsBody = el('div', { id: 'searchResultsBody' }, []);
  content.appendChild(resultsBody);

  let searchPage = 1;
  function matchesFilters(row) {
    if (showOnlySelected && !selectedIds.has(row[dtEnt.pk])) return false;
    const query = nameSearchInput.value.trim();
    if (query) {
      // Word-by-word, same convention as the rest of the app: every typed
      // word must be found somewhere across Name, Passport No, or Enumber —
      // not required to be contiguous or all in the same field.
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const haystacks = [row.NAME, row.PASSPORTNO, row.Enumber].map(v => String(v ?? '').toLowerCase());
      const allWordsMatch = words.every(w => haystacks.some(h => h.includes(w)));
      if (!allWordsMatch) return false;
    }
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
    const fsaFrom = parseInputDMY(fsaDateFromInp.value);
    const fsaTo = parseInputDMY(fsaDateToInp.value);
    if (fsaFrom || fsaTo) {
      const fsaRowDate = parseStoredDate(row.FSADate);
      if (!fsaRowDate) return false; // can't confirm it falls in range, so don't guess
      if (fsaFrom && fsaRowDate < fsaFrom) return false;
      if (fsaTo && fsaRowDate > fsaTo) return false;
    }
    return true;
  }

  function renderSearchResults() {
    const body = document.getElementById('searchResultsBody');
    body.innerHTML = '';
    // Keep the two buttons honest: live count, and whichever mode is active
    // is the highlighted one.
    selectedOnlyBtn.textContent = `Selected (${selectedIds.size})`;
    selectedOnlyBtn.className = showOnlySelected ? 'btn btn-primary' : 'btn btn-outline';
    showAllBtn.className = showOnlySelected ? 'btn btn-outline' : 'btn btn-primary';
    let rows = (cache[dtEnt.table] || []).filter(matchesFilters);
    // Most recently added first (highest DID = newest row) — matches how
    // the Category list already sorts, per request.
    rows = [...rows].sort((a, b) => (b.DID ?? 0) - (a.DID ?? 0));
    if (!rows.length) {
      const msg = showOnlySelected && selectedIds.size === 0
        ? 'No rows are ticked yet — tick some rows, or press "Show All".'
        : (showOnlySelected
            ? 'None of the ticked rows match the current filters — press "Show All" to see everything.'
            : 'No matching candidates.');
      body.appendChild(el('div', { class: 'data-card' }, el('div', { class: 'empty-state' }, msg)));
      return;
    }
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (searchPage > totalPages) searchPage = totalPages;
    if (searchPage < 1) searchPage = 1;
    const pageRows = rows.slice((searchPage - 1) * PAGE_SIZE, searchPage * PAGE_SIZE);

    const goToPage = (p) => { searchPage = p; renderSearchResults(); };
    body.appendChild(buildPaginationBar(rows.length, searchPage, totalPages, goToPage));

    const visibleFields = dtEnt.fields;
    const selectAllBox = el('input', { type: 'checkbox' });
    selectAllBox.checked = pageRows.length > 0 && pageRows.every(row => selectedIds.has(row[dtEnt.pk]));
    selectAllBox.addEventListener('change', () => {
      pageRows.forEach(row => {
        if (selectAllBox.checked) selectedIds.add(row[dtEnt.pk]);
        else selectedIds.delete(row[dtEnt.pk]);
      });
      renderSearchResults();
    });
    const thead = el('thead', {}, el('tr', {}, [
      el('th', {}, selectAllBox),
      ...visibleFields.map(f => el('th', {}, f.label)),
      el('th', {}, 'Actions'),
    ]));
    const tbody = el('tbody', {}, pageRows.map(row => {
      const rowCheckbox = el('input', { type: 'checkbox' });
      rowCheckbox.checked = selectedIds.has(row[dtEnt.pk]);
      rowCheckbox.addEventListener('change', () => {
        if (rowCheckbox.checked) selectedIds.add(row[dtEnt.pk]);
        else selectedIds.delete(row[dtEnt.pk]);
        selectAllBox.checked = pageRows.every(r => selectedIds.has(r[dtEnt.pk]));
        // Live count, without re-rendering the whole table — re-rendering on
        // every tick would yank rows out from under the cursor while in
        // Selected mode.
        selectedOnlyBtn.textContent = `Selected (${selectedIds.size})`;
      });
      return el('tr', {}, [
        el('td', {}, rowCheckbox),
        ...visibleFields.map(f => el('td', {}, formatCell(f, row[f.name], dtEnt, row))),
        el('td', {}, el('div', { class: 'row-actions' }, isAdmin() ? [
          el('button', { class: 'btn btn-outline btn-sm', onclick: () => openForm(dtEnt, row) }, 'Edit'),
          el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteRow(dtEnt, row) }, 'Delete'),
        ] : [el('span', { style: 'color:var(--text-mute);font-size:.78rem;' }, '—')])),
      ]);
    }));
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
  nameSearchInput.addEventListener('input', runSearch);
  [agentSelect, employerSelect, statusSelect].forEach(inp => inp.addEventListener('change', runSearch));
  [dateFromInp, dateToInp, fsaDateFromInp, fsaDateToInp].forEach(inp => inp.addEventListener('input', runSearch));

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
  // Shared by the Agent/Employer/Category lists below — three checkbox-ish
  // fields (Agent.CHECK, Employer.ACTIVE, Category.SELECT), same All/Active/
  // Non Active pattern for each. Rebuilds the whole toolbar (not just
  // refreshEntityListBody) on click so the pressed button's own highlight
  // (btn-primary vs btn-outline) updates immediately too, not just the
  // filtered rows below it.
  const activeFilterButtons = (getVal, setVal) => {
    const filterBtn = (value, label) => el('button', {
      class: getVal() === value ? 'btn btn-primary' : 'btn btn-outline',
      onclick: () => { setVal(value); currentPage = 1; renderEntityList(ent); },
    }, label);
    return [filterBtn('', 'All'), filterBtn('true', 'Active'), filterBtn('false', 'Non Active')];
  };
  const buttonRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
    ...(ent.key === 'agent' ? activeFilterButtons(() => agentCheckFilter, (v) => { agentCheckFilter = v; }) : []),
    ...(ent.key === 'employer' ? activeFilterButtons(() => employerActiveFilter, (v) => { employerActiveFilter = v; }) : []),
    ...(ent.key === 'category' ? activeFilterButtons(() => categorySelectFilter, (v) => { categorySelectFilter = v; }) : []),
    ...(ent.key === 'agentledger' || ent.key === 'employerledger'
      ? [
          el('button', { class: 'btn btn-outline', onclick: () => printLedgerReport(ent) }, [el('i', { class: 'fa-solid fa-print' }), ' Print Report']),
          // Bulk-deletes duplicates — an edit/delete action, so Admin-only,
          // same as the row-level Edit/Delete buttons and the Add button below.
          ...(isAdmin() ? [el('button', { class: 'btn btn-outline', onclick: () => renderDuplicatesPanel(ent) }, [el('i', { class: 'fa-solid fa-clone' }), ' Find Duplicate Entries'])] : []),
        ]
      : []),
    // The old "Visa Form KHI"/"Visa Form ISB" shortcut buttons that used to
    // sit here were removed — DATATABLE's own printReports row below the
    // search box (Visa Form Karachi / Visa Form ISB / ISB Undertaking /
    // ISB Barcodes, whichever of those actually exist as saved reports)
    // already covers the same two reports plus more, so having both was
    // redundant.
    el('button', { class: 'btn btn-outline', onclick: () => exportCsv(ent) }, [el('i', { class: 'fa-solid fa-download' }), ' Export Report (CSV)']),
    // Read-only accounts can search and print but not add records.
    ...(isAdmin() ? [el('button', { class: 'btn btn-primary', onclick: () => openForm(ent, null) }, [el('i', { class: 'fa-solid fa-plus' }), ` Add ${ent.label.replace(/s$/, '')}`])] : []),
  ]);
  // Entities with ent.printReports (an explicit include-list, e.g.
  // Categories and DATATABLE) or ent.printReportsExclude (everything EXCEPT
  // a named list) get a row of print buttons — check the rows you want with
  // the extra checkbox column (added in refreshEntityListBody below), then
  // click a report to print it for whichever rows are checked. Built here
  // (before the toolbar) so it can sit inside the toolbar itself, right
  // after the search box and before the rest of the buttons.
  const hasPrintReports = !!((ent.printReports && ent.printReports.length) || ent.printReportsExclude);
  let printReportsRow = null;
  if (hasPrintReports) {
    const matching = ent.printReports
      ? loadSavedReports().filter(r => ent.printReports.map(n => n.toLowerCase()).includes(r.name.trim().toLowerCase()))
      : loadSavedReports().filter(r => !ent.printReportsExclude.map(n => n.toLowerCase()).includes(r.name.trim().toLowerCase()));
    const getSelected = () => {
      const rows = (cache[ent.table] || []).filter(row => printSelectedIds.has(row[ent.pk]));
      if (ent.key !== 'category') return rows;
      // Group the checked categories by employer. Some reports (e.g. Demand
      // Letter) were built using the newer "EMPLOYER.NAMEOFEMPLOYER"-style
      // prefixed fields, which resolveFieldValue() can resolve straight off
      // a bare category row (it has EMPID/CATEGORYID right on it) — but
      // older reports (Permission Exp, Permission Letter, Undertaking
      // Permission) were built with the employer's field names used
      // directly (just "NAMEOFEMPLOYER", no prefix), which only resolves
      // if that field actually exists on the row being printed. So the
      // linked Employer's fields are flattened onto the row here too,
      // covering both conventions at once — that's what was missing for
      // every button except Demand Letter.
      //
      // An employer with MORE than one checked category becomes one
      // stand-in "candidate" with CATEGORYID: '__ALL__' — buildCandidatePage's
      // repeating-row logic sees that and lists every category in
      // __categoryRows__ on a single page (stacked downward from where
      // each CATEGORY.* field was placed in the designer), rather than
      // printing one page per category.
      const employerEnt = entityByKey('employer');
      const empRowFor = (empId) => (empId != null && empId !== '')
        ? (cache[employerEnt.table] || []).find(e => String(e[employerEnt.pk]) === String(empId))
        : null;
      const byEmployer = new Map();
      rows.forEach(catRow => {
        const key = (catRow.EMPID != null && catRow.EMPID !== '') ? String(catRow.EMPID) : `__none__${catRow[ent.pk]}`;
        if (!byEmployer.has(key)) byEmployer.set(key, []);
        byEmployer.get(key).push(catRow);
      });
      const grouped = [...byEmployer.values()].map(catRows => {
        if (catRows.length === 1) {
          const empRow = empRowFor(catRows[0].EMPID);
          return empRow ? { ...empRow, ...catRows[0] } : catRows[0];
        }
        const sorted = catRows.slice().sort((a, b) => String(a.CATEGORY ?? '').localeCompare(String(b.CATEGORY ?? '')));
        const empRow = empRowFor(sorted[0].EMPID);
        return { ...(empRow || {}), EMPID: sorted[0].EMPID, CATEGORYID: '__ALL__', __categoryRows__: sorted };
      });
      // Sort the resulting pages by employer so, with several employers
      // checked at once, their pages still come out grouped together.
      return grouped.sort((a, b) => String(a.EMPID ?? '').localeCompare(String(b.EMPID ?? ''), undefined, { numeric: true }));
    };
    if (matching.length) printReportsRow = buildReportButtonsRow(matching, getSelected);
  }
  // Search row sits flush against whatever comes below it — no vertical gap.
  const toolbar = el('div', {
    class: 'toolbar',
    style: 'display:flex;flex-direction:column;align-items:stretch;gap:0;',
  }, [
    searchControl,
    ...(printReportsRow ? [printReportsRow] : []),
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

  const visibleFields = ent.key === 'datatable'
    // Ordered by the whitelist itself, not by the order fields happen to sit
    // in entities.js. A name in the list that no longer exists as a field is
    // skipped rather than rendering a blank column.
    ? DATATABLE_LIST_FIELDS.map(name => ent.fields.find(f => f.name === name)).filter(Boolean)
    : ent.key === 'agent'
    ? AGENT_LIST_FIELDS.map(name => ent.fields.find(f => f.name === name)).filter(Boolean)
    : ent.key === 'employer'
    ? ent.fields.filter(f => !EMPLOYER_HIDDEN_LIST_FIELDS.includes(f.name))
    : ent.fields; // show every column, matching the Supabase table exactly
  const hasPrintReports = !!((ent.printReports && ent.printReports.length) || ent.printReportsExclude);
  let selectAllBox = null;
  if (hasPrintReports) {
    selectAllBox = el('input', { type: 'checkbox' });
    selectAllBox.checked = pageRows.length > 0 && pageRows.every(row => printSelectedIds.has(row[ent.pk]));
    selectAllBox.addEventListener('change', () => {
      pageRows.forEach(row => {
        if (selectAllBox.checked) printSelectedIds.add(row[ent.pk]);
        else printSelectedIds.delete(row[ent.pk]);
      });
      refreshEntityListBody(ent);
    });
  }
  const thead = el('thead', {}, el('tr', {}, [
    ...(hasPrintReports ? [el('th', {}, selectAllBox)] : []),
    ...visibleFields.map(f => el('th', {}, f.label)),
    el('th', {}, 'Actions'),
  ]));
  const tbody = el('tbody', {}, pageRows.map(row => {
    let rowCheckbox = null;
    if (hasPrintReports) {
      rowCheckbox = el('input', { type: 'checkbox' });
      rowCheckbox.checked = printSelectedIds.has(row[ent.pk]);
      rowCheckbox.addEventListener('change', () => {
        if (rowCheckbox.checked) printSelectedIds.add(row[ent.pk]);
        else printSelectedIds.delete(row[ent.pk]);
        if (selectAllBox) selectAllBox.checked = pageRows.every(r => printSelectedIds.has(r[ent.pk]));
      });
    }
    return el('tr', {}, [
      ...(hasPrintReports ? [el('td', {}, rowCheckbox)] : []),
      ...visibleFields.map(f => el('td', {}, formatCell(f, row[f.name], ent, row))),
      el('td', {}, el('div', { class: 'row-actions' }, isAdmin() ? [
        el('button', { class: 'btn btn-outline btn-sm', onclick: () => openForm(ent, row) }, 'Edit'),
        el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteRow(ent, row) }, 'Delete'),
      ] : [el('span', { style: 'color:var(--text-mute);font-size:.78rem;' }, '—')])),
    ]);
  }));
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

function formatCell(field, value, ent, row) {
  if (field.type === 'checkbox') {
    // Editable right here when we know which row/table to write back to
    // (both list views pass this) AND the account is Admin — this toggle
    // writes straight to the database on click, bypassing openForm's own
    // guard entirely, so it needs its own isAdmin() check.
    const canEdit = !!(ent && row) && isAdmin();
    const cb = el('input', {
      type: 'checkbox',
      style: 'width:16px;height:16px;accent-color:#1a56db;vertical-align:middle;' + (canEdit ? 'cursor:pointer;' : 'cursor:default;'),
    });
    cb.checked = value === true;
    cb.disabled = !canEdit;
    if (canEdit) {
      cb.addEventListener('change', async () => {
        const newVal = cb.checked;
        cb.disabled = true;
        const { error } = await sb.from(ent.table).update({ [field.name]: newVal }).eq(ent.pk, row[ent.pk]);
        cb.disabled = false;
        if (error) {
          cb.checked = !newVal; // revert the tick — the save didn't actually happen
          toast(`Could not update ${field.label}: ${error.message}`);
          return;
        }
        row[field.name] = newVal; // keep the in-memory row (and cache) in sync, no full reload needed
        toast(`${field.label} updated.`);
      });
    }
    return cb;
  }
  // strUserPassword shows masked in the table too, not just the form —
  // otherwise every password sits in plain text on the User Accounts list.
  if (ent && ent.key === 'tbl_user' && field.name === 'strUserPassword') {
    return (value === null || value === undefined || value === '') ? '—' : '••••••••';
  }
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
  // Match Supabase's own Table Editor order exactly: ascending by DID.
  if (ent.key === 'datatable') rows = [...rows].sort((a, b) => (a.DID ?? 0) - (b.DID ?? 0));
  // Categories: grouped by employer, most recently added employer first
  // (highest EMPID on top), and within the same employer, most recently
  // added category first (CATEGORYID as the tiebreaker).
  if (ent.key === 'category') {
    rows = [...rows].sort((a, b) =>
      ((b.EMPID ?? 0) - (a.EMPID ?? 0)) || ((b.CATEGORYID ?? 0) - (a.CATEGORYID ?? 0)));
  }
  // NOTE: categories linked to an inactive employer used to be hidden here
  // too ("same rule as the dropdowns") — but that was quietly cutting the
  // Category list down to a fraction of what's actually in the table (28
  // shown, in one case, because most employers on file are marked
  // inactive). The list should show everything for the agency regardless
  // of the linked employer's active flag; dropdown pickers (openForm's FK
  // selects) still apply isCategoryEmployerActive on their own, since
  // steering new records away from an inactive employer is a different
  // concern from hiding records you're trying to view, manage, or print.
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
  // Active / Non Active buttons on the Agent list, filtering on CHECK.
  if (ent.key === 'agent' && agentCheckFilter) {
    rows = rows.filter(row => row.CHECK === (agentCheckFilter === 'true'));
  }
  // Same idea for Employer.ACTIVE and Category.SELECT — both are
  // staticselect "True"/"False" fields rather than a real boolean checkbox
  // like Agent.CHECK, so compared as text (tolerant of either an actual
  // boolean or the literal string coming back from Supabase) rather than
  // with a strict === true/false check.
  if (ent.key === 'employer' && employerActiveFilter) {
    rows = rows.filter(row => (String(row.ACTIVE ?? '').trim().toLowerCase() === 'true') === (employerActiveFilter === 'true'));
  }
  if (ent.key === 'category' && categorySelectFilter) {
    rows = rows.filter(row => (String(row.SELECT ?? '').trim().toLowerCase() === 'true') === (categorySelectFilter === 'true'));
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
  // DATATABLE -> Agent: show the agent's name, agency, and passport no
  // together, so agents with similar names (or the same agency) can still
  // be told apart in the dropdown.
  'datatable.COID': (row) => {
    const parts = [row.AGENTNAME || '(no name)'];
    if (row.AGENCY) parts.push(row.AGENCY);
    if (row.passportno) parts.push(`Passport: ${row.passportno}`);
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
  ARBICTRADE: 'CATEGORYARBIC',
};
const DATATABLE_EMPLOYER_AUTOFILL = {
  NAMEOFEMPLOYER: 'NAMEOFEMPLOYER', ADDRESSOFEMPLOYER: 'ADDRESSOFEMPLOYER', VISANO: 'VISANO',
  IDNO: 'IDNO', VISADATE: 'VISADATE', DEMAND: 'DEMAND', CITY: 'CITY', VISATYPE: 'VISATYPE',
  FileNo: 'FILENO', Embassyin: 'EMBASSYIN', ARBICCOMPANY: 'ARBICCOMPANY',
};
const DATATABLE_AGENCY_AUTOFILL = {
  NAMEOFEGENCY: 'AGENCYNAME', NAMEOFOWNER: 'NAMEOFOWNER', LICNO: 'LICENCENUMBER',
};

// Same idea, for EMPLOYER's own Name of Agency / Name of Owner / License No
// fields — always the logged-in agency's own COMPANY record. Keys here are
// EMPLOYER's actual DB column names, which came out lowercase (and "license
// no" with a literal space) since they were added via the table editor
// without quoting — not the same casing as DATATABLE's equivalent columns.
const EMPLOYER_AGENCY_AUTOFILL = {
  nameofagency: 'AGENCYNAME', nameofowner: 'NAMEOFOWNER', 'license no': 'LICENCENUMBER',
};

// Fields left out of the DATATABLE Add/Edit form entirely (not needed there)
// — still normal DB columns, so nothing else about them changes.
const DATATABLE_FORM_HIDDEN_FIELDS = [
  'NAMEOFOWNER', 'NAMEOFEGENCY', 'LICNO', 'LICENSE NO', 'EMPID',
  'ENDORSED', 'SUBMIT', 'V Barcode', 'E Barcode', 'Open',
  'MEDICALNAME', 'AUTHORIZATION', 'GMCA', 'Photo',
];

// The opposite direction: fields hidden from the Candidates LIST/grid view
// only — still fully shown and editable in the Add/Edit form. Add field
// names here to declutter the list table without losing access to the data.
// Which columns the DATATABLE list (the "front table") shows, in this exact
// order. This is a whitelist — anything not named here simply isn't shown as
// a column. It affects the LIST ONLY: the Add/Edit form still shows every
// field, laid out by DATATABLE_FORM_SECTIONS below.
const DATATABLE_LIST_FIELDS = [
  'COID',
  'NAMEOFEMPLOYER',
  'NAME',
  'FATHERSNAME',
  'PASSPORTNO',
  'VISANO',
  'Enumber',
  'CATEGORY',
  'STATUS',
  'VISASTAMPED',
  'TRAVELDATE',
  'Embassyin',
  'Mobile',
  'SALARY',
  'DATE',
  'FSANo',
  'FSADate',
  'REMARKS',
];

// LIST ONLY, same as DATATABLE_LIST_FIELDS above — Check moved to the front
// so it's the first, most-scannable column; the Add/Edit Agent form is
// untouched and keeps its own original field order.
const AGENT_LIST_FIELDS = ['CHECK', 'AGENTNAME', 'AGENCY', 'RESIDENT', 'TEL', 'MOB', 'EMAIL', 'trade', 'passportno', 'status', 'AGENCYID'];

// The Employer list, unlike DATATABLE above, hides just a few columns
// instead of naming everything it keeps — a denylist rather than an
// allowlist. Also LIST ONLY: the Add/Edit Employer form still shows every
// field.
const EMPLOYER_HIDDEN_LIST_FIELDS = [
  'nameofagency',
  'nameofowner',
  'license no',
  'VISATYPE',
  'CITY',
  'ATTACHMENT',
  'PERMISSIONNO',
  'DATED',
];

// DATATABLE's Add/Edit form has 70+ fields — grouped into named sections
// (in this order) so it reads as a form instead of a wall of boxes. Any
// field not listed in any group below (and not in the hidden list above)
// still shows up, in a final "Other Details" section, so nothing from
// entities.js is ever silently dropped.
const DATATABLE_FORM_SECTIONS = [
  {
    title: 'Agent, Name & Employer Details',
    fields: [
     'AGENCYID', 'DATE', 'COID', 'CATEGORYID', 'NAMEOFEMPLOYER','ARBICCOMPANY', 'ARBICTRADE',
         'CATEGORY', 
      'ADDRESSOFEMPLOYER', 'VISANO', 'IDNO', 'VISADATE', 'DEMAND', 'CITY',
      'VISATYPE', 'FileNo', 'Embassyin', 'SALARY', 'QUANTITY', 'REQTRADE',
      'CONTRACT', 'PERMISSIONNO', 'DATED',
    ],
  },
  {
    title: 'Candidate Details',
    fields: [
      'NAME', 'FATHERSNAME', 'ARBICNAME', 'ARBICFATHERNAME', 'PASSPORTNO', 'DATEOFBIRTH', 'PLACEOFBIRTH',
      'DATEOFISSUE', 'DATEOFEXPIRY', 'ADDRESS', 'COUNTRY', 'DISTRICT',
      'Enumber', 'SEX', 'MERITALSTATUS', 'RELIGION',
      'NIC', 'PLACEOFISSUE', 'Qualification',
       'Select',
      'SECT', 'NICISSUEDATE', 'STICKERNO', 'Mobile',
    ],
  },
  {
    title: 'Status & Travel',
    fields: [
      'STATUS', 'VISASTAMPED', 'FSANo', 'FSADate', 'TRAVELDATE',
      'PURPOSE', 'TRAVELBY', 'FLIGHT', 'DESTINATION', 'Ticket No',
    ],
  },
  {
    title: 'Insurance Person Details',
    fields: ['NAMEOFINSURANCE', 'AGEOFINSURANCE', 'RELATIONOFINSURANCE', 'ADDRESSOFINSURANCE', 'NICOFINSURANCE'],
  },
];

async function openForm(ent, existingRow) {
  // Read-only accounts (Permission != Admin) can search and print but never
  // add/edit/delete — this is the single choke point every "Add"/"Edit"
  // button below goes through, so guarding here covers all of them even if
  // a button somewhere is missed.
  if (!isAdmin()) { toast('Your account is read-only — adding and editing records requires an Admin account.'); return; }
  // make sure dropdown ref data is fresh
  await preloadRefCaches();

  const NO_CLICK_OUTSIDE_CLOSE = ['datatable', 'employer', 'category', 'agent'];
  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => {
      // These forms take real effort to fill in — an accidental click on
      // the dimmed background (or a stray click while the cursor passes
      // over it) shouldn't lose everything typed so far. They only close
      // via the ✕ / Cancel buttons or after a successful Save. Other,
      // shorter forms keep the old click-outside-to-close behavior.
      if (e.target === overlay && !NO_CLICK_OUTSIDE_CLOSE.includes(ent.key)) overlay.remove();
    },
  });
  const inputs = {};
  const fieldNodesByName = {};

  const fieldNodes = ent.fields.map(f => {
    let inputEl;
    let extraNode = null;
    const val = existingRow ? existingRow[f.name] : resolveDefaultValue(f);
    const isAgencyField = ent.agencyField && f.name === ent.agencyField;
    if (f.type === 'textarea') {
      inputEl = el('textarea', {}, '');
      inputEl.value = val ?? '';
    } else if (f.type === 'checkbox') {
      // Real bool columns (e.g. Employer.ACTIVE) round-trip as actual JS
      // true/false from Supabase, not the strings "True"/"False" — which is
      // exactly what a checkbox's .checked wants, no string-matching needed.
      inputEl = el('input', { type: 'checkbox', style: 'width:18px;height:18px;margin-top:6px;accent-color:#1a56db;' });
      inputEl.checked = val === true;
    } else if (f.type === 'staticselect') {
      // A fixed list of choices defined right on the field (f.options) —
      // not looked up from another table, e.g. Active: True/False.
      const options = [el('option', { value: '' }, '— none —'), ...f.options.map(o => el('option', { value: o }, o))];
      inputEl = el('select', {}, options);
      inputEl.value = val ?? '';
    } else if (f.type === 'textlist') {
      // A plain text input backed by a native browser dropdown of every
      // distinct, non-blank value already used for THIS column in THIS
      // table — e.g. Category's own Category/Categoryarbic/Reqtrade, so
      // "LABOUR" doesn't slowly end up entered five slightly different
      // ways. Still a free-text field underneath (a <datalist> only
      // suggests, it never restricts), so a genuinely new value can
      // always be typed — this discourages accidental duplicates without
      // hard-locking out new ones.
      const listId = `dl_${ent.key}_${f.name}`;
      const distinct = [...new Set(
        (cache[ent.table] || [])
          .map(r => (r[f.name] == null ? '' : String(r[f.name]).trim()))
          .filter(v => v !== '')
      )].sort((a, b) => a.localeCompare(b));
      extraNode = el('datalist', { id: listId }, distinct.map(v => el('option', { value: v }, '')));
      inputEl = el('input', { type: 'text', list: listId });
      inputEl.value = val ?? '';
    } else if (f.type === 'select') {
      const refEnt = entityByKey(f.ref);
      const labelFn = CUSTOM_OPTION_LABELS[`${ent.key}.${f.name}`];
      const options = [el('option', { value: '' }, '— none —')];
      const currentVal = val != null ? String(val) : '';
      // Employer picker: most recently added first (highest EMPID on top).
      // Category picker (e.g. DATATABLE's Categoryid dropdown): grouped by
      // employer the same way the Category list now is — most recently
      // added employer's categories on top, newest category within that
      // employer first.
      let refRows = cache[refEnt.table] || [];
      if (refEnt.key === 'employer') {
        refRows = [...refRows].sort((a, b) => (b[refEnt.pk] ?? 0) - (a[refEnt.pk] ?? 0));
      } else if (refEnt.key === 'category') {
        refRows = [...refRows].sort((a, b) =>
          ((b.EMPID ?? 0) - (a.EMPID ?? 0)) || ((b.CATEGORYID ?? 0) - (a.CATEGORYID ?? 0)));
      }
      refRows.forEach(r => {
        // Don't offer an inactive employer as a choice — but if this record
        // is already pointing at one (e.g. it was set before the employer
        // was deactivated), keep showing it so editing doesn't silently
        // blank the field out from under you.
        if (refEnt.key === 'employer' && r.ACTIVE === false && String(r[refEnt.pk]) !== currentVal) return;
        if (refEnt.key === 'category' && !isCategoryEmployerActive(r) && String(r[refEnt.pk]) !== currentVal) return;
        // Same idea for Agent (COID) — only Check = true agents are offered,
        // unless this record already points at one that's since been
        // unchecked, in which case keep showing it rather than blanking it.
        if (refEnt.key === 'agent' && r.CHECK !== true && String(r[refEnt.pk]) !== currentVal) return;
        const label = labelFn ? labelFn(r) : (r[refEnt.displayField] ?? ('#' + r[refEnt.pk]));
        options.push(el('option', { value: r[refEnt.pk] }, String(label)));
      });
      inputEl = el('select', {}, options);
      // Lock this record to the logged-in agency: pre-fill and disable so it
      // can't be reassigned to a different agency while viewing this one.
      inputEl.value = isAgencyField ? String(currentAgencyId ?? '') : (val ?? '');
      if (isAgencyField) inputEl.disabled = true;
    } else if (f.type === 'dmydate') {
      // Still a plain text column underneath (formatDateDMY/parseStoredDate
      // elsewhere already read dd/mm/yyyy text fine) — this just actively
      // helps TYPE it that way instead of only hoping for it: auto-inserts
      // the two "/" separators as digits go in, and flags (border colour
      // only, never blocks saving — an unusual real date shouldn't get
      // stuck) anything left that isn't a full dd/mm/yyyy on blur.
      inputEl = el('input', { type: 'text', placeholder: 'dd/mm/yyyy', maxLength: '10' });
      inputEl.value = val ?? '';
      inputEl.addEventListener('input', () => {
        const digits = inputEl.value.replace(/\D/g, '').slice(0, 8);
        let out = digits.slice(0, 2);
        if (digits.length > 2) out += '/' + digits.slice(2, 4);
        if (digits.length > 4) out += '/' + digits.slice(4, 8);
        inputEl.value = out;
      });
      inputEl.addEventListener('blur', () => {
        const ok = inputEl.value === '' || /^\d{2}\/\d{2}\/\d{4}$/.test(inputEl.value);
        inputEl.style.borderColor = ok ? '' : 'var(--danger)';
      });
    } else {
      // strUserPassword masks like a real password field — everything else
      // in this generic renderer is untouched.
      const inputType = (ent.key === 'tbl_user' && f.name === 'strUserPassword')
        ? 'password'
        : (f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text');
      inputEl = el('input', { type: inputType });
      if (f.type === 'number') inputEl.step = 'any';
      inputEl.value = val ?? '';
    }
    inputs[f.name] = inputEl;
    // Stable hook so outside tooling (e.g. the optional KSA SmartForm bridge
    // extension) can find specific fields reliably — the field's own JS
    // object key isn't visible in the DOM otherwise.
    inputEl.setAttribute('data-field', f.name);
    const wrapClass = (f.type === 'textarea') ? 'f-field full' : 'f-field';
    const node = el('div', { class: wrapClass }, [
      el('label', {}, f.label + (f.required ? ' *' : '') + (isAgencyField ? ' (locked to current agency)' : '')),
      inputEl,
      ...(extraNode ? [extraNode] : []),
    ]);
    fieldNodesByName[f.name] = node;
    return node;
  });

  // Auto-transliteration, Add mode only (never on an edit — see
  // wireAutoTranslate's own comment for why): typing a Name/Father's Name
  // and tabbing out fills the matching Arabic field if it's still empty;
  // typing an Arabic company name does the same into Name of Employer.
  if (!existingRow) {
    if (ent.key === 'datatable') {
      wireAutoTranslate(inputs.NAME, inputs.ARBICNAME, 'en', 'ur');
      wireAutoTranslate(inputs.FATHERSNAME, inputs.ARBICFATHERNAME, 'en', 'ur');
    }
    if (ent.key === 'employer') {
      wireAutoTranslate(inputs.ARBICCOMPANY, inputs.NAMEOFEMPLOYER, 'ar', 'en');
    }
  }

  // Category auto-fill: picking (or typing) a Category name that already
  // exists elsewhere fills in that same category's own
  // Categoryarbic/Reqtrade, from whichever existing row used that name
  // most recently — saves re-typing the Arabic translation and trade
  // every time the same category comes up again. Wired as a live listener
  // on Category only, same reasoning as the Datatable Status auto-set
  // elsewhere: it only fires while Category is actually being typed into,
  // so opening an existing category to edit something unrelated never
  // silently rewrites its Categoryarbic/Reqtrade.
  if (ent.key === 'category' && inputs.CATEGORY) {
    const applyCategoryFieldAutofill = () => {
      const typed = String(inputs.CATEGORY.value ?? '').trim().toLowerCase();
      if (!typed) return;
      const match = (cache[ent.table] || [])
        .filter(r => String(r.CATEGORY ?? '').trim().toLowerCase() === typed)
        .sort((a, b) => (b.CATEGORYID ?? 0) - (a.CATEGORYID ?? 0))[0];
      if (!match) return;
      if (inputs.CATEGORYARBIC && String(match.CATEGORYARBIC ?? '').trim() !== '') {
        inputs.CATEGORYARBIC.value = match.CATEGORYARBIC;
      }
      if (inputs.REQTRADE && String(match.REQTRADE ?? '').trim() !== '') {
        inputs.REQTRADE.value = match.REQTRADE;
      }
    };
    inputs.CATEGORY.addEventListener('input', applyCategoryFieldAutofill);
    inputs.CATEGORY.addEventListener('change', applyCategoryFieldAutofill);
  }

  // Section headings + a wider grid (repeat(auto-fill, minmax(...))) so more
  // fields sit side by side on a wide screen instead of stacking in one
  // narrow column — set inline so it applies regardless of the shared
  // .form-grid rule elsewhere.
  const sectionGrid = (nodes) => el('div', {
    class: 'form-grid',
    style: 'display:grid;grid-template-columns:repeat(auto-fill, minmax(230px, 1fr));gap:14px 20px;',
  }, nodes);
  const sectionHeading = (title) => el('h4', {
    style: 'margin:0 0 10px;padding-bottom:6px;border-bottom:2px solid var(--border);font-size:.85rem;letter-spacing:.03em;text-transform:uppercase;color:var(--text-mute);',
  }, title);

  let fieldsArea;
  if (ent.key === 'datatable') {
    const usedNames = new Set(DATATABLE_FORM_HIDDEN_FIELDS);
    const sectionEls = DATATABLE_FORM_SECTIONS.map(sec => {
      const nodes = sec.fields.map(name => { usedNames.add(name); return fieldNodesByName[name]; }).filter(Boolean);
      if (!nodes.length) return null;
      return el('div', { class: 'form-section', style: 'margin-bottom:20px;' }, [sectionHeading(sec.title), sectionGrid(nodes)]);
    }).filter(Boolean);

    // Anything in entities.js not explicitly grouped above (still shown —
    // never silently dropped) — in its original field order.
    const restNodes = ent.fields.filter(f => !usedNames.has(f.name)).map(f => fieldNodesByName[f.name]).filter(Boolean);
    if (restNodes.length) {
      sectionEls.push(el('div', { class: 'form-section' }, [sectionHeading('Other Details'), sectionGrid(restNodes)]));
    }
    fieldsArea = el('div', {}, sectionEls);
  } else {
    fieldsArea = el('div', { class: 'form-grid' }, fieldNodes);
  }

  if (ent.key === 'datatable') {
    // Name of Agency / Name of Owner / Lic No: always the logged-in
    // agency's own COMPANY record, not something entered per-row.
    const myCompany = currentAgencyRow();
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
      // EMPID itself — same derived/locked treatment as the rest of the
      // employer-sourced fields above, so the candidate's own EMPID always
      // matches the employer that its Category actually belongs to.
      if (inputs.EMPID) {
        inputs.EMPID.value = empRow ? String(empRow[empEnt.pk] ?? '') : '';
        inputs.EMPID.disabled = true;
      }
    };

    if (inputs.CATEGORYID) {
      inputs.CATEGORYID.addEventListener('change', () => applyCategoryAutofill(inputs.CATEGORYID.value));
      // Run once on open too — covers both a fresh Add (blank, so derived
      // fields just end up blank+locked) and editing an existing row
      // (so the derived fields reflect the currently-linked category /
      // employer rather than whatever was saved historically).
      applyCategoryAutofill(inputs.CATEGORYID.value);
    }

    // Agent (Coid) -> Mobile / Passport No: a convenience default only,
    // NOT a locked/derived field like the autofills above — Mobile and
    // Passport No are the candidate's own editable details, so this only
    // fills them in while they're still blank (a fresh Add, agent picked
    // first) and never overwrites something already typed in, including on
    // a later change of agent.
    if (inputs.COID) {
      inputs.COID.addEventListener('change', () => {
        const agentEnt = entityByKey('agent');
        const agentRow = (cache[agentEnt.table] || [])
          .find(a => String(a[agentEnt.pk]) === String(inputs.COID.value));
        if (!agentRow) return;
        if (inputs.Mobile && !inputs.Mobile.value.trim() && agentRow.MOB) inputs.Mobile.value = agentRow.MOB;
        if (inputs.PASSPORTNO && !inputs.PASSPORTNO.value.trim() && agentRow.passportno) inputs.PASSPORTNO.value = agentRow.passportno;
      });
    }

    // Status auto-set: Visastamped/FSANo/FSADate/Traveldate each imply a
    // specific Status. Checked most-advanced-stage-first (Traveled is
    // further along than merely Stamped) so that whichever stage the
    // candidate has actually reached wins if more than one of the four
    // happens to be filled in. Wired as live listeners on those four
    // fields only — opening an old record and editing something unrelated
    // never touches its Status; it only changes here while you're
    // actually editing one of these four during this session, otherwise
    // Status stays exactly whatever was selected before.
    if (inputs.STATUS) {
      const STATUS_AUTO_RULES = [
        ['TRAVELDATE', 'Traveled'],
        ['FSADate', 'FSA Regestered'], // matches the exact (misspelled) option in entities.js
        ['FSANo', 'FSA Pending'],
        ['VISASTAMPED', 'Stamped'],
      ];
      const recomputeStatus = () => {
        const hit = STATUS_AUTO_RULES.find(([fieldName]) =>
          inputs[fieldName] && String(inputs[fieldName].value ?? '').trim() !== '');
        if (hit) inputs.STATUS.value = hit[1];
      };
      STATUS_AUTO_RULES.forEach(([fieldName]) => {
        if (inputs[fieldName]) inputs[fieldName].addEventListener('input', recomputeStatus);
      });
    }
  }

  if (ent.key === 'employer') {
    // Name of Agency / Name of Owner / License No on EMPLOYER: always the
    // logged-in agency's own COMPANY record, same as on DATATABLE — not
    // something typed in per-employer.
    const myCompany = currentAgencyRow();
    Object.entries(EMPLOYER_AGENCY_AUTOFILL).forEach(([empField, coField]) => {
      if (!inputs[empField]) return;
      inputs[empField].value = myCompany ? (myCompany[coField] ?? '') : '';
      inputs[empField].disabled = true;
    });
  }

  // "Get Data from KSA Tab" — only on a fresh Add, and only does anything
  // when clicked. Nothing is read from any other tab automatically; this
  // just asks the (optional) KSA SmartForm Bridge browser extension to
  // look at whatever visa.mofa.gov.sa tab you currently have open and,
  // if it finds one, report back what's on it right now. Available on both
  // the DATATABLE (candidate) and EMPLOYER forms — the extension itself
  // figures out which one applies to based on the fields it finds on the
  // page, and content-app.js only fills whichever of those two forms is
  // actually open right now.
  let ksaPullBlock = null;
  if ((ent.key === 'datatable' || ent.key === 'employer') && !existingRow) {
    const ksaStatusMsg = el('div', { id: 're-ksa-status-msg', style: 'font-size:.78rem;color:var(--text-mute);margin-top:6px;' }, '');
    const ksaBtn = el('button', {
      type: 'button', class: 'btn btn-outline btn-sm',
      onclick: () => {
        if (document.body.getAttribute('data-re-ksa-bridge') !== 'ready') {
          ksaStatusMsg.style.color = 'var(--danger)';
          ksaStatusMsg.textContent = "The KSA SmartForm Bridge extension isn't installed or enabled in this browser.";
          return;
        }
        ksaStatusMsg.style.color = '';
        ksaStatusMsg.textContent = 'Looking for an open KSA SmartForm tab…';
        document.dispatchEvent(new CustomEvent('re-ksa-pull-request'));
      },
    }, [el('i', { class: 'fa-solid fa-arrows-rotate' }), ' Get Data from KSA Tab']);

    const ksaDescription = ent.key === 'employer'
      ? 'Requires the KSA SmartForm Bridge browser extension and an open visa.mofa.gov.sa/Enjaz/ViewVisaDetails/Org tab. Click to read that tab\'s Visa Issued Number / Residence-National ID Number / Visa Date / Full Name / Visa Issuing Authority / Person Count into this form (into Visa No / ID No / Visa Date / Arbiccompany / Embassyin / Demand) — nothing is read until you click.'
      : 'Requires the KSA SmartForm Bridge browser extension and an open visa.mofa.gov.sa tab. Click to read that tab\'s Name / Father\'s Name / Passport No / Date of Birth / Place of Birth / Date of Issue / Date of Expiry / ID Number / Place of Issue / Home Address / District / Marital Status / Sex / Qualification fields into this form — nothing is read until you click.';

    ksaPullBlock = el('div', {
      class: 'f-field full',
      style: 'background:var(--bg);border:1px dashed var(--border);border-radius:8px;padding:12px 14px;margin-bottom:6px;',
    }, [
      el('label', {}, 'Get Data from KSA Tab (optional)'),
      el('div', { style: 'font-size:.78rem;color:var(--text-mute);margin-bottom:8px;' }, ksaDescription),
      ksaBtn,
      ksaStatusMsg,
    ]);
  }

  // "Send to BEOE Tab" — the reverse direction of the KSA block above: this
  // form's data going OUT to the BEOE (Bureau of Emigration & Overseas
  // Employment) oep-portal Emigrant Registration page, instead of another
  // site's data coming IN. Available whenever the DATATABLE form is open
  // (Add or Edit) — it reads whatever is currently typed into the fields
  // right now, so you don't need to save first. Like the KSA block, this
  // depends on a browser extension (a "BEOE SmartForm Bridge", not yet
  // built) doing the actual work of finding beoe.gov.pk's specific form
  // fields and filling them; this app only ever hands over this
  // candidate's data using DATATABLE's own field names; it has no
  // knowledge of BEOE's page structure and never touches that page
  // directly (a plain web page can't reach into a different site's tab —
  // only a browser extension can bridge the two safely).
  let beoePushBlock = null;
  if (ent.key === 'datatable') {
    const beoeStatusMsg = el('div', { id: 're-beoe-status-msg', style: 'font-size:.78rem;color:var(--text-mute);margin-top:6px;' }, '');
    const beoeBtn = el('button', {
      type: 'button', class: 'btn btn-outline btn-sm',
      onclick: () => {
        if (document.body.getAttribute('data-re-beoe-bridge') !== 'ready') {
          beoeStatusMsg.style.color = 'var(--danger)';
          beoeStatusMsg.textContent = "The BEOE SmartForm Bridge extension isn't installed or enabled in this browser.";
          return;
        }
        const liveData = {};
        ent.fields.forEach(f => {
          const inp = inputs[f.name];
          if (!inp) return;
          liveData[f.name] = f.type === 'checkbox' ? inp.checked : inp.value;
        });
        beoeStatusMsg.style.color = '';
        beoeStatusMsg.textContent = 'Sending to the open BEOE Emigrant Registration tab…';
        document.dispatchEvent(new CustomEvent('re-beoe-push-request', { detail: { candidate: liveData } }));
      },
    }, [el('i', { class: 'fa-solid fa-paper-plane' }), ' Send to BEOE Tab']);
    const beoeOpenLink = el('a', {
      href: 'https://beoe.gov.pk/oep-portal/emigrant-registrations/create',
      target: '_blank', rel: 'noopener', class: 'btn btn-outline btn-sm',
    }, [el('i', { class: 'fa-solid fa-up-right-from-square' }), ' Open BEOE Registration Page']);

    beoePushBlock = el('div', {
      class: 'f-field full',
      style: 'background:var(--bg);border:1px dashed var(--border);border-radius:8px;padding:12px 14px;margin-bottom:6px;',
    }, [
      el('label', {}, 'Send to BEOE Portal (optional)'),
      el('div', { style: 'font-size:.78rem;color:var(--text-mute);margin-bottom:8px;' },
        "Requires the BEOE SmartForm Bridge browser extension and an open beoe.gov.pk Emigrant Registration tab (log in first). Sends this candidate's current field values across for that extension to fill in — nothing is sent until you click."),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [beoeOpenLink, beoeBtn]),
      beoeStatusMsg,
    ]);
  }

  // "Send to BEOE Permission Tab" — the Employer/Category counterpart of
  // the candidate block above, aimed at beoe.gov.pk's permissions/create
  // page (Foreign Employer details + one repeating job block per trade
  // category). Sends the employer's field values plus the CATEGORY rows
  // linked to it; the extension clicks "Add Another Job" as needed so a
  // second, third, ... category lands in its own block.
  //
  // Shown on BOTH the Employer form and the Category form, since either is
  // a natural place to reach for it. From a Category, the employer sent is
  // the one that category belongs to, and its sibling categories come along
  // too — the BEOE page takes all trades for one permission in one go, so
  // sending a lone category would mean re-doing the employer header by hand
  // for every trade.
  //
  // The block always renders on those two forms, even when it can't send
  // yet (unsaved record, or no employer picked). An explanation the user
  // can read beats a button that silently isn't there.
  let beoePermBlock = null;
  if (ent.key === 'employer' || ent.key === 'category') {
    const catEnt = entityByKey('category');
    const empEnt = entityByKey('employer');

    // Which employer this send is about, and where its details come from:
    //  - On the Employer form it's this record, and we use the LIVE field
    //    values so unsaved edits are included.
    //  - On the Category form it's whichever employer the EMPID dropdown
    //    currently points at, read from the saved EMPLOYER row.
    let empId = null;
    let blocker = '';
    if (ent.key === 'employer') {
      empId = existingRow ? existingRow[ent.pk] : null;
      if (!empId) blocker = 'Save this employer first, then reopen it — categories are linked by employer ID, which only exists once the record is saved.';
    } else {
      empId = (inputs.EMPID && inputs.EMPID.value) || (existingRow ? existingRow.EMPID : null) || null;
      if (!empId) blocker = 'Pick an Employer for this category first — the BEOE permission needs the employer details too.';
    }

    const getEmployerData = () => {
      if (ent.key === 'employer') {
        const live = {};
        ent.fields.forEach(f => {
          const inp = inputs[f.name];
          if (!inp) return;
          live[f.name] = f.type === 'checkbox' ? inp.checked : inp.value;
        });
        return live;
      }
      const id = (inputs.EMPID && inputs.EMPID.value) || (existingRow ? existingRow.EMPID : null);
      return (cache[empEnt.table] || []).find(e => String(e[empEnt.pk]) === String(id)) || {};
    };

    // All categories for that employer, minus any explicitly marked
    // Select = False. Rows that never had the flag set are included, so this
    // behaves sensibly whether or not you use that flag.
    //
    // Fetched FRESH from Supabase at click time rather than read from the
    // client-side `cache` — that cache can hold a partial or stale set of
    // CATEGORY rows (e.g. whatever a list page last loaded/filtered/paged
    // to), so trusting it here was silently sending only 1 of a real 4
    // categories. A direct query is the only way to guarantee every
    // category for this employer actually gets included.
    const getCategories = async () => {
      const id = ent.key === 'employer'
        ? empId
        : ((inputs.EMPID && inputs.EMPID.value) || (existingRow ? existingRow.EMPID : null));
      if (!id) return [];
      const { data, error } = await sb.from(catEnt.table).select('*').eq('EMPID', id);
      if (error) {
        console.error('Fetching categories for BEOE send failed:', error);
        return [];
      }
      const rows = (data || []).filter(c =>
        String(c.SELECT ?? '').trim().toLowerCase() !== 'false');
      // On the Category form, the row being edited should go over with
      // whatever is typed right now rather than its last saved values.
      if (ent.key === 'category') {
        const live = {};
        ent.fields.forEach(f => {
          const inp = inputs[f.name];
          if (!inp) return;
          live[f.name] = f.type === 'checkbox' ? inp.checked : inp.value;
        });
        const thisId = existingRow ? existingRow[ent.pk] : null;
        const idx = thisId == null ? -1 : rows.findIndex(r => String(r[catEnt.pk]) === String(thisId));
        if (idx >= 0) rows[idx] = { ...rows[idx], ...live };
        else if (String(live.SELECT ?? '').trim().toLowerCase() !== 'false') rows.push(live);
      }
      return rows;
    };

    const permStatusMsg = el('div', { id: 're-beoe-perm-status-msg', style: 'font-size:.78rem;color:var(--text-mute);margin-top:6px;' }, '');
    const permBtn = el('button', {
      type: 'button', class: 'btn btn-outline btn-sm',
      onclick: async () => {
        if (blocker) {
          permStatusMsg.style.color = 'var(--danger)';
          permStatusMsg.textContent = blocker;
          return;
        }
        if (document.body.getAttribute('data-re-beoe-bridge') !== 'ready') {
          permStatusMsg.style.color = 'var(--danger)';
          permStatusMsg.textContent = "The BEOE SmartForm Bridge extension isn't installed or enabled in this browser.";
          return;
        }
        permStatusMsg.style.color = '';
        permStatusMsg.textContent = 'Looking up this employer\u2019s categories\u2026';
        const cats = await getCategories();
        if (!cats.length) {
          permStatusMsg.style.color = 'var(--danger)';
          permStatusMsg.textContent = 'No categories found for this employer — add at least one on the Categories page first (or check none are set to Select = False).';
          return;
        }
        permStatusMsg.style.color = '';
        permStatusMsg.textContent = `Sending employer + ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'} to the open BEOE permission tab…`;
        document.dispatchEvent(new CustomEvent('re-beoe-permission-push-request', {
          detail: { employer: getEmployerData(), categories: cats },
        }));
      },
    }, [el('i', { class: 'fa-solid fa-paper-plane' }), ' Send to BEOE Permission Tab']);
    const permOpenLink = el('a', {
      href: 'https://beoe.gov.pk/oep-portal/permissions/create?permission_type=3',
      target: '_blank', rel: 'noopener', class: 'btn btn-outline btn-sm',
    }, [el('i', { class: 'fa-solid fa-up-right-from-square' }), ' Open BEOE Permission Page']);

    beoePermBlock = el('div', {
      class: 'f-field full',
      style: 'background:var(--bg);border:1px dashed var(--border);border-radius:8px;padding:12px 14px;margin-bottom:6px;',
    }, [
      el('label', {}, 'Send to BEOE Permission Page (optional)'),
      el('div', { style: 'font-size:.78rem;color:var(--text-mute);margin-bottom:8px;' },
        "Requires the BEOE SmartForm Bridge extension and an open beoe.gov.pk permission tab (log in first). Sends the employer plus every category linked to it, adding a job block for each. Country/Place of Duty/Currency/Contract Period/Hours/Overtime/Experience go over as fixed standard values; Demand Letter No., Power of Attorney No. and Focal Person are repurposed from the closest Employer fields (Visa No., ID No., Name of Owner). Employer Type, Phone/Fax/Email/Website, dates, Job Description and the benefits section aren't stored in the app and are left blank."),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [permOpenLink, permBtn]),
      permStatusMsg,
    ]);
    if (blocker) {
      permStatusMsg.style.color = 'var(--danger)';
      permStatusMsg.textContent = blocker;
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
        let v;
        if (f.type === 'checkbox') {
          v = inputs[f.name].checked;
        } else {
          v = inputs[f.name].value;
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
        }
        if (f.required && (v === null || v === '')) valid = false;
        payload[f.name] = v;
      });
      if (!valid) { errBox.textContent = 'Please fill all required fields.'; return; }

      // Enumber must be unique across DATATABLE. This checks against
      // whatever's currently cached client-side, which is enough to catch
      // the normal case (someone re-typing/pasting a number already used)
      // and give an immediate, specific error instead of a generic DB
      // failure — but two people saving the same new Enumber at almost the
      // same moment could still both pass this check. A UNIQUE constraint
      // on DATATABLE."Enumber" in Postgres is the real guarantee; this is
      // just the friendly front-line check.
      if (ent.key === 'datatable') {
        const newEnumber = String(payload.Enumber ?? '').trim();
        if (newEnumber !== '') {
          const dup = (cache[ent.table] || []).some(r =>
            (!existingRow || String(r[ent.pk]) !== String(existingRow[ent.pk])) &&
            String(r.Enumber ?? '').trim().toLowerCase() === newEnumber.toLowerCase()
          );
          if (dup) {
            errBox.textContent = `Enumber "${payload.Enumber}" is already used by another record — Enumber must be unique.`;
            return;
          }
        }
      }

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
    ...(ksaPullBlock ? [ksaPullBlock] : []),
    ...(beoePushBlock ? [beoePushBlock] : []),
    ...(beoePermBlock ? [beoePermBlock] : []),
    fieldsArea,
    errBox,
    el('div', { class: 'modal-actions' }, [
      el('button', { type: 'button', class: 'btn btn-outline', onclick: () => overlay.remove() }, 'Cancel'),
      saveBtn,
    ]),
  ]);

  const boxAttrs = {
    class: 'modal-box',
    'data-re-entity': ent.key,
    'data-re-mode': existingRow ? 'edit' : 'add',
  };
  // DATATABLE's form has 70+ fields across several sections — give it a
  // wide, near-full-screen box (instead of the narrower default modal width)
  // so it reads sensibly across the horizontal space, with its own scroll
  // for when the sections together are taller than the screen.
  if (ent.key === 'datatable') {
    boxAttrs.style = 'width:min(96vw, 1600px);max-width:1600px;max-height:92vh;overflow-y:auto;';
  }
  // EMPLOYER's form-grid has ~20 fields — wide enough to lay several
  // columns out side by side on a normal screen instead of stacking into
  // one narrow column.
  if (ent.key === 'employer') {
    boxAttrs.style = 'width:min(94vw, 1100px);max-width:1100px;max-height:92vh;overflow-y:auto;';
  }
  const box = el('div', boxAttrs, [
    el('button', { class: 'modal-close', onclick: () => overlay.remove() }, '✕'),
    el('h3', {}, existingRow ? `Edit ${ent.label.replace(/s$/, '')}` : `Add ${ent.label.replace(/s$/, '')}`),
    form,
  ]);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

async function deleteRow(ent, row) {
  if (!isAdmin()) { toast('Your account is read-only — deleting records requires an Admin account.'); return; }
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
      let v = f.type === 'checkbox' ? (row[f.name] === true ? 'Yes' : 'No') : formatCell(f, row[f.name]);
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

  // Agent Ledger gets two extra columns, Exp and Other, shown as their own
  // breakdown alongside Credit (which already includes them in its total —
  // see below) — Employer Ledger has no "exp" concept, so its table stays
  // as-is at 5 columns.
  const columns = isAgent
    ? ['Date', 'Description', 'Debit', 'Exp', 'Other', 'Credit', 'Balance']
    : ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
  const isNumericCol = (i) => i >= 2; // every column except Date/Description is a number, right-aligned via the .num class

  let balance = 0;
  let totalDebit = 0, totalExp = 0, totalOther = 0, totalCredit = 0;
  const bodyRows = sorted.map(row => {
    const debit = Number(row.DEBIT) || 0;
    const exp = Number(row.exp) || 0;
    const other = Number(row.other) || 0;
    // Agent Ledger: Credit also includes the row's "exp" and "other" amounts
    // (extra charges entered alongside the main Credit figure), so the
    // statement's Credit column and running balance reflect the true total
    // rather than just the base CREDIT value.
    const credit = isAgent ? (Number(row.CREDIT) || 0) + exp + other : (Number(row.CREDIT) || 0);
    balance += debit - credit;
    totalDebit += debit;
    totalExp += exp;
    totalOther += other;
    totalCredit += credit;
    const cells = [formatDateDMY(row.DATE), esc(row.DESCRIPTION || '—'), debit ? formatNumber(debit) : '—'];
    if (isAgent) {
      cells.push(exp ? formatNumber(exp) : '—');
      cells.push(other ? formatNumber(other) : '—');
    }
    cells.push(credit ? formatNumber(credit) : '—', formatNumber(balance));
    return cells;
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
      td:nth-child(1){white-space:nowrap;}
      .num{text-align:right;}
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
      <thead><tr>${columns.map((c, i) => `<th${isNumericCol(i) ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${bodyRows.map(r => `<tr>${r.map((c, i) => `<td${isNumericCol(i) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody>
      <tfoot>
        <tr><td colspan="2">Totals</td><td class="num">${formatNumber(totalDebit)}</td>${isAgent ? `<td class="num">${formatNumber(totalExp)}</td><td class="num">${formatNumber(totalOther)}</td>` : ''}<td class="num">${formatNumber(totalCredit)}</td><td></td></tr>
        <tr class="closing-row"><td colspan="${columns.length - 1}">Closing Balance</td><td class="num">${formatNumber(Math.abs(balance))} ${balanceWord}</td></tr>
      </tfoot>
    </table>
    <div class="footer-note">This statement was generated automatically from ${esc(CFG.APP_NAME || 'Recruit Expert')} and reflects entries recorded as of the generation date above.</div>
    </body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  // Wait for the new tab to finish loading (styles applied, @page size
  // registered, any images decoded) before printing. Calling win.print()
  // immediately after document.close() can race the browser's layout/paint,
  // which is what was causing the print preview to fall back to a default
  // page size and render everything smaller than the A4/Letter size that was
  // actually designed.
  const doPrint = () => { win.focus(); win.print(); };
  if (win.document.readyState === 'complete') setTimeout(doPrint, 150);
  else win.onload = () => setTimeout(doPrint, 150);
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

function exportAllReports(reports) {
  if (!reports.length) { toast('No reports to export yet.'); return; }
  const blob = new Blob([JSON.stringify(reports, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'recruit-expert-reports-export.json'; a.click();
  URL.revokeObjectURL(url);
}

async function renderReportsList() {
  document.getElementById('pageTitle').textContent = 'Reports';
  const content = document.getElementById('content');
  content.innerHTML = '';
  const reports = loadSavedReports();

  const importInput = el('input', { type: 'file', accept: '.json', style: 'display:none' });
  importInput.addEventListener('change', () => {
    const file = importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let incoming;
      try { incoming = JSON.parse(reader.result); }
      catch (e) { toast('That file is not valid — expected a Reports export.'); return; }
      if (!Array.isArray(incoming)) { toast('That file is not valid — expected a Reports export.'); return; }
      const current = loadSavedReports();
      // Merge by id: an imported report with an id that already exists here
      // gets a fresh id instead of silently overwriting your local one.
      const existingIds = new Set(current.map(r => r.id));
      const merged = current.concat(incoming.map(r => existingIds.has(r.id) ? { ...r, id: 'rpt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) } : r));
      if (saveSavedReportsList(merged)) { toast(`Imported ${incoming.length} report(s).`); renderReportsList(); }
    };
    reader.readAsText(file);
    importInput.value = '';
  });

  const toolbar = el('div', { class: 'toolbar', style: 'flex-wrap:wrap;gap:10px' }, [
    el('div', {}, 'Report designs are saved in THIS BROWSER, on THIS WEBSITE ADDRESS only — use Export/Import to move them to another site (e.g. from local testing to your live Netlify URL) or another computer/browser.'),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
      el('button', { class: 'btn btn-outline', onclick: () => exportAllReports(reports) }, [el('i', { class: 'fa-solid fa-download' }), ' Export All']),
      // Import is now open to every role, same as Export/Print — it's the
      // one report-management action Admin/User also get. New Report
      // (design from scratch), Edit, and Delete stay Developer-only below.
      el('button', { class: 'btn btn-outline', onclick: () => importInput.click() }, [el('i', { class: 'fa-solid fa-upload' }), ' Import']),
      importInput,
      ...(isDeveloper() ? [
        el('button', { class: 'btn btn-primary', onclick: () => renderReportDesigner(null) }, [el('i', { class: 'fa-solid fa-plus' }), ' New Report']),
      ] : []),
    ]),
  ]);
  content.appendChild(toolbar);

  if (!reports.length) {
    content.appendChild(el('div', { class: 'empty-state' },
      isDeveloper()
        ? 'No saved reports yet — click "New Report" to design one, or "Import" if you have an export from another site.'
        : 'No saved reports yet — click "Import" if you have an export from another site, or ask a Developer to design one.'
    ));
    return;
  }

  const rows = reports.map(r => el('tr', {}, [
    el('td', {}, r.name),
    el('td', {}, String((r.elements || []).filter(x => x.type === 'field').length) + ' fields'),
    el('td', {}, [
      // Edit and Delete change/remove a shared report design, so they stay
      // Developer-only, same as New Report and Import above — Admin/User
      // can still open and print any existing report.
      ...(isDeveloper() ? [
        el('button', { class: 'btn btn-outline btn-sm', onclick: () => renderReportDesigner(r) }, 'Edit'),
        ' ',
      ] : []),
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => openReportPrintPicker(r) }, [el('i', { class: 'fa-solid fa-print' }), ' Print']),
      ...(isDeveloper() ? [
        ' ',
        el('button', {
          class: 'btn btn-danger btn-sm',
          onclick: () => {
            if (!confirm(`Delete report "${r.name}"? This can't be undone.`)) return;
            saveSavedReportsList(loadSavedReports().filter(x => x.id !== r.id));
            renderReportsList();
          },
        }, 'Delete'),
      ] : []),
    ]),
  ]));
  content.appendChild(el('table', { class: 'data-table' }, [
    el('thead', {}, el('tr', {}, [el('th', {}, 'Report Name'), el('th', {}, 'Fields'), el('th', {}, 'Actions')])),
    el('tbody', {}, rows),
  ]));
}

// Loads PDF.js from CDN on first use only (not on every page load), so
// "Add PDF" works without needing any change to index.html. Once loaded,
// later calls reuse the same library instance instead of re-fetching it.
let _pdfJsLoadPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfJsLoadPromise) return _pdfJsLoadPromise;
  _pdfJsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error('Could not load the PDF library — check your internet connection.'));
    document.head.appendChild(script);
  });
  return _pdfJsLoadPromise;
}

// Renders page 1 of a PDF (given as an ArrayBuffer) to a PNG data URL, so it
// can be dropped into the report canvas as a normal image element. Only
// page 1 is used — this designer works on a single page, the same as every
// other element type here.
async function renderPdfFirstPageToDataUrl(arrayBuffer) {
  const pdfjsLib = await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 }); // 2x for print-quality sharpness
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return { dataUrl: canvas.toDataURL('image/png'), pageCount: pdf.numPages, w: viewport.width, h: viewport.height };
}

function renderReportDesigner(existingReport) {
  // Same choke-point pattern as openForm's isAdmin() guard: this is the only
  // place a new/edited report actually gets saved, so it's guarded here
  // directly rather than relying only on the "Reports" tab being hidden for
  // non-Developer accounts. Printing an EXISTING report
  // (openReportPrintPicker) is deliberately NOT gated here — read-only
  // accounts can still print.
  if (!isDeveloper()) { toast('Designing reports requires a Developer account.'); return; }
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

  const empEnt = entityByKey('employer');
  const catEnt = entityByKey('category');
  const alEnt = entityByKey('agentledger');
  const elEnt = entityByKey('employerledger');
  const fieldSelect = el('select', {}, [
    el('option', { value: '' }, '— Add a field —'),
    el('optgroup', { label: 'Candidate (DATATABLE)' }, dtEnt.fields.map(f => el('option', { value: f.name }, f.label))),
    el('optgroup', { label: 'Employer' }, empEnt.fields.map(f => el('option', { value: `EMPLOYER.${f.name}` }, f.label))),
    el('optgroup', { label: 'Category' }, catEnt.fields.map(f => el('option', { value: `CATEGORY.${f.name}` }, f.label))),
    el('optgroup', { label: 'Agent Ledger' }, alEnt.fields.map(f => el('option', { value: `AGENTLEDGER.${f.name}` }, f.label))),
    el('optgroup', { label: 'Employer Ledger' }, elEnt.fields.map(f => el('option', { value: `EMPLOYERLEDGER.${f.name}` }, f.label))),
  ]);
  // Same idea as fieldSelect, but drops a scannable Code128 barcode bound to
  // the chosen field instead of plain text — e.g. Enumber or Visano so the
  // printed form can be scanned at the counter.
  const barcodeSelect = el('select', {}, [
    el('option', { value: '' }, '— Add a barcode —'),
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
    let label = name;
    if (name.startsWith('EMPLOYER.')) {
      const f = empEnt.fields.find(x => x.name === name.slice('EMPLOYER.'.length));
      label = f ? `Employer: ${f.label}` : name;
    } else if (name.startsWith('CATEGORY.')) {
      const f = catEnt.fields.find(x => x.name === name.slice('CATEGORY.'.length));
      label = f ? `Category: ${f.label}` : name;
    } else if (name.startsWith('AGENTLEDGER.')) {
      const f = alEnt.fields.find(x => x.name === name.slice('AGENTLEDGER.'.length));
      label = f ? `Agent Ledger: ${f.label}` : name;
    } else if (name.startsWith('EMPLOYERLEDGER.')) {
      const f = elEnt.fields.find(x => x.name === name.slice('EMPLOYERLEDGER.'.length));
      label = f ? `Employer Ledger: ${f.label}` : name;
    } else {
      const f = dtEnt.fields.find(x => x.name === name);
      label = f ? f.label : name;
    }
    const pos = nextPos();
    addElement({ type: 'field', field: name, label, x: pos.x, y: pos.y, w: 180, h: 28, fontSize: 14 });
    fieldSelect.value = '';
  });

  barcodeSelect.addEventListener('change', () => {
    const name = barcodeSelect.value;
    if (!name) return;
    const f = dtEnt.fields.find(x => x.name === name);
    const pos = nextPos();
    addElement({ type: 'barcode', field: name, label: f ? f.label : name, x: pos.x, y: pos.y, w: 160, h: 50 });
    barcodeSelect.value = '';
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

  // Agency Header / Footer — a placeholder for whichever agency is logged in
  // when the report is printed, not a fixed image baked into this one
  // report. Lets the same saved report look right for every agency instead
  // of needing a separate copy per agency's letterhead. Resolved at print
  // time from the current agency's own COMPANY.HEADER / COMPANY.FOOTER
  // value (set on the Companies page) — see buildCandidatePage below.
  const addHeaderBtn = el('button', {
    class: 'btn btn-outline', onclick: () => {
      addElement({ type: 'agencyHeader', x: 0, y: 0, w: initialSize.w, h: 90 });
    },
    title: "Shows whichever agency's HEADER image is logged in at print time — set per agency on the Companies page.",
  }, [el('i', { class: 'fa-solid fa-panorama' }), ' Add Agency Header']);
  const addFooterBtn = el('button', {
    class: 'btn btn-outline', onclick: () => {
      addElement({ type: 'agencyFooter', x: 0, y: initialSize.h - 90, w: initialSize.w, h: 90 });
    },
    title: "Shows whichever agency's FOOTER image is logged in at print time — set per agency on the Companies page.",
  }, [el('i', { class: 'fa-solid fa-panorama' }), ' Add Agency Footer']);

  // "Add PDF" reuses the image element type under the hood — a PDF page,
  // once rendered, is just a picture as far as this canvas is concerned.
  // Only page 1 of the PDF is used (see renderPdfFirstPageToDataUrl).
  const pdfInput = el('input', { type: 'file', accept: 'application/pdf', style: 'display:none' });
  const addPdfBtn = el('button', {
    class: 'btn btn-outline', onclick: () => pdfInput.click(),
    title: 'Adds page 1 of the PDF as an image you can position and resize.',
  }, [el('i', { class: 'fa-solid fa-file-pdf' }), ' Add PDF']);
  pdfInput.addEventListener('change', async () => {
    const file = pdfInput.files[0];
    if (!file) return;
    pdfInput.value = '';
    addPdfBtn.disabled = true;
    const originalLabel = addPdfBtn.innerHTML;
    addPdfBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Converting PDF…';
    try {
      const buf = await file.arrayBuffer();
      const { dataUrl, pageCount, w, h } = await renderPdfFirstPageToDataUrl(buf);
      const pos = nextPos();
      // Scale the initial box down to something reasonable to work with —
      // the resize handle lets it be sized up or down afterward either way.
      const scale = Math.min(1, 360 / w);
      addElement({ type: 'image', src: dataUrl, x: pos.x, y: pos.y, w: Math.round(w * scale), h: Math.round(h * scale) });
      if (pageCount > 1) toast(`Added page 1 of ${pageCount} — this designer only supports a single page per report.`);
      else toast('PDF added.');
    } catch (err) {
      console.error(err);
      toast('Could not convert that PDF: ' + err.message);
    } finally {
      addPdfBtn.disabled = false;
      addPdfBtn.innerHTML = originalLabel;
    }
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
    nameInput, pageSizeSelect, fieldSelect, barcodeSelect, addTextBtn, addImageBtn, fileInput, addPdfBtn, pdfInput,
    addHeaderBtn, addFooterBtn,
    el('div', { style: 'flex:1' }),
    backBtn, saveBtn,
  ]);
  const hint = el('div', { style: 'text-align:center;color:#888;font-size:12px;margin-top:4px' },
    'Drag any element to reposition it. Images and PDFs have a resize handle in the bottom-right corner. Double-click text to edit it. Hover an element for its delete (×) button. "Add PDF" brings in page 1 only.');

  content.appendChild(toolbar);
  content.appendChild(canvas);
  content.appendChild(hint);

  // Load existing elements, if editing a saved report.
  (existingReport ? existingReport.elements : []).forEach(data => addElement(data));
}

// A small "A" − [size] + control that floats above a field/text element
// (shown on hover, same as the delete button) so its font size can be set
// to an exact number directly — not derived from resizing the box, which
// only changes how much space the text has to sit in.
function buildFontSizeControl(node, inner, initialSize) {
  const sizeInput = el('input', {
    type: 'number', min: '6', max: '96', value: String(initialSize),
    style: 'width:38px;height:18px;font-size:11px;text-align:center;border:1px solid #93b4f5;border-radius:3px;padding:0;',
  });
  const apply = (v) => {
    const n = Math.max(6, Math.min(96, parseInt(v) || initialSize));
    sizeInput.value = String(n);
    inner.style.fontSize = n + 'px';
  };
  sizeInput.addEventListener('input', () => apply(sizeInput.value));
  sizeInput.addEventListener('mousedown', (e) => e.stopPropagation());
  const step = (delta) => apply((parseInt(sizeInput.value) || initialSize) + delta);
  const stepBtn = (label, delta) => el('div', {
    style: 'width:16px;height:18px;line-height:18px;text-align:center;background:#1a56db;color:#fff;' +
           'font-size:12px;border-radius:3px;cursor:pointer;user-select:none;',
    onmousedown: (e) => e.stopPropagation(),
    onclick: (e) => { e.stopPropagation(); step(delta); },
  }, label);
  const ctrl = el('div', {
    class: 're-fontsize-ctrl',
    style: 'position:absolute;top:-10px;left:-10px;display:none;align-items:center;gap:2px;' +
           'background:#fff;border:1px solid #ddd;border-radius:4px;padding:2px;z-index:6;box-shadow:0 1px 3px rgba(0,0,0,.2);',
  }, [stepBtn('−', -1), sizeInput, stepBtn('+', 1)]);
  node.addEventListener('mouseenter', () => { ctrl.style.display = 'flex'; });
  node.addEventListener('mouseleave', () => { ctrl.style.display = 'none'; });
  return ctrl;
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
    node.style.width = (data.w || 180) + 'px';
    node.style.height = (data.h || 28) + 'px';
    const baseFontSize = data.fontSize || 14;
    const inner = el('div', {
      style: `font-size:${baseFontSize}px;color:#1a56db;font-style:italic;padding:3px 6px;` +
             `background:#eef3ff;border:1px dashed #93b4f5;border-radius:4px;box-sizing:border-box;` +
             `width:100%;height:100%;overflow:hidden;white-space:normal;word-break:break-word;`,
    }, `{{${data.label}}}`);
    node.appendChild(inner);
    node.appendChild(buildFontSizeControl(node, inner, baseFontSize));
    const handle = el('div', {
      style: 'position:absolute;right:-6px;bottom:-6px;width:14px;height:14px;background:#1a56db;' +
             'border-radius:3px;cursor:nwse-resize;z-index:5;',
    });
    node.appendChild(handle);
    makeResizable(handle, node);
  } else if (data.type === 'text') {
    node.style.width = (data.w || 200) + 'px';
    node.style.height = (data.h || 28) + 'px';
    const baseFontSize = data.fontSize || 14;
    const inner = el('div', {
      contenteditable: 'false',
      style: `font-size:${baseFontSize}px;padding:3px 6px;box-sizing:border-box;` +
             `width:100%;height:100%;overflow:hidden;word-break:break-word;` +
             `border:1px dashed transparent;`,
      ondblclick: (e) => { e.stopPropagation(); inner.contentEditable = 'true'; inner.style.borderColor = '#999'; inner.focus(); },
      onblur: () => { inner.contentEditable = 'false'; inner.style.borderColor = 'transparent'; },
    }, data.text || 'Text');
    node.appendChild(inner);
    node.appendChild(buildFontSizeControl(node, inner, baseFontSize));
    const handle = el('div', {
      style: 'position:absolute;right:-6px;bottom:-6px;width:14px;height:14px;background:#1a56db;' +
             'border-radius:3px;cursor:nwse-resize;z-index:5;',
    });
    node.appendChild(handle);
    makeResizable(handle, node);
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
  } else if (data.type === 'barcode') {
    // Design-time preview is just a striped placeholder — the actual scannable
    // barcode (via JsBarcode) is only generated at print time once we know
    // which candidate's field value to encode.
    node.dataset.field = data.field;
    node.dataset.label = data.label;
    node.style.width = (data.w || 160) + 'px';
    node.style.height = (data.h || 50) + 'px';
    const stripes = el('div', {
      style: 'width:100%;height:100%;background:repeating-linear-gradient(90deg,#222 0 2px,#fff 2px 4px);' +
             'border:1px solid #999;pointer-events:none;',
    });
    const caption = el('div', {
      style: 'position:absolute;left:0;top:100%;font-size:10px;color:#1a56db;background:#fff;' +
             'padding:1px 4px;white-space:nowrap;pointer-events:none;',
    }, `Barcode: ${data.label}`);
    node.appendChild(stripes);
    node.appendChild(caption);
    const handle = el('div', {
      style: 'position:absolute;right:-6px;bottom:-6px;width:14px;height:14px;background:#1a56db;' +
             'border-radius:3px;cursor:nwse-resize;z-index:5;',
    });
    node.appendChild(handle);
    makeResizable(handle, node);
  } else if (data.type === 'agencyHeader' || data.type === 'agencyFooter') {
    // Live preview shows the CURRENT logged-in agency's actual header/footer
    // image if it has one set — accurate, since printing always resolves
    // this the same way, from whichever agency is logged in at print time.
    const isHeader = data.type === 'agencyHeader';
    node.style.width = (data.w || 700) + 'px';
    node.style.height = (data.h || 90) + 'px';
    const agency = currentAgencyRow();
    const src = agency ? agency[isHeader ? 'HEADER' : 'FOOTER'] : '';
    if (src) {
      const img = el('img', { src, style: 'display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;' });
      node.appendChild(img);
    } else {
      node.appendChild(el('div', {
        style: 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
               'background:#f3f4f6;border:1px dashed #999;color:#888;font-size:12px;text-align:center;pointer-events:none;',
      }, `Agency ${isHeader ? 'Header' : 'Footer'} — logged-in agency has none set yet`));
    }
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
    const inner = node.querySelector('div');
    const fontSize = inner ? (parseInt(inner.style.fontSize) || 14) : 14;
    return { type, field: node.dataset.field, label: node.dataset.label, x, y, w: node.offsetWidth, h: node.offsetHeight, fontSize };
  }
  if (type === 'text') {
    const inner = node.querySelector('div');
    const fontSize = inner ? (parseInt(inner.style.fontSize) || 14) : 14;
    return { type, text: inner ? inner.innerText : '', x, y, w: node.offsetWidth, h: node.offsetHeight, fontSize };
  }
  if (type === 'image') {
    const img = node.querySelector('img');
    return { type, src: img ? img.src : '', x, y, w: node.offsetWidth, h: node.offsetHeight };
  }
  if (type === 'barcode') {
    return { type, field: node.dataset.field, label: node.dataset.label, x, y, w: node.offsetWidth, h: node.offsetHeight };
  }
  if (type === 'agencyHeader' || type === 'agencyFooter') {
    return { type, x, y, w: node.offsetWidth, h: node.offsetHeight };
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
    if (e.target.closest && e.target.closest('.re-fontsize-ctrl')) return;
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
function makeResizable(handle, targetNode, onResize) {
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = targetNode.offsetWidth, startH = targetNode.offsetHeight;
    function onMove(ev) {
      const newW = Math.max(30, startW + (ev.clientX - startX));
      const newH = Math.max(30, startH + (ev.clientY - startY));
      targetNode.style.width = newW + 'px';
      targetNode.style.height = newH + 'px';
      if (onResize) onResize(newW, newH, startW, startH);
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
async function openReportPrintPicker(report) {
  // Employer/Category fields can appear on a report (see fieldSelect below),
  // so their tables need to be in cache before Print is even opened — not
  // just before the final print — otherwise their values could momentarily
  // show blank if this page loaded before those tables were ever fetched.
  await preloadRefCaches();
  const dtEnt = entityByKey('datatable');
  const empEnt = entityByKey('employer');
  const catEnt = entityByKey('category');
  const alEnt = entityByKey('agentledger');
  const elEnt = entityByKey('employerledger');
  const candidates = [...(cache[dtEnt.table] || [])].sort((a, b) => (b.DID ?? 0) - (a.DID ?? 0));

  // Agent Ledger / Employer Ledger aren't preloaded by preloadRefCaches
  // (nothing else references them via a select field), and a ledger can run
  // long, so these are fetched fresh here, most-recent-first, capped at 200
  // rows — plenty to find a recent entry without pulling years of history
  // into a dropdown.
  const [{ data: agentLedgerRows }, { data: employerLedgerRows }] = await Promise.all([
    sb.from(alEnt.table).select('*').order(alEnt.pk, { ascending: false }).limit(200),
    sb.from(elEnt.table).select('*').order(elEnt.pk, { ascending: false }).limit(200),
  ]);
  const ledgerEntryLabel = (row) => {
    const amount = row.DEBIT ? `Debit ${row.DEBIT}` : row.CREDIT ? `Credit ${row.CREDIT}` : '';
    return [row.DATE, row.DESCRIPTION || '(no description)', amount].filter(Boolean).join(' — ');
  };

  // Employer and Candidate are two independent ways to print — picking
  // either one is enough on its own. Printing straight from Employer has no
  // specific candidate, so any candidate-specific fields (Name, Passport,
  // etc.) just print blank — but since one Employer can have SEVERAL
  // Category rows (different demands: different salary/quantity per
  // category), picking the Employer alone isn't enough to know which one's
  // Category/Salary/Quantity to show. The Category dropdown below narrows
  // that down once an Employer is chosen.
  const employerSelect = el('select', { style: 'width:100%' }, [
    el('option', { value: '' }, '— none —'),
    ...(cache[empEnt.table] || []).map(r => el('option', { value: String(r[empEnt.pk]) }, r[empEnt.displayField] ?? `#${r[empEnt.pk]}`)),
  ]);
  const categorySelect = el('select', { style: 'width:100%' }, [el('option', { value: '' }, '— pick an Employer first —')]);
  employerSelect.addEventListener('change', () => {
    const empId = employerSelect.value;
    const cats = (cache[catEnt.table] || []).filter(c => String(c.EMPID) === empId);
    categorySelect.innerHTML = '';
    if (!cats.length) {
      categorySelect.appendChild(el('option', { value: '' }, '— this employer has no categories —'));
      return;
    }
    categorySelect.appendChild(el('option', { value: '' }, '— none —'));
    if (cats.length > 1) {
      categorySelect.appendChild(el('option', { value: '__ALL__' }, `— All ${cats.length} categories (list all on one page) —`));
    }
    cats.forEach(c => {
      const label = `${c.CATEGORY || '(no name)'}${c.SALARY ? ' — Salary: ' + c.SALARY : ''}${c.QUANTITY ? ' — Qty: ' + c.QUANTITY : ''}`;
      categorySelect.appendChild(el('option', { value: String(c[catEnt.pk]) }, label));
    });
  });
  const candidateSelect = el('select', { style: 'width:100%' }, [
    el('option', { value: '' }, '— none —'),
    ...candidates.map(c => el('option', { value: String(c[dtEnt.pk]) }, `${c.NAME || '(no name)'}${c.PASSPORTNO ? ' — ' + c.PASSPORTNO : ''}`)),
  ]);
  const agentLedgerSelect = el('select', { style: 'width:100%' }, [
    el('option', { value: '' }, '— none —'),
    ...(agentLedgerRows || []).map(r => el('option', { value: String(r[alEnt.pk]) }, ledgerEntryLabel(r))),
  ]);
  const employerLedgerSelect = el('select', { style: 'width:100%' }, [
    el('option', { value: '' }, '— none —'),
    ...(employerLedgerRows || []).map(r => el('option', { value: String(r[elEnt.pk]) }, ledgerEntryLabel(r))),
  ]);

  const overlay = el('div', { class: 'modal-overlay' }, [
    el('div', { class: 'modal-box', style: 'max-width:420px' }, [
      el('h3', {}, `Print "${report.name}" for…`),
      el('div', { class: 'f-field' }, [el('label', {}, 'Print for an Employer'), employerSelect]),
      el('div', { class: 'f-field' }, [el('label', {}, 'Which Category / demand?'), categorySelect]),
      el('div', { class: 'f-field' }, [el('label', {}, 'Or print for a Candidate'), candidateSelect]),
      el('div', { class: 'f-field' }, [el('label', {}, 'Or print for an Agent Ledger entry'), agentLedgerSelect]),
      el('div', { class: 'f-field' }, [el('label', {}, 'Or print for an Employer Ledger entry'), employerLedgerSelect]),
      el('div', { style: 'margin-top:16px;display:flex;justify-content:flex-end;gap:8px' }, [
        el('button', { class: 'btn btn-outline', onclick: () => overlay.remove() }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: () => {
          const candId = candidateSelect.value;
          const empId = employerSelect.value;
          const catId = categorySelect.value;
          const agentLedgerId = agentLedgerSelect.value;
          const employerLedgerId = employerLedgerSelect.value;
          if (candId) {
            const cand = candidates.find(c => String(c[dtEnt.pk]) === candId);
            overlay.remove();
            printReportForCandidate(report, cand);
          } else if (empId) {
            // No candidate row at all — just enough of a stand-in object so
            // resolveFieldValue's EMPLOYER.* lookup (via EMPID) and CATEGORY.*
            // lookup (via CATEGORYID, if a specific one was picked above)
            // still work correctly.
            overlay.remove();
            printReportForCandidate(report, { EMPID: empId, CATEGORYID: catId || undefined });
          } else if (agentLedgerId) {
            const row = (agentLedgerRows || []).find(r => String(r[alEnt.pk]) === agentLedgerId);
            overlay.remove();
            printReportForCandidate(report, row);
          } else if (employerLedgerId) {
            const row = (employerLedgerRows || []).find(r => String(r[elEnt.pk]) === employerLedgerId);
            overlay.remove();
            printReportForCandidate(report, row);
          } else {
            toast('Pick an Employer, a Candidate, or a Ledger entry first.');
          }
        } }, 'Print'),
      ]),
    ]),
  ]);
  document.body.appendChild(overlay);
}

// Reports can place a field from DATATABLE directly (field: "NAME"), or one
// from the candidate's linked Employer/Category record (field:
// "EMPLOYER.ARBICCOMPANY" / "CATEGORY.CATEGORYARBIC") — see the grouped
// "Add a field" dropdown in the report designer.
//
// DATATABLE has no direct EMPID column, so Employer is reached two ways:
//   1. Directly via candidate.EMPID, when printing via the Employer picker
//      (that flow builds a stand-in object with EMPID set directly).
//   2. Otherwise via the candidate's own Category (CATEGORYID -> that
//      Category row's EMPID) — the real path for an actual Candidate row.
// Category is reached directly via candidate.CATEGORYID. If any link in the
// chain is missing or the linked row can't be found, the field just prints
// blank rather than erroring.
function resolveFieldValue(candidate, fieldKey) {
  if (!candidate) return '';
  const findCategoryForCandidate = () => {
    if (candidate.CATEGORYID == null) return null;
    return (cache.CATEGORY || []).find(r => String(r.CATEGORYID) === String(candidate.CATEGORYID)) || null;
  };
  if (fieldKey.startsWith('EMPLOYER.')) {
    const name = fieldKey.slice('EMPLOYER.'.length);
    let empId = candidate.EMPID;
    if (empId == null) {
      const cat = findCategoryForCandidate();
      empId = cat ? cat.EMPID : null;
    }
    if (empId == null) return '';
    const emp = (cache.EMPLOYER || []).find(r => String(r.EMPID) === String(empId));
    return emp ? emp[name] : '';
  }
  if (fieldKey.startsWith('CATEGORY.')) {
    const name = fieldKey.slice('CATEGORY.'.length);
    const cat = findCategoryForCandidate();
    return cat ? cat[name] : '';
  }
  // Agent Ledger / Employer Ledger fields — unlike EMPLOYER./CATEGORY.
  // above, these don't need a lookup: when a report is printed "for an
  // Agent Ledger Entry" or "for an Employer Ledger Entry" (see the Print
  // picker), the record handed to this function already IS that ledger
  // row, so its own fields are read directly off it, prefix stripped.
  if (fieldKey.startsWith('AGENTLEDGER.')) {
    return candidate[fieldKey.slice('AGENTLEDGER.'.length)];
  }
  if (fieldKey.startsWith('EMPLOYERLEDGER.')) {
    return candidate[fieldKey.slice('EMPLOYERLEDGER.'.length)];
  }
  return candidate[fieldKey];
}

// Builds the HTML for ONE candidate's page of a report, plus any JsBarcode
// init calls it needs. Shared by both the single-candidate print (Reports
// page) and the bulk multi-candidate print (Search Candidates, below) — the
// only difference is how many of these get joined into one print document,
// and barcodeCounter is passed in so barcode element ids stay unique when
// multiple candidates' pages share one HTML document.
function buildCandidatePage(report, candidate, esc, barcodeCounter) {
  const barcodeInits = [];
  const pieces = (report.elements || []).map(elData => {
    const base = `position:absolute;left:${elData.x}px;top:${elData.y}px;`;
    if (elData.type === 'field') {
      // Special case: printing "All categories" for an Employer (see the
      // picker below) repeats THIS field once per category row that
      // employer has, stacked downward from where it was placed in the
      // designer — instead of a single value.
      if (elData.field.startsWith('CATEGORY.') && candidate.CATEGORYID === '__ALL__') {
        const catName = elData.field.slice('CATEGORY.'.length);
        // The Category list's checkbox print passes the exact rows that
        // were checked (candidate.__categoryRows__); the Reports page's
        // Employer picker has no such selection, so it falls back to every
        // category that employer has.
        const rows = candidate.__categoryRows__ ||
          (cache.CATEGORY || []).filter(c => String(c.EMPID) === String(candidate.EMPID));
        const rowHeight = elData.rowHeight || 24;
        const box = elData.w ? `width:${elData.w}px;${elData.h ? `height:${elData.h}px;` : ''}white-space:normal;word-break:break-word;overflow:hidden;` : 'white-space:nowrap;';
        return rows.map((r, i) =>
          `<div style="position:absolute;left:${elData.x}px;top:${elData.y + i * rowHeight}px;font-size:${elData.fontSize || 14}px;${box}">${esc(r[catName] ?? '')}</div>`
        ).join('\n');
      }
      const val = resolveFieldValue(candidate, elData.field);
      const box = elData.w ? `width:${elData.w}px;${elData.h ? `height:${elData.h}px;` : ''}white-space:normal;word-break:break-word;overflow:hidden;` : 'white-space:nowrap;';
      return `<div style="${base}font-size:${elData.fontSize || 14}px;${box}">${esc(val ?? '')}</div>`;
    }
    if (elData.type === 'text') {
      const box = elData.w ? `width:${elData.w}px;${elData.h ? `height:${elData.h}px;` : ''}white-space:normal;word-break:break-word;overflow:hidden;` : 'white-space:nowrap;';
      return `<div style="${base}font-size:${elData.fontSize || 14}px;${box}">${esc(elData.text)}</div>`;
    }
    if (elData.type === 'image') {
      return `<img src="${elData.src}" style="${base}width:${elData.w}px;height:${elData.h}px;object-fit:contain;">`;
    }
    if (elData.type === 'barcode') {
      const val = resolveFieldValue(candidate, elData.field);
      const id = `bc${barcodeCounter.n++}`;
      if (val != null && String(val).trim() !== '') {
        const barHeight = Math.max(20, (elData.h || 50) - 18);
        barcodeInits.push(
          `try { JsBarcode("#${id}", ${JSON.stringify(String(val))}, ` +
          `{ format: "CODE128", displayValue: true, height: ${barHeight}, margin: 0, fontSize: 12 }); } ` +
          `catch (e) { console.error('Barcode failed for ${elData.field}:', e); }`
        );
      }
      return `<div style="${base}width:${elData.w}px;height:${elData.h}px;">` +
             `<svg id="${id}" style="display:block;width:100%;height:100%;"></svg></div>`;
    }
    if (elData.type === 'agencyHeader' || elData.type === 'agencyFooter') {
      // Resolved from whoever is logged in RIGHT NOW, not from the report
      // itself — so the same saved report shows each agency's own
      // letterhead automatically. currentAgencyRow() reads from cache, no
      // extra round trip. Renders nothing if that agency hasn't set one.
      const agency = currentAgencyRow();
      const src = agency ? agency[elData.type === 'agencyHeader' ? 'HEADER' : 'FOOTER'] : '';
      if (!src) return '';
      return `<img src="${src}" style="${base}width:${elData.w}px;height:${elData.h}px;object-fit:contain;">`;
    }
    return '';
  }).join('\n');
  return { pieces, barcodeInits };
}

// Opens one print window containing every candidate's page back to back,
// each sized and scaled identically to the single-candidate print, with a
// page break in between so each candidate comes out on their own sheet.
// One row of report-print buttons. getSelectedRows() is called at click time
// (not once up front) so it always reflects whatever's currently checked.
// Shared by the Search Candidates page and the Employer list's print section.
function buildReportButtonsRow(reports, getSelectedRows) {
  if (!reports.length) return el('div', {});
  // Deliberately NOT the shared .toolbar class here — that class carries its
  // own padding (for when it's used as the main toolbar container), which
  // left visible space above/below this row no matter what margin was set
  // on it. This is its own minimal wrapper instead, so the space between it
  // and the search box above is only whatever's set right here.
  return el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;padding:0;margin:6px 0 12px;' },
    reports.map(r => el('button', {
      class: 'btn btn-outline',
      // The shared .btn class applies its own margin for buttons used
      // standalone elsewhere in the app — overriding it inline (which
      // always wins over a stylesheet class, regardless of CSS specificity)
      // is what keeps these tight against each other instead of spaced out.
      style: 'margin:0;',
      onclick: () => printReportForCandidates(r, getSelectedRows()),
    }, [el('i', { class: 'fa-solid fa-print' }), ` ${r.name}`]))
  );
}

function printReportForCandidates(report, candidates) {
  if (!candidates.length) { toast('Select at least one candidate first.'); return; }
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const size = PAGE_SIZES[report.pageSize] || PAGE_SIZES.letter;
  const barcodeCounter = { n: 0 };
  const allBarcodeInits = [];
  const pages = candidates.map((candidate, i) => {
    const { pieces, barcodeInits } = buildCandidatePage(report, candidate, esc, barcodeCounter);
    allBarcodeInits.push(...barcodeInits);
    const breakStyle = i < candidates.length - 1 ? 'page-break-after:always;' : '';
    return `<div class="scaleWrap" style="${breakStyle}"><div class="page">${pieces}</div></div>`;
  }).join('\n');
  const needsBarcodes = allBarcodeInits.length > 0;

  const MARGIN_PX = 18; // ~4.5mm at 96dpi — see printReportForCandidate for why
  const marginIn = (MARGIN_PX / 96).toFixed(4);
  const innerW = size.w - MARGIN_PX * 2;
  const innerH = size.h - MARGIN_PX * 2;
  const scaleX = innerW / size.w;
  const scaleY = innerH / size.h;

  const html = `<!DOCTYPE html><html><head><title>${esc(report.name)}</title>
    ${needsBarcodes ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.5/JsBarcode.all.min.js"><\/script>' : ''}
    <style>
      * { box-sizing: border-box; }
      html, body { margin:0; padding:0; }
      .scaleWrap { width:${innerW}px; height:${innerH}px; overflow:hidden; }
      .page { position:relative; width:${size.w}px; height:${size.h}px; transform:scale(${scaleX.toFixed(6)}, ${scaleY.toFixed(6)}); transform-origin:top left; font-family:Arial,sans-serif; color:#111; }
      @page { size: ${size.cssSize}; margin: ${marginIn}in; }
      @media print {
        html, body { width:${innerW}px; height:${innerH}px; }
      }
    </style></head><body>
    ${pages}
    ${needsBarcodes ? `<script>${allBarcodeInits.join('\n')}<\/script>` : ''}
    </body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  const doPrint = () => { win.focus(); win.print(); };
  if (win.document.readyState === 'complete') setTimeout(doPrint, 150);
  else win.onload = () => setTimeout(doPrint, 150);
}

function printReportForCandidate(report, candidate) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const size = PAGE_SIZES[report.pageSize] || PAGE_SIZES.letter;
  const barcodeCounter = { n: 0 };
  const { pieces, barcodeInits } = buildCandidatePage(report, candidate, esc, barcodeCounter);
  const needsBarcodes = barcodeInits.length > 0;

  // Real printers, unlike "Save as PDF", almost always have a small strip
  // around the edge of the paper they physically cannot print to. When the
  // page CSS asks for 0 margin (full bleed) — like before — a real printer
  // driver has no choice but to auto-shrink the WHOLE page by however much
  // it needs to fit everything inside that strip, and that shrink amount is
  // unpredictable and differs printer to printer. "Save as PDF" is a virtual
  // printer with no such physical limit, so it always prints at the exact
  // requested size — which is why it looked right there but not from a real
  // printer.
  //
  // Fix: build in a small (~4.5mm) safety margin ourselves, and scale the
  // designed page down by that same small, exact, known amount so it already
  // fits inside virtually every printer's real printable area. This makes
  // printed output consistent and predictable on real hardware — at the cost
  // of the page (and therefore "Save as PDF" too, from now on) being about
  // 4% smaller than pure full-bleed. That's not visible to the eye, and it
  // means the printer output will now match the PDF instead of coming out
  // smaller than it.
  const MARGIN_PX = 18; // ~4.5mm at 96dpi
  const marginIn = (MARGIN_PX / 96).toFixed(4);
  const innerW = size.w - MARGIN_PX * 2;
  const innerH = size.h - MARGIN_PX * 2;
  const scaleX = innerW / size.w;
  const scaleY = innerH / size.h;

  const html = `<!DOCTYPE html><html><head><title>${esc(report.name)}</title>
    ${needsBarcodes ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.5/JsBarcode.all.min.js"><\/script>' : ''}
    <style>
      * { box-sizing: border-box; }
      html, body { margin:0; padding:0; }
      .scaleWrap { width:${innerW}px; height:${innerH}px; overflow:hidden; }
      .page { position:relative; width:${size.w}px; height:${size.h}px; transform:scale(${scaleX.toFixed(6)}, ${scaleY.toFixed(6)}); transform-origin:top left; font-family:Arial,sans-serif; color:#111; }
      @page { size: ${size.cssSize}; margin: ${marginIn}in; }
      @media print {
        html, body { width:${innerW}px; height:${innerH}px; }
      }
    </style></head><body>
    <div class="scaleWrap"><div class="page">${pieces}</div></div>
    ${needsBarcodes ? `<script>${barcodeInits.join('\n')}<\/script>` : ''}
    </body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  // Wait for the new tab to finish loading (styles applied, @page size
  // registered, any images decoded) before printing. Calling win.print()
  // immediately after document.close() can race the browser's layout/paint,
  // which is what was causing the print preview to fall back to a default
  // page size and render everything smaller than the A4/Letter size that was
  // actually designed.
  const doPrint = () => { win.focus(); win.print(); };
  if (win.document.readyState === 'complete') setTimeout(doPrint, 150);
  else win.onload = () => setTimeout(doPrint, 150);
}


checkSession();
