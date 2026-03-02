/* ==========================================
   parser.js — CSV Bank Format Detection & Normalization
   ========================================== */

'use strict';

const BANK_FORMATS = {
  chase: {
    name: 'Chase',
    detect: (headers) =>
      headers.includes('transaction date') &&
      headers.includes('description') &&
      headers.includes('amount') &&
      !headers.includes('debit'),
    parse: (row) => {
      const amount = parseFloat((row['Amount'] || '0').replace(/[^0-9.\-]/g, ''));
      // Chase: negative = charge, positive = credit/refund
      if (amount >= 0) return null; // skip credits/refunds
      return {
        date: parseDate(row['Transaction Date']),
        description: (row['Description'] || '').trim(),
        category: (row['Category'] || '').trim(),
        amount: Math.abs(amount)
      };
    }
  },

  amex: {
    name: 'American Express',
    detect: (headers) =>
      headers.includes('date') &&
      headers.includes('description') &&
      headers.includes('amount') &&
      !headers.includes('transaction date') &&
      !headers.includes('status') &&
      !headers.includes('debit'),
    parse: (row) => {
      const amount = parseFloat((row['Amount'] || '0').replace(/[^0-9.\-]/g, ''));
      // Amex: positive = charge, negative = credit
      if (amount <= 0) return null;
      return {
        date: parseDate(row['Date']),
        description: (row['Description'] || '').trim(),
        category: (row['Category'] || row['Extended Details'] || '').trim(),
        amount: Math.abs(amount)
      };
    }
  },

  citi: {
    name: 'Citi',
    detect: (headers) =>
      headers.includes('status') &&
      headers.includes('date') &&
      headers.includes('description') &&
      (headers.includes('debit') || headers.includes('credit')),
    parse: (row) => {
      const debit = parseFloat((row['Debit'] || '').replace(/[^0-9.\-]/g, '') || '0');
      if (!debit || isNaN(debit) || debit <= 0) return null;
      return {
        date: parseDate(row['Date']),
        description: (row['Description'] || '').trim(),
        category: (row['Category'] || '').trim(),
        amount: debit
      };
    }
  },

  bofa: {
    name: 'Bank of America',
    detect: (headers) =>
      headers.includes('posted date') &&
      (headers.includes('payee') || headers.includes('description')),
    parse: (row) => {
      const amount = parseFloat((row['Amount'] || '0').replace(/[^0-9.\-]/g, ''));
      // BofA: negative = charge
      if (amount >= 0) return null;
      return {
        date: parseDate(row['Posted Date']),
        description: (row['Payee'] || row['Description'] || '').trim(),
        category: (row['Transaction Type'] || '').trim(),
        amount: Math.abs(amount)
      };
    }
  },

  capital_one: {
    name: 'Capital One',
    detect: (headers) =>
      headers.includes('transaction date') &&
      headers.includes('description') &&
      headers.includes('debit') &&
      headers.includes('credit'),
    parse: (row) => {
      const debit = parseFloat((row['Debit'] || '').replace(/[^0-9.\-]/g, '') || '0');
      if (!debit || isNaN(debit) || debit <= 0) return null;
      return {
        date: parseDate(row['Transaction Date']),
        description: (row['Description'] || '').trim(),
        category: (row['Category'] || '').trim(),
        amount: debit
      };
    }
  },

  wells_fargo: {
    name: 'Wells Fargo',
    detect: (headers, firstRow) => {
      // Wells Fargo has no headers — 5-column format
      return headers.length >= 3 && isDateString(headers[0]) && !isNaN(parseFloat(headers[1]));
    },
    parse: (row, rawHeaders) => {
      // Columns: date, amount, *, *, description (no header row)
      const vals = Object.values(row);
      if (vals.length < 5) return null;
      const amount = parseFloat((vals[1] || '').replace(/[^0-9.\-]/g, ''));
      if (isNaN(amount) || amount >= 0) return null;
      return {
        date: parseDate(vals[0]),
        description: (vals[4] || vals[3] || '').trim(),
        category: '',
        amount: Math.abs(amount)
      };
    }
  }
};

