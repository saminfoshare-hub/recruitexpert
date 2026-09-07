-- =========================================================================
-- RECRUIT EXPERT — Supabase Schema v2
-- Updated to match the refined relationship diagram + full table list.
--
-- IMPORTANT: Tables in the DIAGRAM (Agent, Datatable, Category, Employer,
-- Rec, Refund, VisaExpnece, Company, Pay, Sector, Account, Transition) are
-- built directly from your field-level diagram — high confidence.
--
-- Tables that appear in your table LIST but were not shown with fields in
-- the diagram (AgentLedger, Bio Data, EmployerLedger, Receivable, Source,
-- tbl_User, tblCompany) are BEST-GUESS structures based on their names and
-- normal accounting/recruitment patterns. Open each of these in Access,
-- check the real field list, and adjust before relying on this in
-- production — the SQL comments mark exactly which these are.
-- =========================================================================

-- ---------- AGENT ----------
create table if not exists agent (
  coid serial primary key,
  agencyid int,
  agentname text,
  agency text,
  resident text,
  tel text,
  mob text,
  email text,
  "check" text,
  created_at timestamptz not null default now()
);

-- ---------- SECTOR ----------
create table if not exists sector (
  sid serial primary key,
  coid int references agent(coid) on delete set null,
  sector text,
  created_at timestamptz not null default now()
);

-- ---------- COMPANY ----------
create table if not exists company (
  agencyid serial primary key,
  agencyname text,
  nameofowner text,
  ownertype text,
  officeaddress text,
  telephone text,
  mobilenumber text,
  created_at timestamptz not null default now()
);

-- ---------- CATEGORY ----------
create table if not exists category (
  categoryid serial primary key,
  empid int,
  agencyid int references company(agencyid) on delete set null,
  category text,
  categoryarabic text,
  reqtrade text,
  salary numeric(14,2),
  quantity int,
  created_at timestamptz not null default now()
);

-- ---------- EMPLOYER ----------
create table if not exists employer (
  empid serial primary key,
  agencyid int references company(agencyid) on delete set null,
  entrydate date,
  nameofemployer text,
  addressofemployer text,
  visano text,
  idno text,
  visadate date,
  created_at timestamptz not null default now()
);

-- ---------- DATATABLE (candidates) ----------
create table if not exists datatable (
  did serial primary key,
  coid int references agent(coid) on delete set null,
  nameofowner text,
  nameofegency text,
  categoryid int references category(categoryid) on delete set null,
  agencyid int references company(agencyid) on delete set null,
  name text,
  fathersname text,
  passportno text,
  created_at timestamptz not null default now()
);

-- ---------- REC (receipts) ----------
create table if not exists rec (
  recid serial primary key,
  coid int references agent(coid) on delete set null,
  receivedate date,
  description text,
  amount numeric(14,2),
  agencyid int references company(agencyid) on delete set null,
  type text,
  receiptno text,
  accid int,
  created_at timestamptz not null default now()
);

-- ---------- REFUND ----------
create table if not exists refund (
  refundid serial primary key,
  coid int references agent(coid) on delete set null,
  refunddate date,
  description text,
  refundamount numeric(14,2),
  created_at timestamptz not null default now()
);

-- ---------- VISAEXPENSE ----------
create table if not exists visaexpense (
  vexpid serial primary key,
  categoryid int references category(categoryid) on delete set null,
  empid int references employer(empid) on delete set null,
  visacost numeric(14,2),
  otherexp numeric(14,2),
  quantity int,
  nettotal numeric(14,2),
  created_at timestamptz not null default now()
);

-- ---------- PAY ----------
create table if not exists pay (
  payid serial primary key,
  empid int references employer(empid) on delete set null,
  paydate date,
  description text,
  payamount numeric(14,2),
  agencyid int references company(agencyid) on delete set null,
  paytype text,
  accid int,
  created_at timestamptz not null default now()
);

-- ---------- ACCOUNT ----------
create table if not exists account (
  accid serial primary key,
  name text,
  accountno text,
  accounttitle text,
  created_at timestamptz not null default now()
);

-- ---------- TRANSITION (ledger / transactions) ----------
create table if not exists transition (
  tid serial primary key,
  accid int references account(accid) on delete set null,
  date date,
  description text,
  debit numeric(14,2),
  credit numeric(14,2),
  created_at timestamptz not null default now()
);

alter table rec drop constraint if exists rec_accid_fkey;
alter table rec add constraint rec_accid_fkey foreign key (accid) references account(accid) on delete set null;
alter table pay drop constraint if exists pay_accid_fkey;
alter table pay add constraint pay_accid_fkey foreign key (accid) references account(accid) on delete set null;

-- =========================================================================
-- BEST-GUESS TABLES — verify field names in Access before relying on these
-- =========================================================================

-- Likely a running ledger of an agent's balance/activity over time
create table if not exists agentledger (
  id serial primary key,
  coid int references agent(coid) on delete set null,
  date date,
  description text,
  debit numeric(14,2),
  credit numeric(14,2),
  balance numeric(14,2),
  created_at timestamptz not null default now()
);

-- Likely candidate personal/biodata detail, one row per DATATABLE candidate
create table if not exists bio_data (
  id serial primary key,
  did int references datatable(did) on delete cascade,
  dob date,
  gender text,
  maritalstatus text,
  nationality text,
  religion text,
  height text,
  weight text,
  education text,
  experience text,
  address text,
  phone text,
  created_at timestamptz not null default now()
);

-- Likely a running ledger of an employer's balance/activity over time
create table if not exists employerledger (
  id serial primary key,
  empid int references employer(empid) on delete set null,
  date date,
  description text,
  debit numeric(14,2),
  credit numeric(14,2),
  balance numeric(14,2),
  created_at timestamptz not null default now()
);

-- Likely outstanding amounts owed (accounts receivable)
create table if not exists receivable (
  id serial primary key,
  agencyid int references company(agencyid) on delete set null,
  description text,
  amount numeric(14,2),
  duedate date,
  status text,
  created_at timestamptz not null default now()
);

-- Likely a lookup table (e.g. "source of candidate": Agent / Walk-in / Referral)
create table if not exists source (
  id serial primary key,
  name text,
  created_at timestamptz not null default now()
);

-- Likely a duplicate/older version of COMPANY — check in Access whether this
-- is still used or safe to leave out of the new system entirely.
create table if not exists tblcompany (
  id serial primary key,
  agencyname text,
  nameofowner text,
  officeaddress text,
  created_at timestamptz not null default now()
);

-- App login accounts. NOTE: for the dashboard built alongside this schema,
-- staff log in with Supabase Auth (Authentication → Users) instead of this
-- table — this is included only in case your old Access app used tbl_User
-- for its own internal login screen and you want to preserve that data.
create table if not exists tbl_user (
  id serial primary key,
  username text unique,
  fullname text,
  role text,
  created_at timestamptz not null default now()
);

-- =========================================================================
-- ROW LEVEL SECURITY — internal business data, staff-only, nothing public
-- =========================================================================
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'agent','sector','company','category','employer','datatable','rec','refund',
    'visaexpense','pay','account','transition','agentledger','bio_data',
    'employerledger','receivable','source','tblcompany','tbl_user'
  ])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "%s_staff_all" on %I;', t, t);
    execute format(
      'create policy "%s_staff_all" on %I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'');',
      t, t
    );
  end loop;
end $$;

-- =========================================================================
-- STAFF ACCOUNTS: Supabase Dashboard → Authentication → Users → Add User
-- =========================================================================
