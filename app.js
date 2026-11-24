const toast = document.getElementById('toast');
let toastTimer;
function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

const API_BASE = window.LEDGERLENS_API || 'http://localhost:8001/api';
let apiConnected = false;
let apiTransactions = [];
let apiInvoices = [];
let selectedTransaction = null;
let currentReportRows = [];
let currentUser = null;
async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem('ledgerlens-token');
  if (token && !path.startsWith('/auth/login') && !path.startsWith('/auth/register')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith('/auth/')) {
    sessionStorage.removeItem('ledgerlens-token');
    showAuthGate();
    setAuthMode(false);
  }
  if (!response.ok) throw new Error(data.detail || 'The API request failed.');
  return data;
}

const authGate = document.getElementById('authGate');
function showAuthGate() {
  authGate.hidden = false;
  document.getElementById('authError').textContent = '';
}
function hideAuthGate() { authGate.hidden = true; }
function setAuthMode(register) {
  document.getElementById('loginForm').hidden = register;
  document.getElementById('registerForm').hidden = !register;
  document.getElementById('authTitle').textContent = register ? 'Create your workspace' : 'Welcome back';
  document.getElementById('authCopy').textContent = register ? 'Set up a secure account for your business.' : 'Sign in to your secure workspace.';
  document.getElementById('authSwitch').hidden = register;
  document.getElementById('loginSwitch').hidden = !register;
  document.getElementById('authError').textContent = '';
}
document.getElementById('showRegister').addEventListener('click', () => setAuthMode(true));
document.getElementById('showLogin').addEventListener('click', () => setAuthMode(false));

async function acceptLogin(result) {
  currentUser = result.user;
  sessionStorage.setItem('ledgerlens-token', result.access_token);
  apiConnected = true;
  hideAuthGate();
  document.querySelector('.workspace strong').textContent = result.user.workspace_name;
  document.querySelector('.profile-copy strong').textContent = result.user.email;
  document.querySelector('.profile-copy small').textContent = `${result.user.role} · LedgerLens`;
  await refreshDashboard();
  notify(`Signed in to ${result.user.workspace_name}.`);
}
document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = new URLSearchParams({ username: form.get('email'), password: form.get('password') });
  try {
    await acceptLogin(await apiRequest('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }));
  } catch (error) { document.getElementById('authError').textContent = error.message; }
});
document.getElementById('registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = { email: form.get('email'), password: form.get('password'), workspace_name: form.get('workspace_name') };
  try {
    await acceptLogin(await apiRequest('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
  } catch (error) { document.getElementById('authError').textContent = error.message; }
});
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('ledgerlens-token');
  currentUser = null;
  apiTransactions = [];
  apiInvoices = [];
  showAuthGate();
  setAuthMode(false);
});

const modalBackdrop = document.getElementById('modalBackdrop');
function openModal() {
  document.getElementById('invoiceForm').reset();
  extractStatus.textContent = '';
  modalBackdrop.classList.add('open');
  setTimeout(() => document.querySelector('#invoiceForm input[name="customer"]')?.focus(), 100);
}
function closeModal() { modalBackdrop.classList.remove('open'); }
document.getElementById('addInvoiceBtn').addEventListener('click', openModal);
document.getElementById('modalClose').addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', event => { if (event.target === modalBackdrop) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

document.getElementById('invoiceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const data = new FormData(formElement);
  const payload = { number: data.get('number'), customer: data.get('customer'), amount: Number(data.get('amount')), due_date: data.get('due') };
  const submitButton = formElement.querySelector('[type="submit"]');
  if (!apiConnected) { extractStatus.textContent = 'Connect to the LedgerLens API before saving invoices.'; return; }
  submitButton.disabled = true;
  try {
    const invoice = await apiRequest('/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await refreshDashboard();
    formElement.reset();
    extractStatus.textContent = '';
    closeModal();
    notify(`${invoice.number} saved to your invoices.`);
  } catch (error) {
    extractStatus.textContent = error.message;
  } finally { submitButton.disabled = false; }
});

const fileInput = document.getElementById('fileInput');
document.getElementById('importBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (!fileInput.files.length) return;
  const file = fileInput.files[0];
  if (!apiConnected) {
    notify('Connect to LedgerLens before importing a statement.');
    fileInput.value = '';
    return;
  }
  const form = new FormData();
  form.append('file', file);
  apiRequest('/transactions/import', { method: 'POST', body: form })
    .then(result => { notify(`${result.added} transactions imported${result.skipped_duplicates ? `; ${result.skipped_duplicates} duplicates skipped` : ''}.`); refreshDashboard(); })
    .catch(error => notify(error.message));
  fileInput.value = '';
});

const invoiceFile = document.getElementById('invoiceFile');
const extractStatus = document.getElementById('extractStatus');
invoiceFile.addEventListener('change', async () => {
  const file = invoiceFile.files?.[0];
  if (!file) return;
  if (!apiConnected) {
    extractStatus.textContent = 'Sign in and connect to the API to extract invoice details.';
    invoiceFile.value = '';
    return;
  }
  extractStatus.textContent = 'Reading the invoice…';
  const form = new FormData();
  form.append('file', file);
  try {
    const fields = await apiRequest('/invoices/extract', { method: 'POST', body: form });
    const invoiceForm = document.getElementById('invoiceForm');
    if (fields.customer) invoiceForm.elements.customer.value = fields.customer;
    if (fields.invoice_number) invoiceForm.elements.number.value = fields.invoice_number;
    if (fields.amount != null) invoiceForm.elements.amount.value = fields.amount;
    if (fields.due_date) invoiceForm.elements.due.value = fields.due_date;
    extractStatus.textContent = fields.needs_review
      ? 'Some fields were unclear. Check the extracted values and fill in anything missing before saving.'
      : 'Details extracted. Review each field before saving the invoice.';
  } catch (error) {
    extractStatus.textContent = error.message;
  } finally {
    invoiceFile.value = '';
  }
});

