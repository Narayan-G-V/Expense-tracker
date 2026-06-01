/**
 * app.js — SpendWise Core Application
 * Handles UI state, CRUD, Chart.js visualizations, budgets, and export.
 */

import {
  initDb, onDbEvent, getTransactionsLocal, getBudgetsLocal, saveBudgetsLocal,
  saveTransaction, deleteTransaction as dbDeleteTransaction, clearAllData,
  getSavedConfig, clearFirebaseConfig, manualSync as dbManualSync,
  setOfflineMode, getDbStats, addSyncLog
} from './db.js';

/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */
const EXPENSE_CATEGORIES = [
  { id:'food',       label:'Food & Dining',    icon:'🍔', color:'#f97316' },
  { id:'transport',  label:'Transport',         icon:'🚗', color:'#38bdf8' },
  { id:'housing',    label:'Housing & Rent',    icon:'🏠', color:'#a78bfa' },
  { id:'health',     label:'Health & Medical',  icon:'💊', color:'#10b981' },
  { id:'shopping',   label:'Shopping',          icon:'🛍️', color:'#f43f5e' },
  { id:'education',  label:'Education',         icon:'📚', color:'#fbbf24' },
  { id:'entertain',  label:'Entertainment',     icon:'🎬', color:'#ec4899' },
  { id:'utilities',  label:'Utilities & Bills', icon:'💡', color:'#6ee7b7' },
  { id:'other',      label:'Other',             icon:'📦', color:'#94a3b8' },
];
const INCOME_CATEGORIES = [
  { id:'salary',     label:'Salary',            icon:'💼', color:'#34d399' },
  { id:'freelance',  label:'Freelance',         icon:'💻', color:'#60a5fa' },
  { id:'investment', label:'Investment',         icon:'📈', color:'#c084fc' },
  { id:'gift',       label:'Gift / Bonus',       icon:'🎁', color:'#f9a8d4' },
  { id:'rental',     label:'Rental Income',     icon:'🏗️', color:'#fb923c' },
  { id:'other',      label:'Other Income',      icon:'💰', color:'#94a3b8' },
];
const ALL_CATEGORIES = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];

const PAGE_SIZE    = 10;
const MONTHS       = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];

/* ═══════════════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════════════ */
let state = {
  transactions : [],
  budgets      : {},
  selectedMonth: null,   // 'YYYY-MM'
  analyticsMonth: null,
  budgetMonth  : null,
  currentTab   : 'dashboard',
  sortKey      : 'date',
  sortDir      : 'desc',
  txPage       : 1,
  isOffline    : false,
};