/* ─── Helpers ─── */
function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  // Try multiple formats: MM/DD/YYYY, YYYY-MM-DD, MM-DD-YYYY
  let d = new Date(str);
  if (!isNaN(d)) return d;
  // Try MM/DD/YYYY
  const parts = str.split(/[\/\-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      d = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
    } else {
      d = new Date(parseInt(parts[2]), parseInt(parts[0])-1, parseInt(parts[1]));
    }
    if (!isNaN(d)) return d;
  }
  return null;
}

function isDateString(str) {
  if (!str) return false;
  return /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(str.trim());
}

function normalizeHeaders(headers) {
  return headers.map(h => (h || '').toLowerCase().trim());
}

/* ─── Main Parse Function ─── */
function parseCSV(csvText, filename) {
  // Try with headers first
  let result = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    trimHeaders: true
  });

  let rows = result.data;
  let rawHeaders = result.meta.fields || [];
  let normHeaders = normalizeHeaders(rawHeaders);

  // Detect format
  let format = null;
  for (const [key, fmt] of Object.entries(BANK_FORMATS)) {
    if (fmt.detect(normHeaders, rows[0])) {
      format = fmt;
      break;
    }
  }

  // If no format detected with headers, try Wells Fargo (no-header) mode
  if (!format) {
    const noHeaderResult = Papa.parse(csvText, {
      header: false,
      skipEmptyLines: true
    });
    const firstRow = noHeaderResult.data[0] || [];
    const firstRowNorm = firstRow.map(v => (v || '').toLowerCase().trim());
    if (BANK_FORMATS.wells_fargo.detect(firstRowNorm, firstRow)) {
      format = BANK_FORMATS.wells_fargo;
      // Re-parse treating first row as data
      rows = noHeaderResult.data.map(r => {
        const obj = {};
        r.forEach((v, i) => { obj[i] = v; });
        return obj;
      });
      rawHeaders = firstRow;
    }
  }

  if (!format) {
    // Fallback: try to auto-detect common column names
    format = guessFormat(normHeaders);
  }

  if (!format) {
    throw new Error('Unrecognized CSV format. Please export from Chase, Amex, Citi, BofA, Capital One, or Wells Fargo.');
  }

  const transactions = [];
  for (const row of rows) {
    try {
      const txn = format.parse(row, rawHeaders);
      if (txn && txn.date && !isNaN(txn.date) && txn.amount > 0) {
        transactions.push(txn);
      }
    } catch (e) {
      // skip malformed rows
    }
  }

  if (transactions.length === 0) {
    throw new Error('No valid transactions found. Make sure the file contains spending data.');
  }

  const dates = transactions.map(t => t.date).filter(Boolean).sort((a,b) => a-b);

  return {
    bankName: format.name,
    transactions,
    dateRange: {
      start: dates[0],
      end: dates[dates.length - 1]
    },
    topCategories: getTopCategories(transactions)
  };
}

function guessFormat(normHeaders) {
  // Generic fallback: look for date/description/amount columns
  const hasDate = normHeaders.some(h => h.includes('date'));
  const hasDesc = normHeaders.some(h => h.includes('desc') || h.includes('payee') || h.includes('merchant'));
  const hasAmount = normHeaders.some(h => h.includes('amount') || h.includes('debit'));

  if (!hasDate || !hasDesc || !hasAmount) return null;

  return {
    name: 'Generic',
    detect: () => true,
    parse: (row) => {
      const keys = Object.keys(row);
      const dateKey = keys.find(k => k.toLowerCase().includes('date'));
      const descKey = keys.find(k => k.toLowerCase().includes('desc') || k.toLowerCase().includes('payee') || k.toLowerCase().includes('merchant'));
      const amountKey = keys.find(k => k.toLowerCase().includes('amount') || k.toLowerCase().includes('debit'));
      const catKey = keys.find(k => k.toLowerCase().includes('category') || k.toLowerCase().includes('type'));
      if (!dateKey || !descKey || !amountKey) return null;
      const raw = (row[amountKey] || '').replace(/[^0-9.\-]/g, '');
      const amount = parseFloat(raw);
      if (isNaN(amount)) return null;
      return {
        date: parseDate(row[dateKey]),
        description: (row[descKey] || '').trim(),
        category: catKey ? (row[catKey] || '').trim() : '',
        amount: Math.abs(amount)
      };
    }
  };
}

function getTopCategories(transactions) {
  const counts = {};
  for (const t of transactions) {
    if (t.category) {
      counts[t.category] = (counts[t.category] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, count]) => ({ category: cat, count }));
}

function formatDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
