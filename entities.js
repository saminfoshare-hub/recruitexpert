/* ==========================================================================
   ENTITY DEFINITIONS
   One object per database table. This drives the sidebar, list views,
   search, forms, and dashboard automatically — add a table here and the
   whole app gets a working screen for it.

   field types: text | number | date | textarea | select(FK)
   ========================================================================== */
window.ENTITIES = [
  // ---------------- CORE ----------------
  {
    key: 'agent', table: 'agent', pk: 'coid', label: 'Agents', icon: 'fa-user-tie',
    group: 'Core', displayField: 'agentname',
    fields: [
      { name: 'agentname', label: 'Agent Name', type: 'text', required: true },
      { name: 'agency', label: 'Agency', type: 'text' },
      { name: 'resident', label: 'Resident', type: 'text' },
      { name: 'tel', label: 'Telephone', type: 'text' },
      { name: 'mob', label: 'Mobile', type: 'text' },
      { name: 'email', label: 'Email', type: 'text' },
      { name: 'check', label: 'Check', type: 'text' },
    ],
  },
  {
    key: 'company', table: 'company', pk: 'agencyid', label: 'Companies', icon: 'fa-building',
    group: 'Core', displayField: 'agencyname',
    fields: [
      { name: 'agencyname', label: 'Agency Name', type: 'text', required: true },
      { name: 'nameofowner', label: 'Owner Name', type: 'text' },
      { name: 'ownertype', label: 'Owner Type', type: 'text' },
      { name: 'officeaddress', label: 'Office Address', type: 'textarea' },
      { name: 'telephone', label: 'Telephone', type: 'text' },
      { name: 'mobilenumber', label: 'Mobile Number', type: 'text' },
    ],
  },
  {
    key: 'category', table: 'category', pk: 'categoryid', label: 'Categories', icon: 'fa-layer-group',
    group: 'Core', displayField: 'category',
    fields: [
      { name: 'category', label: 'Category', type: 'text', required: true },
      { name: 'categoryarabic', label: 'Category (Arabic)', type: 'text' },
      { name: 'agencyid', label: 'Company', type: 'select', ref: 'company' },
      { name: 'reqtrade', label: 'Required Trade', type: 'text' },
      { name: 'salary', label: 'Salary', type: 'number' },
      { name: 'quantity', label: 'Quantity', type: 'number' },
      { name: 'empid', label: 'Employer ID', type: 'number' },
    ],
  },
  {
    key: 'employer', table: 'employer', pk: 'empid', label: 'Employers', icon: 'fa-briefcase',
    group: 'Core', displayField: 'nameofemployer',
    fields: [
      { name: 'nameofemployer', label: 'Employer Name', type: 'text', required: true },
      { name: 'agencyid', label: 'Company', type: 'select', ref: 'company' },
      { name: 'entrydate', label: 'Entry Date', type: 'date' },
      { name: 'addressofemployer', label: 'Address', type: 'textarea' },
      { name: 'visano', label: 'Visa No.', type: 'text' },
      { name: 'idno', label: 'ID No.', type: 'text' },
      { name: 'visadate', label: 'Visa Date', type: 'date' },
    ],
  },
  {
    key: 'datatable', table: 'datatable', pk: 'did', label: 'Candidates', icon: 'fa-id-card',
    group: 'Core', displayField: 'name',
    fields: [
      { name: 'name', label: 'Candidate Name', type: 'text', required: true },
      { name: 'fathersname', label: "Father's Name", type: 'text' },
      { name: 'passportno', label: 'Passport No.', type: 'text' },
      { name: 'coid', label: 'Agent', type: 'select', ref: 'agent' },
      { name: 'categoryid', label: 'Category', type: 'select', ref: 'category' },
      { name: 'agencyid', label: 'Company', type: 'select', ref: 'company' },
      { name: 'nameofowner', label: 'Name of Owner', type: 'text' },
      { name: 'nameofegency', label: 'Name of Agency', type: 'text' },
    ],
  },
  {
    key: 'bio_data', table: 'bio_data', pk: 'id', label: 'Candidate Bio Data', icon: 'fa-address-card',
    group: 'Core', displayField: 'id',
    fields: [
      { name: 'did', label: 'Candidate', type: 'select', ref: 'datatable', required: true },
      { name: 'dob', label: 'Date of Birth', type: 'date' },
      { name: 'gender', label: 'Gender', type: 'text' },
      { name: 'maritalstatus', label: 'Marital Status', type: 'text' },
      { name: 'nationality', label: 'Nationality', type: 'text' },
      { name: 'religion', label: 'Religion', type: 'text' },
      { name: 'height', label: 'Height', type: 'text' },
      { name: 'weight', label: 'Weight', type: 'text' },
      { name: 'education', label: 'Education', type: 'text' },
      { name: 'experience', label: 'Experience', type: 'textarea' },
      { name: 'address', label: 'Address', type: 'textarea' },
      { name: 'phone', label: 'Phone', type: 'text' },
    ],
  },
  {
    key: 'sector', table: 'sector', pk: 'sid', label: 'Sectors', icon: 'fa-diagram-project',
    group: 'Core', displayField: 'sector',
    fields: [
      { name: 'sector', label: 'Sector', type: 'text', required: true },
      { name: 'coid', label: 'Agent', type: 'select', ref: 'agent' },
    ],
  },
  {
    key: 'source', table: 'source', pk: 'id', label: 'Sources', icon: 'fa-signs-post',
    group: 'Core', displayField: 'name',
    fields: [
      { name: 'name', label: 'Source Name', type: 'text', required: true },
    ],
  },

  // ---------------- FINANCE ----------------
  {
    key: 'rec', table: 'rec', pk: 'recid', label: 'Receipts', icon: 'fa-receipt',
    group: 'Finance', displayField: 'receiptno',
    fields: [
      { name: 'receiptno', label: 'Receipt No.', type: 'text' },
      { name: 'coid', label: 'Agent', type: 'select', ref: 'agent' },
      { name: 'agencyid', label: 'Company', type: 'select', ref: 'company' },
      { name: 'accid', label: 'Account', type: 'select', ref: 'account' },
      { name: 'receivedate', label: 'Receive Date', type: 'date' },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'type', label: 'Type', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'pay', table: 'pay', pk: 'payid', label: 'Payments', icon: 'fa-money-bill-wave',
    group: 'Finance', displayField: 'payid',
    fields: [
      { name: 'empid', label: 'Employer', type: 'select', ref: 'employer' },
      { name: 'agencyid', label: 'Company', type: 'select', ref: 'company' },
      { name: 'accid', label: 'Account', type: 'select', ref: 'account' },
      { name: 'paydate', label: 'Pay Date', type: 'date' },
      { name: 'payamount', label: 'Amount', type: 'number', required: true },
      { name: 'paytype', label: 'Pay Type', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'refund', table: 'refund', pk: 'refundid', label: 'Refunds', icon: 'fa-rotate-left',
    group: 'Finance', displayField: 'refundid',
    fields: [
      { name: 'coid', label: 'Agent', type: 'select', ref: 'agent' },
      { name: 'refunddate', label: 'Refund Date', type: 'date' },
      { name: 'refundamount', label: 'Refund Amount', type: 'number' },
      { name: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'visaexpense', table: 'visaexpense', pk: 'vexpid', label: 'Visa Expenses', icon: 'fa-passport',
    group: 'Finance', displayField: 'vexpid',
    fields: [
      { name: 'categoryid', label: 'Category', type: 'select', ref: 'category' },
      { name: 'empid', label: 'Employer', type: 'select', ref: 'employer' },
      { name: 'visacost', label: 'Visa Cost', type: 'number' },
      { name: 'otherexp', label: 'Other Expense', type: 'number' },
      { name: 'quantity', label: 'Quantity', type: 'number' },
      { name: 'nettotal', label: 'Net Total', type: 'number' },
    ],
  },
  {
    key: 'account', table: 'account', pk: 'accid', label: 'Accounts', icon: 'fa-vault',
    group: 'Finance', displayField: 'name',
    fields: [
      { name: 'name', label: 'Account Name', type: 'text', required: true },
      { name: 'accountno', label: 'Account No.', type: 'text' },
      { name: 'accounttitle', label: 'Account Title', type: 'text' },
    ],
  },
  {
    key: 'transition', table: 'transition', pk: 'tid', label: 'Transactions', icon: 'fa-right-left',
    group: 'Finance', displayField: 'tid',
    fields: [
      { name: 'accid', label: 'Account', type: 'select', ref: 'account', required: true },
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'debit', label: 'Debit', type: 'number' },
      { name: 'credit', label: 'Credit', type: 'number' },
    ],
  },
  {
    key: 'agentledger', table: 'agentledger', pk: 'id', label: 'Agent Ledger', icon: 'fa-book',
    group: 'Finance', displayField: 'id',
    fields: [
      { name: 'coid', label: 'Agent', type: 'select', ref: 'agent', required: true },
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'debit', label: 'Debit', type: 'number' },
      { name: 'credit', label: 'Credit', type: 'number' },
      { name: 'balance', label: 'Balance', type: 'number' },
    ],
  },
  {
    key: 'employerledger', table: 'employerledger', pk: 'id', label: 'Employer Ledger', icon: 'fa-book-open',
    group: 'Finance', displayField: 'id',
    fields: [
      { name: 'empid', label: 'Employer', type: 'select', ref: 'employer', required: true },
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'debit', label: 'Debit', type: 'number' },
      { name: 'credit', label: 'Credit', type: 'number' },
      { name: 'balance', label: 'Balance', type: 'number' },
    ],
  },
  {
    key: 'receivable', table: 'receivable', pk: 'id', label: 'Receivables', icon: 'fa-hand-holding-dollar',
    group: 'Finance', displayField: 'id',
    fields: [
      { name: 'agencyid', label: 'Company', type: 'select', ref: 'company' },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'duedate', label: 'Due Date', type: 'date' },
      { name: 'status', label: 'Status', type: 'text' },
    ],
  },
];

// Entities shown as dashboard summary cards: [entityKey, cardLabel, isMoney, sumField]
window.DASHBOARD_CARDS = [
  ['datatable', 'Candidates', false, null],
  ['agent', 'Agents', false, null],
  ['company', 'Companies', false, null],
  ['employer', 'Employers', false, null],
  ['rec', 'Total Receipts', true, 'amount'],
  ['pay', 'Total Payments', true, 'payamount'],
];