let charts = { pie: null, bar: null, line: null, donut: null };

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════════════════ */
function fmt(amount) {
  return '₹' + Math.abs(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtMonthKey(date) {
  const d = new Date(date + 'T00:00:00');
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTHS[parseInt(m)-1]} ${y}`;
}
function currentMonthKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
}
function getCategoryMeta(id) {
  return ALL_CATEGORIES.find(c => c.id === id) ||
    { id:'other', label:'Other', icon:'📦', color:'#94a3b8' };
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MONTH PICKER POPULATION
   ═══════════════════════════════════════════════════════════════════════════ */
function getAvailableMonths() {
  const monthsSet = new Set(state.transactions.map(t => fmtMonthKey(t.date)));
  const cur = currentMonthKey();
  monthsSet.add(cur);
  return Array.from(monthsSet).sort().reverse();
}

function populateMonthPickers() {
  const months = getAvailableMonths();
  const pickers = ['month-picker', 'analytics-month-picker', 'budget-month-picker'];

  pickers.forEach(pid => {
    const el = document.getElementById(pid);
    if (!el) return;
    const cur = el.value || state.selectedMonth || currentMonthKey();
    el.innerHTML = months.map(m =>
      `<option value="${m}" ${m === cur ? 'selected' : ''}>${monthLabel(m)}</option>`
    ).join('');
  });

  // Populate filter month for transactions
  const txFilter = document.getElementById('filter-month-tx');
  if (txFilter) {
    const current = txFilter.value;
    txFilter.innerHTML = `<option value="all">All Months</option>` +
      months.map(m => `<option value="${m}" ${m === current ? 'selected' : ''}>${monthLabel(m)}</option>`).join('');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CATEGORY SELECT POPULATION
   ═══════════════════════════════════════════════════════════════════════════ */
function populateCategorySelects() {
  const type = document.getElementById('tx-type')?.value || 'expense';
  const cats = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  const txCat = document.getElementById('tx-category');
  if (txCat) {
    txCat.innerHTML = `<option value="">Select category…</option>` +
      cats.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('');
  }

  const budgetCat = document.getElementById('budget-category');
  if (budgetCat) {
    budgetCat.innerHTML = `<option value="">Select category…</option>` +
      EXPENSE_CATEGORIES.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('');
  }

  const filterCat = document.getElementById('filter-category');
  if (filterCat) {
    filterCat.innerHTML = `<option value="all">All Categories</option>` +
      ALL_CATEGORIES.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DATA LOADING
   ═══════════════════════════════════════════════════════════════════════════ */
function loadData() {
  state.transactions = getTransactionsLocal();
  state.budgets      = getBudgetsLocal();
  if (!state.selectedMonth) state.selectedMonth = currentMonthKey();
  if (!state.analyticsMonth) state.analyticsMonth = currentMonthKey();
  if (!state.budgetMonth)    state.budgetMonth    = currentMonthKey();
  populateMonthPickers();
  populateCategorySelects();
  renderAll();
}

function getMonthTransactions(monthKey) {
  return state.transactions.filter(t => fmtMonthKey(t.date) === monthKey);
}

function calcMetrics(txs) {
  const income  = txs.filter(t => t.type === 'income').reduce((s,t) => s + t.amount, 0);
  const expense = txs.filter(t => t.type === 'expense').reduce((s,t) => s + t.amount, 0);
  const balance = income - expense;
  const savings = income > 0 ? Math.round((balance / income) * 100) : 0;
  return { income, expense, balance, savings };
}

/* ═══════════════════════════════════════════════════════════════════════════
   RENDER ALL
   ═══════════════════════════════════════════════════════════════════════════ */
function renderAll() {
  renderDashboard();
  renderAnalytics();
  renderTransactions();
  renderBudgets();
  updateCloudStats();
}

/* ═══════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const txs     = getMonthTransactions(state.selectedMonth);
  const metrics = calcMetrics(txs);

  document.getElementById('dashboard-month-label').textContent =
    `Overview for ${monthLabel(state.selectedMonth)}`;

  // Metrics
  document.getElementById('metric-balance').textContent  = fmt(metrics.balance);
  document.getElementById('metric-income').textContent   = fmt(metrics.income);
  document.getElementById('metric-expense').textContent  = fmt(metrics.expense);
  document.getElementById('metric-savings').textContent  = `${metrics.savings}%`;

  document.getElementById('metric-balance').style.color =
    metrics.balance >= 0 ? 'var(--income-color)' : 'var(--expense-color)';

  // Recent transactions (last 8)
  const recentList = document.getElementById('recent-tx-list');
  const recent = txs.slice(0, 8);
  if (recent.length === 0) {
    recentList.innerHTML = `<li class="tx-empty">No transactions for ${monthLabel(state.selectedMonth)}.</li>`;
  } else {
    recentList.innerHTML = recent.map(tx => buildTxListItem(tx)).join('');
  }

  // Budget bars
  renderBudgetBars('budget-bars-dash', state.selectedMonth);
}

function buildTxListItem(tx) {
  const cat = getCategoryMeta(tx.category);
  const sign = tx.type === 'income' ? '+' : '-';
  return `
    <li class="tx-item">
      <div class="tx-cat-icon" style="background:${cat.color}22">${cat.icon}</div>
      <div class="tx-meta">
        <div class="tx-desc">${escHtml(tx.description)}</div>
        <div class="tx-sub">${fmtDate(tx.date)} · ${cat.label}</div>
      </div>
      <div class="tx-amount ${tx.type}">${sign}${fmt(tx.amount)}</div>
    </li>`;
}

function renderBudgetBars(containerId, monthKey) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const budgets = state.budgets;
  const keys    = Object.keys(budgets);
  if (keys.length === 0) {
    container.innerHTML = '<p class="tx-empty">No budgets set. <button class="link-btn" onclick="switchTab(\'budgets\')">Create one →</button></p>';
    return;
  }

  const txs = getMonthTransactions(monthKey);
  container.innerHTML = keys.map(catId => {
    const limit   = budgets[catId];
    const spent   = txs.filter(t => t.type === 'expense' && t.category === catId).reduce((s,t) => s + t.amount, 0);
    const pct     = Math.min((spent / limit) * 100, 100);
    const cat     = getCategoryMeta(catId);
    const cls     = pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : '';
    return `
      <div class="budget-bar-item">
        <div class="budget-bar-header">
          <span class="budget-bar-cat">${cat.icon} ${cat.label}</span>
          <span class="budget-bar-vals">${fmt(spent)} / ${fmt(limit)}</span>
        </div>
        <div class="budget-bar-track">
          <div class="budget-bar-fill ${cls}" style="width:${pct}%"></div>
        </div>
      </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════════════════
   ANALYTICS
   ═══════════════════════════════════════════════════════════════════════════ */
function renderAnalytics() {
  const m   = state.analyticsMonth;
  const txs = getMonthTransactions(m);
  const lbl = monthLabel(m);

  ['pie-month-label','trend-month-label','donut-month-label']
    .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = lbl; });

  renderPieChart(txs);
  renderBarChart();
  renderLineChart(txs, m);
  renderDonutChart(txs);
}

function chartDefaults() {
  return {
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15,12,40,0.95)',
        titleColor: '#f1f0ff',
        bodyColor: '#a0a0c0',
        borderColor: 'rgba(139,92,246,0.3)',
        borderWidth: 1,
        cornerRadius: 10,
        padding: 12,
      }
    }
  };
}

