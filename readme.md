# Recruit Expert — Dashboard

A real, multi-user web dashboard for your recruitment/accounting database —
sidebar navigation, a summary dashboard, searchable tables, add/edit forms,
and CSV report export for every entity (Agents, Companies, Categories,
Employers, Candidates, Receipts, Payments, Refunds, Visa Expenses,
Accounts, Transactions, Ledgers, and more).

It behaves like a desktop application (single-page, sidebar, instant
navigation) but runs in a browser — which is exactly what makes it usable
from any city, by multiple people, at the same time, unlike the original
Access file.

## 1. Set up the database (5–10 minutes)

1. Go to [supabase.com](https://supabase.com) → sign up free → **New
   Project**.
2. Once ready, go to **SQL Editor → New Query**, paste in the contents of
   `recruit-expert-schema-v2.sql`, and click **Run**.
3. Go to **Authentication → Users → Add User** and create a login for
   yourself and each staff member who needs access.
4. Go to **Project Settings → API** and copy the **Project URL** and
   **anon public** key.

## 2. Connect the app

Open `config.js` in a text editor and fill in the two values from step 1.4:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-public-key",
  APP_NAME: "Recruit Expert",
};
```

Save the file. That's the only edit needed.

## 3. Run it

**Quickest — no hosting at all:** double-click `index.html` to open it
directly in your browser. It'll work, but only on that one computer.

**For multi-user, multi-city access — host it (free):**
1. Go to [netlify.com](https://netlify.com) → sign up free.
2. Drag the whole `recruit-expert-app` folder onto Netlify's deploy page.
3. You'll get a live URL in seconds — share that with your team. Anyone
   who opens it and logs in with a Supabase account you created in step 1.3
   is working in the same live database, from anywhere.

## Important — please verify before relying on this

I built the field list for **Agent, Sector, Company, Category, Employer,
Datatable, Rec, Refund, VisaExpense, Pay, Account, and Transition**
directly from your relationship diagram — high confidence.

I could **not** open your actual `.accdb` file (no compatible tool
available in my environment), so **AgentLedger, Bio Data, EmployerLedger,
Receivable, Source, tblCompany, and tbl_User** are best-guess structures
based on their names and typical patterns for this kind of system —
not read from your real file. Before relying on this in production:

1. Open `Recurit_Expert_BE.accdb` in Access.
2. For each of those 7 tables, check Design View and compare the real
   field names against `recruit-expert-schema-v2.sql`.
3. Tell me what's different and I'll correct the schema and the app's
   `entities.js` to match exactly.

## How the app is structured

```
index.html      Page shell — loads the CSS/JS below
styles.css       All styling (sidebar, dashboard cards, tables, forms)
config.js         Your Supabase URL/key — the only file you edit
entities.js       Defines every table's fields/labels/relationships —
                    this one file drives the whole app. Add a table here
                    and it automatically gets a sidebar link, list view,
                    search, add/edit form, and CSV export.
app.js            All the logic — login, dashboard, generic CRUD screens
```

## Adding a table or field later

Open `entities.js` and either add a new object to the `ENTITIES` array
(for a new table) or add a field to an existing entity's `fields` array.
No other file needs to change — the dashboard, search, forms, and CSV
export all pick it up automatically.

## Security note

Every table requires a logged-in (Supabase Auth) user to read or write —
there is no public access at all, appropriate for internal financial data.
Anyone you create a login for in step 1.3 has full access to everything;
if you need different permission levels between staff later, that's a
follow-up enhancement, not something this version handles.