let activeFilter = 'all';
const searchInput = document.getElementById('searchInput');
function filterRows() {
  const query = searchInput.value.trim().toLowerCase();
  const source = document.getElementById('transactionSourceFilter').value;
  let shown = 0;
  const rows = [...document.querySelectorAll('#transactionsBody tr')];
  rows.forEach(row => {
    const status = row.dataset.status;
    const matchFilter = activeFilter === 'all' || (activeFilter === 'matched' ? status === 'matched' : status === 'review');
    const matchSearch = !query || row.dataset.search.includes(query);
    const searchText = row.dataset.search;
    const rowSource = row.dataset.source || (searchText.includes('mpesa') || searchText.includes('m-pesa') || searchText.includes('safaricom') ? 'mpesa' : searchText.includes('cash') ? 'cash' : 'bank');
    const matchSource = source === 'all' || rowSource === source;
    row.hidden = !(matchFilter && matchSearch && matchSource);
    if (!row.hidden) shown++;
  });
  document.getElementById('shownCount').textContent = shown;
  document.getElementById('totalCount').textContent = rows.length;
}
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelector('.tab.active')?.classList.remove('active');
  tab.classList.add('active');
  activeFilter = tab.dataset.filter;
  filterRows();
}));
searchInput.addEventListener('input', filterRows);
document.getElementById('transactionSourceFilter').addEventListener('change', filterRows);
filterRows();