function renderPieChart(txs) {
  const expTxs = txs.filter(t => t.type === 'expense');
  const bycat  = {};
  expTxs.forEach(t => { bycat[t.category] = (bycat[t.category] || 0) + t.amount; });

  const cats   = Object.keys(bycat);
  const metas  = cats.map(id => getCategoryMeta(id));
  const labels = metas.map(c => c.label);
  const data   = cats.map(id => bycat[id]);
  const colors = metas.map(c => c.color);

  const ctx = document.getElementById('pie-chart');
  if (!ctx) return;
  if (charts.pie) charts.pie.destroy();

  if (data.length === 0) {
    ctx.parentElement.innerHTML = '<p class="tx-empty" style="padding:80px 0">No expense data</p>';
    document.getElementById('pie-legend').innerHTML = '';
    return;
  }

  charts.pie = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: 'rgba(255,255,255,0.04)', borderWidth: 2, hoverOffset: 8 }] },
    options: {
      ...chartDefaults(),
      cutout: '65%',
      plugins: { ...chartDefaults().plugins, tooltip: { ...chartDefaults().plugins.tooltip,
        callbacks: { label: ctx => ` ${ctx.label}: ${fmt(ctx.raw)}` }
      }}
    }
  });

  const total = data.reduce((s,v) => s+v, 0);
  document.getElementById('pie-legend').innerHTML = metas.map((c,i) =>
    `<div class="legend-item">
       <div class="legend-dot" style="background:${c.color}"></div>
       <span>${c.label}</span>
       <span style="color:var(--text-primary);font-weight:600">${Math.round((data[i]/total)*100)}%</span>
     </div>`
  ).join('');
}

function renderBarChart() {
  // Last 6 months
  const months = [];
  const now    = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }

  const incomeData  = months.map(m => calcMetrics(getMonthTransactions(m)).income);
  const expenseData = months.map(m => calcMetrics(getMonthTransactions(m)).expense);
  const labels      = months.map(m => { const [y,mo] = m.split('-'); return MONTHS[parseInt(mo)-1].slice(0,3) + ' ' + y.slice(2); });

  const ctx = document.getElementById('bar-chart');
  if (!ctx) return;
  if (charts.bar) charts.bar.destroy();

  charts.bar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Income',  data: incomeData,  backgroundColor: 'rgba(16,185,129,0.7)', borderRadius: 6, borderSkipped: false },
        { label: 'Expense', data: expenseData, backgroundColor: 'rgba(244,63,94,0.7)',  borderRadius: 6, borderSkipped: false },
      ]
    },
    options: {
      ...chartDefaults(),
      scales: {
        x: { ticks: { color: '#6b6b8a', font:{size:11} }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#6b6b8a', callback: v => '₹'+v.toLocaleString('en-IN'), font:{size:10} }, grid: { color: 'rgba(255,255,255,0.06)' }, border:{dash:[4,4]} }
      },
      plugins: { ...chartDefaults().plugins,
        legend: { display: true, labels: { color:'#a0a0c0', boxWidth:10, boxHeight:10, borderRadius:4, useBorderRadius:true, font:{size:11} } },
        tooltip: { ...chartDefaults().plugins.tooltip, callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}` } }
      }
    }
  });
}

function renderLineChart(txs, monthKey) {
  // Daily cumulative balance for the selected month
  const [year, month] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = Array.from({length: daysInMonth}, (_, i) => i + 1);

  let running = 0;
  const balData = days.map(d => {
    const dayStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayTxs = txs.filter(t => t.date === dayStr);
    dayTxs.forEach(t => { running += t.type === 'income' ? t.amount : -t.amount; });
    return running;
  });

  const ctx = document.getElementById('line-chart');
  if (!ctx) return;
  if (charts.line) charts.line.destroy();

  const gradient = ctx.getContext('2d').createLinearGradient(0,0,0,200);
  gradient.addColorStop(0, 'rgba(139,92,246,0.4)');
  gradient.addColorStop(1, 'rgba(139,92,246,0)');

  charts.line = new Chart(ctx, {
    type: 'line',
    data: {
      labels: days,
      datasets: [{
        label: 'Balance',
        data: balData,
        borderColor: '#8b5cf6',
        backgroundColor: gradient,
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#8b5cf6',
      }]
    },
    options: {
      ...chartDefaults(),
      scales: {
        x: { ticks: { color:'#6b6b8a', font:{size:10}, maxTicksLimit:10 }, grid:{color:'rgba(255,255,255,0.04)'} },
        y: { ticks: { color:'#6b6b8a', callback: v => '₹'+v.toLocaleString('en-IN'), font:{size:10} }, grid:{color:'rgba(255,255,255,0.06)'}, border:{dash:[4,4]} }
      },
      plugins: { ...chartDefaults().plugins,
        tooltip: { ...chartDefaults().plugins.tooltip, callbacks: { label: ctx => ` Balance: ${fmt(ctx.raw)}` } }
      }
    }
  });
}

function renderDonutChart(txs) {
  const m = calcMetrics(txs);
  const ctx = document.getElementById('donut-chart');
  if (!ctx) return;
  if (charts.donut) charts.donut.destroy();

  const hasData = m.income > 0 || m.expense > 0;

  charts.donut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Income', 'Expenses'],
      datasets: [{
        data: hasData ? [m.income, m.expense] : [1, 0],
        backgroundColor: hasData
          ? ['rgba(16,185,129,0.8)', 'rgba(244,63,94,0.8)']
          : ['rgba(255,255,255,0.1)', 'rgba(255,255,255,0.05)'],
        borderColor: 'rgba(255,255,255,0.04)',
        borderWidth: 2,
        hoverOffset: 6,
      }]
    },
    options: {
      ...chartDefaults(),
      cutout: '70%',
      plugins: { ...chartDefaults().plugins,
        tooltip: { ...chartDefaults().plugins.tooltip,
          callbacks: { label: ctx => ` ${ctx.label}: ${fmt(ctx.raw)}` }
        }
      }
    }
  });

  document.getElementById('donut-stats').innerHTML = `
    <div class="donut-stat">
      <span class="donut-stat-val" style="color:var(--income-color)">${fmt(m.income)}</span>
      <span class="donut-stat-lbl">Income</span>
    </div>
    <div class="donut-stat">
      <span class="donut-stat-val" style="color:var(--expense-color)">${fmt(m.expense)}</span>
      <span class="donut-stat-lbl">Expenses</span>
    </div>
    <div class="donut-stat">
      <span class="donut-stat-val" style="color:var(--accent-light)">${m.savings}%</span>
      <span class="donut-stat-lbl">Savings</span>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   TRANSACTIONS TABLE
   ═══════════════════════════════════════════════════════════════════════════ */
function renderTransactions() {
  let txs = [...state.transactions];

  // Search
  const search = document.getElementById('tx-search')?.value?.toLowerCase() || '';
  if (search) txs = txs.filter(t =>
    t.description.toLowerCase().includes(search) ||
    getCategoryMeta(t.category).label.toLowerCase().includes(search) ||
    t.amount.toString().includes(search)
  );

  // Type filter
  const typeF = document.getElementById('filter-type')?.value || 'all';
  if (typeF !== 'all') txs = txs.filter(t => t.type === typeF);

  // Category filter
  const catF = document.getElementById('filter-category')?.value || 'all';
  if (catF !== 'all') txs = txs.filter(t => t.category === catF);

  // Month filter
  const monthF = document.getElementById('filter-month-tx')?.value || 'all';
  if (monthF !== 'all') txs = txs.filter(t => fmtMonthKey(t.date) === monthF);

  // Sort
  txs.sort((a, b) => {
    let aV = a[state.sortKey], bV = b[state.sortKey];
    if (state.sortKey === 'amount') { aV = Number(aV); bV = Number(bV); }
    if (aV < bV) return state.sortDir === 'asc' ? -1 :  1;
    if (aV > bV) return state.sortDir === 'asc' ?  1 : -1;
    return 0;
  });

  // Count label
  const countEl = document.getElementById('tx-count-label');
  if (countEl) countEl.textContent = `${txs.length} entr${txs.length === 1 ? 'y' : 'ies'}`;

  // Paginate
  const totalPages = Math.max(1, Math.ceil(txs.length / PAGE_SIZE));
  if (state.txPage > totalPages) state.txPage = 1;
  const pageTxs = txs.slice((state.txPage-1)*PAGE_SIZE, state.txPage*PAGE_SIZE);

  const tbody = document.getElementById('tx-tbody');
  if (!tbody) return;

  if (pageTxs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No transactions found. Try adjusting your filters.</td></tr>`;
  } else {
    tbody.innerHTML = pageTxs.map(tx => {
      const cat = getCategoryMeta(tx.category);
      const sign = tx.type === 'income' ? '+' : '-';
      return `
        <tr>
          <td>${fmtDate(tx.date)}</td>
          <td>
            <div style="font-weight:600">${escHtml(tx.description)}</div>
            ${tx.notes ? `<div style="font-size:0.75rem;color:var(--text-muted)">${escHtml(tx.notes)}</div>` : ''}
          </td>
          <td><span class="cat-badge">${cat.icon} ${cat.label}</span></td>
          <td><span class="type-badge ${tx.type}">${tx.type === 'income' ? 'Income' : 'Expense'}</span></td>
          <td style="font-weight:700;color:${tx.type==='income'?'var(--income-color)':'var(--expense-color)'}">
            ${sign}${fmt(tx.amount)}
          </td>
          <td>
            <div class="action-btns">
              <button class="action-btn" onclick="editTransaction('${tx.id}')">✏️ Edit</button>
              <button class="action-btn delete" onclick="confirmDelete('${tx.id}', '${escHtml(tx.description)}')">🗑️</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  // Pagination
  const pag = document.getElementById('pagination');
  if (pag) {
    if (totalPages <= 1) { pag.innerHTML = ''; return; }
    let html = '';
    if (state.txPage > 1) html += `<button class="page-btn" onclick="goToPage(${state.txPage-1})">‹</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - state.txPage) <= 1) {
        html += `<button class="page-btn ${i===state.txPage?'active':''}" onclick="goToPage(${i})">${i}</button>`;
      } else if (Math.abs(i - state.txPage) === 2) {
        html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
      }
    }
    if (state.txPage < totalPages) html += `<button class="page-btn" onclick="goToPage(${state.txPage+1})">›</button>`;
    pag.innerHTML = html;
  }
}

window.goToPage = function(p) { state.txPage = p; renderTransactions(); };
window.sortBy   = function(key) {
  if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  else { state.sortKey = key; state.sortDir = 'desc'; }
  ['date','description','amount'].forEach(k => {
    const el = document.getElementById(`sort-${k}`);
    if (el) el.textContent = k === state.sortKey ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
  });
  renderTransactions();
};
window.clearFilters = function() {
  document.getElementById('tx-search').value = '';
  document.getElementById('filter-type').value = 'all';
  document.getElementById('filter-category').value = 'all';
  document.getElementById('filter-month-tx').value = 'all';
  state.txPage = 1;
  renderTransactions();
};

/* ═══════════════════════════════════════════════════════════════════════════
   BUDGETS
   ═══════════════════════════════════════════════════════════════════════════ */
function renderBudgets() {
  const grid    = document.getElementById('budgets-grid');
  if (!grid) return;
  const budgets = state.budgets;
  const m       = state.budgetMonth;
  const txs     = getMonthTransactions(m);
  const keys    = Object.keys(budgets);

  if (keys.length === 0) {
    grid.innerHTML = `
      <div class="budget-empty glass-card">
        <div class="empty-icon">🎯</div>
        <p>No budgets set for ${monthLabel(m)}.</p>
        <button class="btn btn-primary" onclick="openModal('add-budget-modal')">Create Your First Budget</button>
      </div>`;
    return;
  }

  grid.innerHTML = keys.map(catId => {
    const limit   = budgets[catId];
    const spent   = txs.filter(t => t.type==='expense' && t.category===catId).reduce((s,t)=>s+t.amount,0);
    const pct     = Math.min((spent/limit)*100, 100);
    const cat     = getCategoryMeta(catId);
    const cls     = pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : 'ok';
    const fillClr = pct >= 100 ? 'var(--expense-color)' : pct >= 80 ? 'var(--warning-color)' : 'var(--income-color)';
    return `
      <div class="budget-item-card">
        <div class="budget-item-top">
          <span class="budget-cat-name">${cat.icon} ${cat.label}</span>
          <span class="budget-pct ${cls}">${Math.round(pct)}%</span>
        </div>
        <div class="budget-track">
          <div class="budget-fill" style="width:${pct}%;background:${fillClr}"></div>
        </div>
        <div class="budget-nums">
          <span>Spent: ${fmt(spent)}</span>
          <span>Limit: ${fmt(limit)}</span>
        </div>
        ${pct >= 100 ? `<div style="font-size:0.75rem;color:var(--expense-color);font-weight:600">⚠️ Budget exceeded by ${fmt(spent-limit)}!</div>` : ''}
        ${pct >= 80 && pct < 100 ? `<div style="font-size:0.75rem;color:var(--warning-color);font-weight:600">⚡ Approaching limit</div>` : ''}
        <button class="budget-delete" onclick="deleteBudget('${catId}')">Remove</button>
      </div>`;
  }).join('');
}

window.deleteBudget = function(catId) {
  delete state.budgets[catId];
  saveBudgetsLocal(state.budgets);
  renderBudgets();
  renderBudgetBars('budget-bars-dash', state.selectedMonth);
  showToast('Budget removed', 'info');
};

window.submitBudget = function(e) {
  e.preventDefault();
  const catId  = document.getElementById('budget-category').value;
  const amount = parseFloat(document.getElementById('budget-amount').value);
  if (!catId || !amount || amount <= 0) return;

  state.budgets[catId] = amount;
  saveBudgetsLocal(state.budgets);
  closeModal('add-budget-modal');
  document.getElementById('budget-form').reset();
  renderBudgets();
  renderBudgetBars('budget-bars-dash', state.selectedMonth);
  showToast(`Budget set for ${getCategoryMeta(catId).label}`, 'success');
};

/* ═══════════════════════════════════════════════════════════════════════════
   ADD / EDIT TRANSACTION
   ═══════════════════════════════════════════════════════════════════════════ */
window.setTxType = function(type) {
  document.getElementById('tx-type').value = type;
  document.getElementById('type-expense-btn').classList.toggle('active', type === 'expense');
  document.getElementById('type-income-btn').classList.toggle('active', type === 'income');
  populateCategorySelects();
  checkBudgetAlert();
};

window.submitTransaction = async function(e) {
  e.preventDefault();

  const id = document.getElementById('tx-edit-id').value || uid();
  const tx = {
    id,
    type        : document.getElementById('tx-type').value,
    amount      : parseFloat(document.getElementById('tx-amount').value),
    date        : document.getElementById('tx-date').value,
    description : document.getElementById('tx-description').value.trim(),
    category    : document.getElementById('tx-category').value,
    payment     : document.getElementById('tx-payment').value,
    notes       : document.getElementById('tx-notes').value.trim(),
    createdAt   : new Date().toISOString(),
  };

  // Disable form during save
  const btn = document.getElementById('tx-submit-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  await saveTransaction(tx);
  loadData();
  closeModal('add-tx-modal');
  document.getElementById('tx-form').reset();
  document.getElementById('tx-edit-id').value = '';
  setTxType('expense');
  btn.disabled = false; btn.textContent = 'Add Transaction';
  showToast(`Transaction ${id ? 'updated' : 'added'} successfully!`, 'success');
};

window.editTransaction = function(id) {
  const tx = state.transactions.find(t => t.id === id);
  if (!tx) return;

  document.getElementById('tx-modal-title').textContent = 'Edit Transaction';
  document.getElementById('tx-submit-btn').textContent  = 'Update Transaction';
  document.getElementById('tx-edit-id').value    = tx.id;
  document.getElementById('tx-amount').value     = tx.amount;
  document.getElementById('tx-date').value       = tx.date;
  document.getElementById('tx-description').value = tx.description;
  document.getElementById('tx-notes').value      = tx.notes || '';
  document.getElementById('tx-payment').value    = tx.payment || 'Cash';
  setTxType(tx.type);

  // Wait for category options to populate
  setTimeout(() => {
    document.getElementById('tx-category').value = tx.category;
  }, 50);

  openModal('add-tx-modal');
};

window.confirmDelete = function(id, desc) {
  document.getElementById('confirm-title').textContent = 'Delete Transaction';
  document.getElementById('confirm-msg').textContent   = `Delete "${desc}"? This cannot be undone.`;
  document.getElementById('confirm-yes-btn').onclick   = async () => {
    await dbDeleteTransaction(id);
    loadData();
    closeModal('confirm-modal');
    showToast('Transaction deleted', 'info');
  };
  openModal('confirm-modal');
};

/* Budget alert check when editing amount/category */
function checkBudgetAlert() {
  const box      = document.getElementById('budget-alert-box');
  if (!box) return;
  const catId    = document.getElementById('tx-category')?.value;
  const type     = document.getElementById('tx-type')?.value;
  const amount   = parseFloat(document.getElementById('tx-amount')?.value) || 0;
  const editId   = document.getElementById('tx-edit-id')?.value;
  const dateVal  = document.getElementById('tx-date')?.value;

  box.style.display = 'none';
  if (type !== 'expense' || !catId || !state.budgets[catId]) return;

  const limit    = state.budgets[catId];
  const month    = dateVal ? fmtMonthKey(dateVal) : currentMonthKey();
  const spent    = getMonthTransactions(month)
    .filter(t => t.type==='expense' && t.category===catId && t.id !== editId)
    .reduce((s,t) => s+t.amount, 0);
  const newTotal = spent + amount;
  const pct      = (newTotal / limit) * 100;

  if (pct >= 100) {
    box.style.display = 'flex';
    box.className = 'budget-alert-box danger';
    box.innerHTML = `⚠️ This will exceed your ${getCategoryMeta(catId).label} budget by ${fmt(newTotal-limit)}!`;
  } else if (pct >= 80) {
    box.style.display = 'flex';
    box.className = 'budget-alert-box warn';
    box.innerHTML = `⚡ You'll be at ${Math.round(pct)}% of your ${getCategoryMeta(catId).label} budget.`;
  }
}

// Wire up live budget check
document.addEventListener('DOMContentLoaded', () => {
  ['tx-amount','tx-category','tx-date'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', checkBudgetAlert);
    document.getElementById(id)?.addEventListener('change', checkBudgetAlert);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CLOUD SYNC TAB
   ═══════════════════════════════════════════════════════════════════════════ */
function updateCloudStats() {
  const stats = getDbStats();
  document.getElementById('stat-total').textContent    = stats.total;
  document.getElementById('stat-last-sync').textContent =
    stats.lastSync ? stats.lastSync.toLocaleTimeString('en-IN') : 'Never';
  document.getElementById('stat-pending').textContent  = stats.pending;
  document.getElementById('stat-storage').textContent  = `${stats.storageKB} KB`;
  document.getElementById('stat-mode').textContent     = stats.mode;

  const syncDot = document.getElementById('sync-dot');
  if (syncDot) {
    syncDot.style.background = stats.isOnline ? 'var(--income-color)' : 'var(--warning-color)';
  }
}

window.applyFirebaseConfig = function() {
  const config = {
    apiKey       : document.getElementById('fb-api-key').value.trim(),
    projectId    : document.getElementById('fb-project-id').value.trim(),
    authDomain   : document.getElementById('fb-auth-domain').value.trim(),
    appId        : document.getElementById('fb-app-id').value.trim(),
  };
  if (!config.apiKey || !config.projectId) {
    showToast('Please fill in at least API Key and Project ID', 'warning');
    return;
  }
  import('./db.js').then(db => db.connectFirebase(config).then(ok => {
    if (ok) {
      loadData();
      showToast('Connected to Firebase Firestore!', 'success');
    } else {
      showToast('Connection failed — check your credentials', 'error');
    }
  }));
};

window.clearFirebaseConfig = function() {
  clearFirebaseConfig();
  document.getElementById('fb-api-key').value     = '';
  document.getElementById('fb-project-id').value  = '';
  document.getElementById('fb-auth-domain').value = '';
  document.getElementById('fb-app-id').value      = '';
  showToast('Switched to LocalStorage mode', 'info');
};

window.manualSync = function() { dbManualSync().then(() => updateCloudStats()); };

window.toggleOffline = function() {
  state.isOffline = !state.isOffline;
  setOfflineMode(state.isOffline);
  const btn = document.getElementById('offline-toggle');
  if (btn) btn.textContent = state.isOffline ? '📶 Go Online' : '📴 Go Offline';
  showToast(state.isOffline ? 'Offline mode enabled' : 'Back online', 'info');
  updateCloudStats();
};

window.confirmClearAll = function() {
  document.getElementById('confirm-title').textContent = 'Clear All Data';
  document.getElementById('confirm-msg').textContent   = 'This will permanently delete ALL transactions from local storage and Firestore. This cannot be undone!';
  document.getElementById('confirm-yes-btn').textContent = 'Yes, Clear Everything';
  document.getElementById('confirm-yes-btn').onclick   = async () => {
    await clearAllData();
    loadData();
    closeModal('confirm-modal');
    showToast('All data cleared', 'info');
  };
  openModal('confirm-modal');
};

/* ═══════════════════════════════════════════════════════════════════════════
   NAVIGATION
   ═══════════════════════════════════════════════════════════════════════════ */
window.switchTab = function(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  document.getElementById(`nav-${tab}`)?.classList.add('active');

  // Close sidebar on mobile
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');
  }

  // Lazy-render analytics charts when switching to that tab
  if (tab === 'analytics') renderAnalytics();
  if (tab === 'cloud') updateCloudStats();
};

window.toggleSidebar = function() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
};

/* ═══════════════════════════════════════════════════════════════════════════
   MONTH CHANGE HANDLERS
   ═══════════════════════════════════════════════════════════════════════════ */
window.onMonthChange = function() {
  state.selectedMonth = document.getElementById('month-picker').value;
  renderDashboard();
};
window.onAnalyticsMonthChange = function() {
  state.analyticsMonth = document.getElementById('analytics-month-picker').value;
  renderAnalytics();
};
window.onBudgetMonthChange = function() {
  state.budgetMonth = document.getElementById('budget-month-picker').value;
  renderBudgets();
};

/* ═══════════════════════════════════════════════════════════════════════════
   MODAL HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
window.openModal = function(id) {
  document.getElementById(id)?.classList.add('open');

  // Set today's date as default in tx form
  if (id === 'add-tx-modal') {
    const dateField = document.getElementById('tx-date');
    if (dateField && !dateField.value) {
      dateField.value = new Date().toISOString().split('T')[0];
    }
    // Reset title/button if adding new
    if (!document.getElementById('tx-edit-id').value) {
      document.getElementById('tx-modal-title').textContent = 'Add Transaction';
      document.getElementById('tx-submit-btn').textContent  = 'Add Transaction';
    }
  }
  populateCategorySelects();
};
window.closeModal = function(id) {
  document.getElementById(id)?.classList.remove('open');
  if (id === 'add-tx-modal') {
    document.getElementById('tx-form')?.reset();
    document.getElementById('tx-edit-id').value = '';
    document.getElementById('budget-alert-box').style.display = 'none';
    setTxType('expense');
  }
};
window.closeModalOnBackdrop = function(e, id) {
  if (e.target.id === id) closeModal(id);
};

/* ═══════════════════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
   ═══════════════════════════════════════════════════════════════════════════ */
window.showToast = function(msg, type = 'info') {
  const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
};

/* ═══════════════════════════════════════════════════════════════════════════
   CSV EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */
window.exportCSV = function() {
  const txs = state.transactions;
  if (txs.length === 0) { showToast('No transactions to export', 'warning'); return; }

  const headers = ['Date','Description','Type','Category','Amount','Payment Method','Notes'];
  const rows = txs.map(t => [
    t.date, `"${t.description.replace(/"/g,'""')}"`,
    t.type, getCategoryMeta(t.category).label,
    t.amount, t.payment || '', `"${(t.notes||'').replace(/"/g,'""')}"`
  ].join(','));

  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `spendwise_export_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${txs.length} transactions as CSV`, 'success');
};

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITY
   ═══════════════════════════════════════════════════════════════════════════ */
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ═══════════════════════════════════════════════════════════════════════════
   DB EVENT LISTENERS
   ═══════════════════════════════════════════════════════════════════════════ */
onDbEvent('status', ({ state: s, desc }) => {
  const dot  = document.getElementById('status-dot');
  const lbl  = document.getElementById('status-label');
  const orb  = document.getElementById('status-orb');
  const name = document.getElementById('status-name');
  const des  = document.getElementById('status-desc');

  const map = {
    local:   { cls:'',        nm:'LocalStorage', color:'var(--warning-color)' },
    online:  { cls:'online',  nm:'Connected',    color:'var(--income-color)' },
    offline: { cls:'offline', nm:'Offline',      color:'var(--text-muted)' },
    syncing: { cls:'syncing', nm:'Syncing…',     color:'var(--info-color)' },
    error:   { cls:'',        nm:'Error',        color:'var(--expense-color)' },
  };
  const info = map[s] || map.local;

  if (dot) { dot.className = `status-dot ${info.cls}`; }
  if (lbl) lbl.textContent = info.nm;
  if (orb) { orb.className = `status-orb ${info.cls}`; }
  if (name) name.textContent = info.nm;
  if (des) des.textContent = desc;

  updateCloudStats();
});

onDbEvent('log', ({ msg, type }) => {
  const log = document.getElementById('sync-log');
  if (!log) return;
  const entry = document.createElement('p');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString('en-IN')}] ${msg}`;
  log.insertBefore(entry, log.firstChild);
  if (log.children.length > 30) log.removeChild(log.lastChild);
});

onDbEvent('data', () => { loadData(); });

onDbEvent('sync', ({ lastSync }) => {
  document.getElementById('stat-last-sync').textContent =
    lastSync ? lastSync.toLocaleTimeString('en-IN') : 'Never';
});

/* ═══════════════════════════════════════════════════════════════════════════
   SEED DEMO DATA (if no data exists)
   ═══════════════════════════════════════════════════════════════════════════ */
function seedDemoData() {
  if (getTransactionsLocal().length > 0) return;

  const now   = new Date();
  const y     = now.getFullYear();
  const m     = String(now.getMonth()+1).padStart(2,'0');
  const pm    = String(now.getMonth()).padStart(2,'0') || '12';
  const py    = now.getMonth() === 0 ? y-1 : y;

  const demo = [
    // This month
    { id: uid(), type:'income',  amount:75000, date:`${y}-${m}-01`, description:'Monthly Salary',        category:'salary',     payment:'Net Banking', notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'income',  amount:12000, date:`${y}-${m}-05`, description:'Freelance Project',     category:'freelance',  payment:'UPI',         notes:'Web dev project', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:18000, date:`${y}-${m}-01`, description:'Apartment Rent',        category:'housing',    payment:'Net Banking', notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:4500,  date:`${y}-${m}-03`, description:'Grocery Shopping',      category:'food',       payment:'UPI',         notes:'BigBasket order', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:1800,  date:`${y}-${m}-07`, description:'Movie & Dinner',        category:'entertain',  payment:'Card',        notes:'Date night', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:2200,  date:`${y}-${m}-10`, description:'Electricity Bill',      category:'utilities',  payment:'UPI',         notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:3500,  date:`${y}-${m}-12`, description:'Amazon Shopping',       category:'shopping',   payment:'Card',        notes:'Gadgets', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:1200,  date:`${y}-${m}-14`, description:'Swiggy Food Order',     category:'food',       payment:'UPI',         notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:800,   date:`${y}-${m}-15`, description:'Metro Card Recharge',   category:'transport',  payment:'UPI',         notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:5000,  date:`${y}-${m}-18`, description:'Doctor Visit & Meds',   category:'health',     payment:'Cash',        notes:'Annual checkup', createdAt: new Date().toISOString() },
    { id: uid(), type:'income',  amount:3000,  date:`${y}-${m}-20`, description:'Stock Dividend',        category:'investment', payment:'Net Banking', notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:6000,  date:`${y}-${m}-22`, description:'Online Course',         category:'education',  payment:'Card',        notes:'Udemy courses', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:2500,  date:`${y}-${m}-25`, description:'Zomato Dining Out',     category:'food',       payment:'UPI',         notes:'Team lunch', createdAt: new Date().toISOString() },
    // Previous month
    { id: uid(), type:'income',  amount:75000, date:`${py}-${pm}-01`, description:'Monthly Salary',      category:'salary',     payment:'Net Banking', notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:18000, date:`${py}-${pm}-01`, description:'Apartment Rent',      category:'housing',    payment:'Net Banking', notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:7200,  date:`${py}-${pm}-08`, description:'Weekend Groceries',   category:'food',       payment:'Cash',        notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:3200,  date:`${py}-${pm}-12`, description:'Cab Rides',           category:'transport',  payment:'Card',        notes:'Ola monthly', createdAt: new Date().toISOString() },
    { id: uid(), type:'expense', amount:4800,  date:`${py}-${pm}-18`, description:'Clothes Shopping',    category:'shopping',   payment:'Card',        notes:'', createdAt: new Date().toISOString() },
    { id: uid(), type:'income',  amount:8000,  date:`${py}-${pm}-20`, description:'Bonus',               category:'gift',       payment:'Net Banking', notes:'Performance bonus', createdAt: new Date().toISOString() },
  ];

  demo.forEach(t => saveTransactionLocal(t));

  // Demo budgets
  saveBudgetsLocal({
    food: 12000, housing: 20000, transport: 4000,
    entertain: 3000, shopping: 5000, utilities: 3000,
  });

  addSyncLog('🎉 Demo data loaded — explore the app!', 'success');
}

function saveTransactionLocal(tx) {
  // Direct import — this calls the db.js function
  import('./db.js').then(db => {
    const all = db.getTransactionsLocal ? null : null; // already in scope
  });
  // Use the imported version from top-level
  const all = JSON.parse(localStorage.getItem('spendwise_transactions') || '[]');
  const idx = all.findIndex(t => t.id === tx.id);
  if (idx >= 0) all[idx] = tx; else all.push(tx);
  localStorage.setItem('spendwise_transactions', JSON.stringify(all));
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOOTSTRAP
   ═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  // Seed demo data if needed (before initDb so it goes into LocalStorage)
  seedDemoData();

  // Load saved Firebase config into form fields
  const saved = getSavedConfig();
  if (saved) {
    if (saved.apiKey)     document.getElementById('fb-api-key').value     = saved.apiKey;
    if (saved.projectId)  document.getElementById('fb-project-id').value  = saved.projectId;
    if (saved.authDomain) document.getElementById('fb-auth-domain').value = saved.authDomain;
    if (saved.appId)      document.getElementById('fb-app-id').value      = saved.appId;
  }

  // Init DB (connects to Firebase if config saved)
  await initDb();

  // Load data and render
  loadData();
});