document.getElementById('confirmMatch').addEventListener('click', () => {
  if (!apiConnected || !selectedTransaction?.id) {
    notify('Connect to LedgerLens and select a saved payment before confirming a match.');
    return;
  }
  if (!selectedTransaction.suggested_invoice_id) {
    notify('Choose an invoice with Find another before confirming this match.');
    return;
  }
  apiRequest('/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_id: selectedTransaction.id, invoice_id: selectedTransaction.suggested_invoice_id }) })
    .then(() => { notify('Match confirmed and saved.'); refreshDashboard(); })
    .catch(error => notify(error.message));
});
document.getElementById('declineMatch').addEventListener('click', openCandidatePicker);
document.getElementById('exportTransactionsBtn').addEventListener('click', exportTransactionsCsv);
document.getElementById('workflowHelp').addEventListener('click', () => notify('Import a statement, review matches, then confirm to reconcile.'));
document.getElementById('cashReportLink').addEventListener('click', event => {
  event.preventDefault();
  document.querySelector('.main-nav a[data-page="Reports"]').click();
});

document.querySelectorAll('.main-nav a[data-page]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  document.querySelector('.main-nav a.active')?.classList.remove('active');
  link.classList.add('active');
  document.querySelector('.breadcrumbs strong').textContent = link.dataset.page;
  const overviewPage = link.dataset.page === 'Overview';
  const transactionsPage = link.dataset.page === 'Transactions';
  const invoicesPage = link.dataset.page === 'Invoices';
  const exceptionsPage = link.dataset.page === 'Exceptions';
  const reportsPage = link.dataset.page === 'Reports';
  const customersPage = link.dataset.page === 'Customers';
  const settingsPage = link.dataset.page === 'Settings';
  const auditPage = link.dataset.page === 'Audit Log';
  document.getElementById('reconciliationPage').hidden = invoicesPage || exceptionsPage || reportsPage || customersPage || settingsPage || auditPage;
  document.getElementById('invoicesPage').hidden = !invoicesPage;
  document.getElementById('exceptionsPage').hidden = !exceptionsPage;
  document.getElementById('reportsPage').hidden = !reportsPage;
  document.getElementById('customersPage').hidden = !customersPage;
  document.getElementById('settingsPage').hidden = !settingsPage;
  document.getElementById('auditPage').hidden = !auditPage;
  if (overviewPage) window.scrollTo({ top: 0, behavior: 'smooth' });
  else if (transactionsPage) {
    searchInput.value = '';
    document.getElementById('transactionSourceFilter').value = 'all';
    document.querySelector('.tab[data-filter="all"]').click();
    document.querySelector('.transactions-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  else if (invoicesPage) renderInvoices();
  else if (exceptionsPage) renderExceptions();
  else if (reportsPage) renderReports();
  else if (customersPage) renderCustomers();
  else if (settingsPage) renderSettings();
  else if (auditPage) renderAuditLog();
}));
document.querySelector('.brand:not(.auth-brand)').addEventListener('click', event => {
  event.preventDefault();
  document.querySelector('.main-nav a[data-page="Overview"]').click();
});
function returnToReconciliation() {
  document.getElementById('invoicesPage').hidden = true;
  document.getElementById('exceptionsPage').hidden = true;
  document.getElementById('reportsPage').hidden = true;
  document.getElementById('customersPage').hidden = true;
  document.getElementById('settingsPage').hidden = true;
  document.getElementById('auditPage').hidden = true;
  document.getElementById('reconciliationPage').hidden = false;
  document.querySelector('.main-nav a.active')?.classList.remove('active');
  document.querySelector('.main-nav a[data-page="Reconciliation"]')?.classList.add('active');
  document.querySelector('.breadcrumbs strong').textContent = 'Reconciliation';
}
document.getElementById('backToReconciliation').addEventListener('click', event => { event.preventDefault(); returnToReconciliation(); });
document.getElementById('exceptionsBackLink').addEventListener('click', event => { event.preventDefault(); returnToReconciliation(); });
document.getElementById('exceptionsRefreshBtn').addEventListener('click', () => refreshDashboard().catch(error => notify(error.message)));
document.getElementById('exceptionSearch').addEventListener('input', renderExceptions);
document.getElementById('reportsBackLink').addEventListener('click', event => { event.preventDefault(); returnToReconciliation(); });
document.getElementById('customersBackLink').addEventListener('click', event => { event.preventDefault(); returnToReconciliation(); });
document.getElementById('customerSearch').addEventListener('input', renderCustomers);
document.getElementById('customerAddInvoiceBtn').addEventListener('click', openModal);
document.getElementById('settingsBackLink').addEventListener('click', event => { event.preventDefault(); returnToReconciliation(); });
document.getElementById('auditBackLink').addEventListener('click', event => { event.preventDefault(); returnToReconciliation(); });
document.getElementById('auditRefreshBtn').addEventListener('click', renderAuditLog);
document.getElementById('workspaceSettingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const status = document.getElementById('workspaceSettingsStatus');
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = '';
  try {
    const result = await apiRequest('/workspace', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.elements.name.value }) });
    if (currentUser) currentUser.workspace_name = result.name;
    document.querySelector('.workspace strong').textContent = result.name;
    status.textContent = 'Workspace name updated.';
    notify('Workspace name updated.');
  } catch (error) { status.classList.add('error'); status.textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById('passwordSettingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('passwordSettingsStatus');
  const button = form.querySelector('[type="submit"]');
  if (form.elements.new_password.value !== form.elements.confirm_password.value) {
    status.classList.add('error');
    status.textContent = 'The new passwords do not match.';
    return;
  }
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = '';
  try {
    await apiRequest('/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_password: form.elements.current_password.value, new_password: form.elements.new_password.value }) });
    form.reset();
    status.textContent = 'Password changed successfully.';
    notify('Password updated.');
  } catch (error) { status.classList.add('error'); status.textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById('reportRange').addEventListener('change', renderReports);
document.getElementById('exportReportBtn').addEventListener('click', exportReportCsv);
document.getElementById('invoiceUploadPageBtn').addEventListener('click', () => { openModal(); setTimeout(() => invoiceFile.click(), 120); });
document.getElementById('invoiceAddPageBtn').addEventListener('click', openModal);
document.getElementById('invoiceEmptyUploadBtn').addEventListener('click', () => { openModal(); setTimeout(() => invoiceFile.click(), 120); });
document.getElementById('invoiceSearch').addEventListener('input', renderInvoices);
document.querySelector('.tip-card > button').addEventListener('click', event => event.currentTarget.closest('.tip-card').remove());
document.querySelector('.top-actions button[aria-label="Search"]').addEventListener('click', () => {
  document.querySelector('.main-nav a[data-page="Transactions"]').click();
  searchInput.focus();
});
document.querySelector('.top-actions button[aria-label="Notifications"]').addEventListener('click', () => {
  document.querySelector('.main-nav a[data-page="Exceptions"]').click();
});

function formatKes(value) {
  return `KES ${Number(value).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
}
function renderInvoices() {
  const body = document.getElementById('invoicesBody');
  if (!body) return;
  const query = document.getElementById('invoiceSearch').value.trim().toLowerCase();
  const filtered = apiInvoices.filter(invoice => `${invoice.number} ${invoice.customer} ${invoice.status}`.toLowerCase().includes(query));
  body.replaceChildren();
  filtered.forEach(invoice => {
    const balance = Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0));
    const statusClass = invoice.status === 'paid' ? 'matched-status' : invoice.status === 'overdue' ? 'unmatched-status' : 'review-status';
    const row = document.createElement('tr');
    const dueDate = new Date(`${invoice.due_date}T00:00:00`).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
    row.innerHTML = '<td class="invoice-number-cell"></td><td class="invoice-customer-cell"></td><td class="invoice-due-cell"></td><td class="invoice-amount-cell"></td><td class="invoice-paid-cell"></td><td class="invoice-balance-cell"></td><td><span class="status"><i></i><span class="invoice-status-label"></span></span></td>';
    row.querySelector('.invoice-number-cell').textContent = invoice.number;
    row.querySelector('.invoice-customer-cell').textContent = invoice.customer;
    row.querySelector('.invoice-due-cell').textContent = dueDate;
    row.querySelector('.invoice-amount-cell').textContent = formatKes(invoice.amount);
    row.querySelector('.invoice-paid-cell').textContent = formatKes(invoice.paid_amount || 0);
    row.querySelector('.invoice-balance-cell').textContent = formatKes(balance);
    row.querySelector('.status').classList.add(statusClass);
    row.querySelector('.invoice-status-label').textContent = invoice.status;
    body.append(row);
  });
  const overdue = apiInvoices.filter(invoice => invoice.status === 'overdue').length;
  const outstanding = apiInvoices.reduce((total, invoice) => total + Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0)), 0);
  document.getElementById('invoiceCountStat').textContent = apiInvoices.length.toLocaleString();
  document.getElementById('invoiceOutstandingStat').textContent = formatKes(outstanding);
  document.getElementById('invoiceOverdueStat').textContent = overdue.toLocaleString();
  document.getElementById('invoiceEmpty').hidden = filtered.length > 0;
}
function renderExceptions() {
  const body = document.getElementById('exceptionsBody');
  if (!body) return;
  const pending = apiTransactions.filter(item => Number(item.amount) > 0 && item.match_status !== 'matched');
  document.querySelector('.main-nav a[data-page="Exceptions"] .nav-count').textContent = pending.length;
  const query = document.getElementById('exceptionSearch').value.trim().toLowerCase();
  const filtered = pending.filter(item => `${item.description} ${item.customer || ''} ${item.reference || ''} ${item.suggested_invoice_number || ''}`.toLowerCase().includes(query));
  body.replaceChildren();
  filtered.forEach(item => {
    const invoice = apiInvoices.find(candidate => candidate.id === item.suggested_invoice_id);
    const unapplied = Math.max(0, Number(item.amount) - Number(item.matched_amount || 0));
    const statusText = item.match_status === 'partial' ? 'Partial match' : item.match_status === 'unmatched' ? 'Unmatched' : 'Review match';
    const statusClass = item.match_status === 'unmatched' ? 'unmatched-status' : 'review-status';
    const row = document.createElement('tr');
    const dateLabel = new Date(`${item.date}T00:00:00`).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
    row.innerHTML = '<td class="exception-date"></td><td class="exception-description"></td><td class="exception-party"></td><td class="exception-amount"></td><td class="exception-invoice"></td><td><span class="status"><i></i><span class="exception-status-label"></span></span></td><td><button type="button" class="button button-small review-exception">Review</button></td>';
    row.querySelector('.exception-date').textContent = dateLabel;
    row.querySelector('.exception-description').textContent = item.description;
    row.querySelector('.exception-party').textContent = [item.customer, item.reference ? `Ref ${item.reference}` : item.account].filter(Boolean).join(' · ') || '—';
    row.querySelector('.exception-amount').textContent = formatKes(unapplied);
    row.querySelector('.exception-invoice').textContent = invoice?.number || item.suggested_invoice_number || 'No suggestion';
    row.querySelector('.status').classList.add(statusClass);
    row.querySelector('.exception-status-label').textContent = statusText;
    row.querySelector('.review-exception').addEventListener('click', () => openTransactionReview(item.id));
    body.append(row);
  });
  const partialCount = pending.filter(item => item.match_status === 'partial').length;
  const reviewAmount = pending.reduce((total, item) => total + Math.max(0, Number(item.amount) - Number(item.matched_amount || 0)), 0);
  document.getElementById('exceptionCountStat').textContent = pending.length.toLocaleString();
  document.getElementById('exceptionPartialStat').textContent = partialCount.toLocaleString();
  document.getElementById('exceptionAmountStat').textContent = formatKes(reviewAmount);
  const empty = document.getElementById('exceptionsEmpty');
  empty.hidden = filtered.length > 0;
  empty.querySelector('strong').textContent = pending.length && query ? 'No payments match your search' : 'Nothing needs review';
  empty.querySelector('p').textContent = pending.length && query ? 'Try another customer, reference, or invoice number.' : 'All incoming payments are matched. New statement imports will appear here if they need attention.';
}
function renderReports() {
  const monthsBack = Number(document.getElementById('reportRange').value);
  const now = new Date();
  const firstMonth = new Date(now.getFullYear(), now.getMonth() - monthsBack + 1, 1);
  const rows = [];
  for (let i = 0; i < monthsBack; i++) {
    const month = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + i, 1);
    const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
    rows.push({ key, month, incoming: 0, outgoing: 0, net: 0, reconciled: 0 });
  }
  const byMonth = new Map(rows.map(row => [row.key, row]));
  apiTransactions.forEach(transaction => {
    const row = byMonth.get(String(transaction.date).slice(0, 7));
    if (!row) return;
    const amount = Number(transaction.amount);
    if (amount > 0) row.incoming += amount;
    else if (amount < 0) row.outgoing += Math.abs(amount);
    row.reconciled += Number(transaction.matched_amount || 0);
  });
  rows.forEach(row => { row.net = row.incoming - row.outgoing; });
  currentReportRows = rows;
  const incoming = rows.reduce((total, row) => total + row.incoming, 0);
  const outgoing = rows.reduce((total, row) => total + row.outgoing, 0);
  const outstanding = apiInvoices.reduce((total, invoice) => total + Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0)), 0);
  document.getElementById('reportInflowStat').textContent = formatKes(incoming);
  document.getElementById('reportOutflowStat').textContent = formatKes(outgoing);
  document.getElementById('reportNetStat').textContent = formatKes(incoming - outgoing);
  document.getElementById('reportOutstandingStat').textContent = formatKes(outstanding);

  const tbody = document.getElementById('reportRows');
  tbody.replaceChildren();
  rows.slice().reverse().forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="report-month-cell"></td><td class="report-incoming-cell"></td><td class="report-outgoing-cell"></td><td class="report-net-cell"></td><td class="report-reconciled-cell"></td>';
    tr.querySelector('.report-month-cell').textContent = row.month.toLocaleDateString('en-KE', { month: 'long', year: 'numeric' });
    tr.querySelector('.report-incoming-cell').textContent = formatKes(row.incoming);
    tr.querySelector('.report-outgoing-cell').textContent = formatKes(row.outgoing);
    tr.querySelector('.report-net-cell').textContent = formatKes(row.net);
    tr.querySelector('.report-reconciled-cell').textContent = formatKes(row.reconciled);
    tbody.append(tr);
  });
  renderReportChart(rows);
  document.getElementById('reportEmpty').hidden = apiTransactions.some(transaction => {
    const key = String(transaction.date).slice(0, 7);
    return byMonth.has(key);
  });
}
function renderCustomers() {
  const customers = new Map();
  apiInvoices.forEach(invoice => {
    const name = invoice.customer.trim();
    const key = name.toLocaleLowerCase();
    if (!customers.has(key)) customers.set(key, { name, invoices: [], total: 0, paid: 0, balance: 0, overdue: false });
    const customer = customers.get(key);
    const balance = Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0));
    customer.invoices.push(invoice);
    customer.total += Number(invoice.amount);
    customer.paid += Number(invoice.paid_amount || 0);
    customer.balance += balance;
    if (invoice.status === 'overdue') customer.overdue = true;
  });
  const list = [...customers.values()].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  const query = document.getElementById('customerSearch').value.trim().toLocaleLowerCase();
  const filtered = list.filter(customer => customer.name.toLocaleLowerCase().includes(query));
  document.getElementById('customerCountStat').textContent = list.length.toLocaleString();
  document.getElementById('customerInvoicedStat').textContent = formatKes(list.reduce((total, customer) => total + customer.total, 0));
  document.getElementById('customerBalanceStat').textContent = formatKes(list.reduce((total, customer) => total + customer.balance, 0));
  const body = document.getElementById('customersBody');
  body.replaceChildren();
  filtered.forEach(customer => {
    const status = customer.balance <= 0 ? 'Settled' : customer.overdue ? 'Overdue' : 'Open';
    const statusClass = status === 'Settled' ? 'matched-status' : status === 'Overdue' ? 'unmatched-status' : 'review-status';
    const row = document.createElement('tr');
    row.innerHTML = '<td class="customer-name-cell"></td><td class="customer-invoice-count"></td><td class="customer-total-cell"></td><td class="customer-paid-cell"></td><td class="customer-balance-cell"></td><td><span class="status"><i></i><span class="customer-status-label"></span></span></td><td><button type="button" class="button button-small customer-invoices-button">View invoices</button></td>';
    row.querySelector('.customer-name-cell').textContent = customer.name;
    row.querySelector('.customer-invoice-count').textContent = customer.invoices.length.toLocaleString();
    row.querySelector('.customer-total-cell').textContent = formatKes(customer.total);
    row.querySelector('.customer-paid-cell').textContent = formatKes(customer.paid);
    row.querySelector('.customer-balance-cell').textContent = formatKes(customer.balance);
    row.querySelector('.status').classList.add(statusClass);
    row.querySelector('.customer-status-label').textContent = status;
    row.querySelector('.customer-invoices-button').addEventListener('click', () => showCustomerInvoices(customer.name));
    body.append(row);
  });
  const empty = document.getElementById('customersEmpty');
  empty.hidden = filtered.length > 0;
  empty.querySelector('strong').textContent = list.length && query ? 'No customers match your search' : 'No customers found';
  empty.querySelector('p').textContent = list.length && query ? 'Try another customer name.' : 'Add an invoice to start tracking a customer balance.';
}
function showCustomerInvoices(name) {
  document.querySelector('.main-nav a.active')?.classList.remove('active');
  document.querySelector('.main-nav a[data-page="Invoices"]')?.classList.add('active');
  document.querySelector('.breadcrumbs strong').textContent = 'Invoices';
  document.getElementById('customersPage').hidden = true;
  document.getElementById('settingsPage').hidden = true;
  document.getElementById('reportsPage').hidden = true;
  document.getElementById('exceptionsPage').hidden = true;
  document.getElementById('reconciliationPage').hidden = true;
  document.getElementById('invoicesPage').hidden = false;
  document.getElementById('invoiceSearch').value = name;
  renderInvoices();
}
function renderSettings() {
  if (!currentUser) return;
  document.getElementById('settingsWorkspaceName').value = currentUser.workspace_name;
  document.getElementById('settingsWorkspaceName').disabled = currentUser.role !== 'owner';
  document.querySelector('#workspaceSettingsForm [type="submit"]').disabled = currentUser.role !== 'owner';
  document.getElementById('settingsEmail').textContent = currentUser.email;
  document.getElementById('settingsRole').textContent = currentUser.role;
  document.getElementById('settingsWorkspaceId').textContent = currentUser.workspace_id;
}
async function renderAuditLog() {
  const body = document.getElementById('auditBody');
  const error = document.getElementById('auditError');
  const empty = document.getElementById('auditEmpty');
  body.replaceChildren(); error.textContent = ''; empty.hidden = true;
  try {
    const events = await apiRequest('/audit?limit=100');
    document.getElementById('auditCount').textContent = `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
    empty.hidden = events.length > 0;
    events.forEach(event => {
      const row = document.createElement('tr');
      const action = document.createElement('td'); action.className = 'audit-action'; action.textContent = auditActionLabel(event.action);
      const actor = document.createElement('td'); actor.textContent = event.actor_email || `User #${event.actor_id}`;
      const record = document.createElement('td'); record.textContent = `${event.entity_type.replaceAll('_', ' ')}${event.entity_id ? ` #${event.entity_id}` : ''}`;
      const details = document.createElement('td');
      const changeEntries = Object.entries(event.changes || {}).filter(([key]) => !['password', 'token', 'secret'].includes(key.toLowerCase()));
      details.textContent = changeEntries.length ? changeEntries.map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`).join(' · ') : '—';
      const time = document.createElement('td'); time.textContent = new Date(event.created_at).toLocaleString();
      row.append(action, actor, record, details, time); body.append(row);
    });
  } catch (requestError) {
    document.getElementById('auditCount').textContent = 'Unavailable';
    error.textContent = requestError.message;
  }
}
function auditActionLabel(action) {
  return ({'account.password_changed':'Password changed','workspace.renamed':'Workspace renamed','invoice.created':'Invoice created','transaction.created':'Transaction added','transactions.imported':'Statement imported','match.confirmed':'Match confirmed'})[action] || action.replaceAll('.', ' ').replaceAll('_', ' ');
}
function renderReportChart(rows) {
  const chart = document.getElementById('reportChart');
  const max = Math.max(1, ...rows.flatMap(row => [row.incoming, row.outgoing]));
  const bars = rows.map(row => {
    const incomingHeight = Math.round(row.incoming / max * 150);
    const outgoingHeight = Math.round(row.outgoing / max * 150);
    const label = row.month.toLocaleDateString('en-KE', { month: 'short' });
    return `<div class="report-month"><div class="report-bar-pair"><i class="report-inflow-bar" style="height:${incomingHeight}px" title="Incoming ${formatKes(row.incoming)}"></i><i class="report-outflow-bar" style="height:${outgoingHeight}px" title="Outgoing ${formatKes(row.outgoing)}"></i></div><small>${label}</small></div>`;
  }).join('');
  chart.innerHTML = `<div class="report-axis"><span>${formatKes(max)}</span><span>${formatKes(max / 2)}</span><span>KES 0</span></div><div class="report-plot"><div class="report-grid-lines"><i></i><i></i><i></i></div><div class="report-bars">${bars}</div></div>`;
}
function exportReportCsv() {
  if (!currentReportRows.length) { notify('Choose a report period first.'); return; }
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  const lines = [
    ['Month', 'Incoming (KES)', 'Outgoing (KES)', 'Net movement (KES)', 'Reconciled (KES)'].map(quote).join(','),
    ...currentReportRows.slice().reverse().map(row => [row.month.toLocaleDateString('en-KE', { month: 'long', year: 'numeric' }), row.incoming.toFixed(2), row.outgoing.toFixed(2), row.net.toFixed(2), row.reconciled.toFixed(2)].map(quote).join(',')),
  ];
  const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ledgerlens-report.csv';
  link.click();
  URL.revokeObjectURL(url);
  notify('Report CSV downloaded.');
}
function openTransactionReview(transactionId) {
  selectedTransaction = apiTransactions.find(item => item.id === transactionId);
  if (!selectedTransaction) return;
  searchInput.value = '';
  document.querySelector('.tab[data-filter="all"]').click();
  returnToReconciliation();
  showSuggestion(selectedTransaction, apiInvoices.find(item => item.id === selectedTransaction.suggested_invoice_id));
}
function statusLabel(status) {
  return status === 'matched' ? ['matched-status', 'Matched'] : status === 'partial' ? ['review-status', 'Partial match'] : status === 'unmatched' ? ['unmatched-status', 'Unmatched'] : ['review-status', 'Review match'];
}
function renderApiTransactions(items) {
  const body = document.getElementById('transactionsBody');
  body.replaceChildren();
  items.forEach(item => {
    const invoice = apiInvoices.find(candidate => candidate.id === item.suggested_invoice_id);
    const [statusClass, label] = statusLabel(item.match_status);
    const positive = Number(item.amount) >= 0;
    const row = document.createElement('tr');
    row.dataset.status = item.match_status === 'matched' ? 'matched' : 'review';
    row.dataset.search = `${item.description} ${item.customer || ''} ${item.reference || ''} ${item.suggested_invoice_number || ''}`.toLowerCase();
    const sourceText = `${item.account || ''} ${item.description || ''}`.toLowerCase();
    row.dataset.source = sourceText.includes('mpesa') || sourceText.includes('m-pesa') ? 'mpesa' : sourceText.includes('cash') ? 'cash' : 'bank';
    const dateLabel = new Date(`${item.date}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const channel = (item.account || '').toLowerCase().includes('mpesa') ? 'mpesa' : positive ? 'bank' : 'fee';
    const logo = channel === 'mpesa' ? 'M' : channel === 'bank' ? '↗' : '↘';
    row.innerHTML = `<td>${dateLabel}</td><td><div class="description"><span class="transaction-logo ${channel}">${logo}</span><span><strong></strong><small></small></span></div></td><td class="amount ${positive ? 'positive' : 'negative'}">${positive ? '+' : '−'} ${formatKes(Math.abs(Number(item.amount)))}</td><td><div class="invoice-cell ${invoice ? '' : 'no-invoice'}"><strong></strong><small></small></div></td><td><span class="status ${statusClass}"><i></i>${label}</span></td>`;
    row.querySelector('.description strong').textContent = item.description;
    row.querySelector('.description small').textContent = [item.customer, item.reference ? `Ref ${item.reference}` : item.account].filter(Boolean).join(' · ') || item.account;
    row.querySelector('.invoice-cell strong').textContent = invoice?.number || (item.suggested_invoice_number || 'No invoice suggested');
    row.querySelector('.invoice-cell small').textContent = invoice?.customer || (item.match_status === 'unmatched' ? 'Find a match to continue' : 'AI suggestion');
    row.addEventListener('click', event => {
      selectedTransaction = item;
      showSuggestion(item, invoice);
    });
    body.append(row);
  });
  filterRows();
}
function exportTransactionsCsv() {
  if (!apiConnected) { notify('Connect to LedgerLens to export your transaction history.'); return; }
  if (!apiTransactions.length) { notify('There are no transactions to export yet.'); return; }
  const fields = ['Date', 'Description', 'Customer', 'Reference', 'Account', 'Amount (KES)', 'Matched (KES)', 'Status', 'Suggested invoice'];
  const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = apiTransactions.map(item => [item.date, item.description, item.customer, item.reference, item.account,
    Number(item.amount).toFixed(2), Number(item.matched_amount || 0).toFixed(2), item.match_status,
    item.suggested_invoice_number]);
  const csv = [fields, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `ledgerlens-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  notify(`${rows.length} transactions exported.`);
}
function showSuggestion(transaction, invoice) {
  if (!transaction) return;
  const panel = document.querySelector('.match-panel');
  panel.querySelector('.match-transaction strong').textContent = formatKes(Math.abs(Number(transaction.amount)));
  panel.querySelector('.match-transaction small').textContent = `${transaction.description} · ${transaction.date}`;
  panel.querySelector('.confidence b').textContent = transaction.confidence ? `${transaction.confidence}%` : '—';
  panel.querySelector('.suggested-invoice strong').innerHTML = invoice ? `${invoice.number} <span class="due-tag">${invoice.status.toUpperCase()}</span>` : 'No invoice suggested';
  panel.querySelector('.suggested-invoice small').textContent = invoice ? `${invoice.customer} · Balance ${formatKes(Number(invoice.amount) - Number(invoice.paid_amount))}` : 'Try another transaction or add an invoice';
  panel.querySelector('.match-reason p').textContent = invoice ? `Suggested using transaction details and open invoice balance: ${formatKes(Number(invoice.amount) - Number(invoice.paid_amount))}.` : 'No open invoice is available for this transaction yet.';
  document.getElementById('confirmMatch').disabled = !invoice;
}
function clearSuggestion() {
  const panel = document.querySelector('.match-panel');
  panel.querySelector('.match-transaction strong').textContent = 'Select a payment';
  panel.querySelector('.match-transaction small').textContent = 'Choose a transaction to review a match.';
  panel.querySelector('.confidence b').textContent = '—';
  panel.querySelector('.suggested-invoice strong').textContent = 'No invoice selected';
  panel.querySelector('.suggested-invoice small').textContent = 'Add an invoice and payment to begin matching.';
  panel.querySelector('.match-reason p').textContent = 'LedgerLens will suggest open invoices using payment details and remaining balances.';
  document.getElementById('confirmMatch').disabled = true;
}
const candidateBackdrop = document.getElementById('candidateBackdrop');
document.getElementById('candidateClose').addEventListener('click', () => { candidateBackdrop.hidden = true; });
candidateBackdrop.addEventListener('click', event => { if (event.target === candidateBackdrop) candidateBackdrop.hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !candidateBackdrop.hidden) candidateBackdrop.hidden = true; });
async function openCandidatePicker() {
  if (!apiConnected || !selectedTransaction?.id) {
    notify('Sign in and select a payment to compare other invoices.');
    return;
  }
  candidateBackdrop.hidden = false;
  document.getElementById('candidateList').replaceChildren();
  const status = document.getElementById('candidateStatus');
  status.textContent = 'Finding open invoices…';
  try {
    const candidates = await apiRequest(`/transactions/${selectedTransaction.id}/candidates`);
    status.textContent = candidates.length ? `${candidates.length} open invoice${candidates.length === 1 ? '' : 's'} available. Select one to review the suggested match.` : 'No open invoices are available for this payment.';
    const list = document.getElementById('candidateList');
    candidates.forEach(candidate => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'candidate-option';
      button.innerHTML = '<span class="candidate-main"><strong class="candidate-invoice-number"></strong><small class="candidate-customer"></small></span><span class="candidate-amounts"><strong class="candidate-balance"></strong><small class="candidate-match-amount"></small></span><span class="candidate-confidence"></span>';
      button.querySelector('.candidate-invoice-number').textContent = candidate.invoice_number;
      button.querySelector('.candidate-customer').textContent = `${candidate.customer} · Due ${new Date(`${candidate.due_date}T00:00:00`).toLocaleDateString('en-KE', { day: '2-digit', month: 'short' })}`;
      button.querySelector('.candidate-balance').textContent = `${formatKes(candidate.balance)} balance`;
      button.querySelector('.candidate-match-amount').textContent = `${formatKes(candidate.suggested_amount)} suggested payment`;
      button.querySelector('.candidate-confidence').textContent = `${candidate.confidence}% fit`;
      button.addEventListener('click', () => {
        selectedTransaction.suggested_invoice_id = candidate.invoice_id;
        const invoice = apiInvoices.find(item => item.id === candidate.invoice_id);
        showSuggestion(selectedTransaction, invoice);
        candidateBackdrop.hidden = true;
        notify(`${candidate.invoice_number} selected for review.`);
      });
      list.append(button);
    });
  } catch (error) {
    status.textContent = error.message;
  }
}
async function refreshDashboard() {
  const [dashboard, invoices] = await Promise.all([apiRequest('/dashboard'), apiRequest('/invoices')]);
  apiInvoices = invoices;
  apiTransactions = dashboard.transactions;
  document.getElementById('transactionsStat').textContent = dashboard.transactions_reviewed.toLocaleString();
  document.getElementById('matchedStat').textContent = dashboard.matched.toLocaleString();
  document.getElementById('reviewStat').textContent = dashboard.needs_review.toLocaleString();
  document.querySelector('.outstanding-card .summary-value').textContent = formatKes(dashboard.outstanding_amount);
  document.querySelector('.main-nav a[data-page="Transactions"] .nav-count').textContent = dashboard.transactions_reviewed;
  document.querySelector('.tabs [data-filter="all"] span').textContent = dashboard.transactions_reviewed;
  document.querySelector('.tabs [data-filter="matched"] span').textContent = dashboard.matched;
  document.querySelector('.tabs [data-filter="review"] span').textContent = dashboard.needs_review;
  const summaryTotal = apiInvoices.reduce((sum, invoice) => sum + Number(invoice.amount), 0);
  const overdueCount = apiInvoices.filter(invoice => invoice.status === 'overdue').length;
  document.querySelector('#transactionsStat').parentElement.querySelector('.summary-foot .trend').textContent = 'Current workspace';
  document.querySelector('#transactionsStat').parentElement.querySelector('.summary-foot > span:nth-child(2)').textContent = 'Imported records';
  document.querySelector('#matchedStat').parentElement.querySelector('.summary-foot .trend').textContent = `${dashboard.match_rate}%`;
  document.querySelector('#matchedStat').parentElement.querySelector('.summary-foot > span:nth-child(2)').textContent = 'of transactions matched';
  document.querySelector('#reviewStat').parentElement.querySelector('.summary-foot .trend').textContent = 'Needs review';
  document.querySelector('#reviewStat').parentElement.querySelector('.summary-foot > span:nth-child(2)').textContent = 'Incoming payments and exceptions';
  const outstandingFoot = document.querySelector('.outstanding-card .summary-foot');
  outstandingFoot.querySelector('.trend').textContent = `${overdueCount} overdue`;
  outstandingFoot.querySelector('span:nth-child(2)').textContent = `of ${formatKes(summaryTotal)} invoiced`;
  const outstandingBar = outstandingFoot.querySelector('.outstanding-bar i');
  outstandingBar.style.width = `${summaryTotal ? Math.min(100, Math.max(0, Number(dashboard.outstanding_amount) / summaryTotal * 100)) : 0}%`;
  renderCashSnapshot();
  renderApiTransactions(apiTransactions);
  renderInvoices();
  renderExceptions();
  renderReports();
  renderCustomers();
  if (selectedTransaction) {
    selectedTransaction = apiTransactions.find(item => item.id === selectedTransaction.id) || apiTransactions.find(item => item.match_status !== 'matched') || apiTransactions[0];
  } else selectedTransaction = apiTransactions.find(item => item.match_status !== 'matched') || apiTransactions[0];
  if (selectedTransaction) showSuggestion(selectedTransaction, apiInvoices.find(item => item.id === selectedTransaction.suggested_invoice_id));
  else clearSuggestion();
}
function renderCashSnapshot() {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthTransactions = apiTransactions.filter(item => String(item.date).startsWith(monthKey));
  const income = monthTransactions.reduce((sum, item) => sum + Math.max(0, Number(item.amount)), 0);
  const expenses = monthTransactions.reduce((sum, item) => sum + Math.abs(Math.min(0, Number(item.amount))), 0);
  document.getElementById('cashPeriod').textContent = now.toLocaleDateString('en-KE', { month: 'long', year: 'numeric' });
  document.getElementById('cashNet').textContent = formatKes(income - expenses);
  document.getElementById('cashIncome').textContent = formatKes(income);
  document.getElementById('cashExpenses').textContent = formatKes(expenses);
}
async function connectApi() {
  const errorBox = document.getElementById('authError');
  const retryButton = document.getElementById('retryApi');
  const submitButtons = [...document.querySelectorAll('#loginForm button[type="submit"], #registerForm button[type="submit"]')];
  try {
    await apiRequest('/health');
    apiConnected = true;
    retryButton.hidden = true;
    submitButtons.forEach(button => { button.disabled = false; });
    const token = sessionStorage.getItem('ledgerlens-token');
    if (!token) {
      const registerMode = !document.getElementById('registerForm').hidden;
      setAuthMode(registerMode);
      showAuthGate();
      return;
    }
    const user = await apiRequest('/auth/me');
    currentUser = user;
    document.querySelector('.workspace strong').textContent = user.workspace_name;
    document.querySelector('.profile-copy strong').textContent = user.email;
    document.querySelector('.profile-copy small').textContent = `${user.role} · LedgerLens`;
    renderSettings();
    await refreshDashboard();
  } catch (error) {
  apiConnected = false;
    sessionStorage.removeItem('ledgerlens-token');
    setAuthMode(true);
    showAuthGate();
    errorBox.textContent = 'The LedgerLens API is unavailable. Start Docker with “docker compose up --build”, then retry.';
    retryButton.hidden = false;
    submitButtons.forEach(button => { button.disabled = true; });
  }
}
document.getElementById('retryApi').addEventListener('click', connectApi);
connectApi();
