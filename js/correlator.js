/* ==========================================
   correlator.js — Transaction ↔ Benefit Correlation
   ========================================== */

'use strict';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ─── Main entry point ─── */
function correlateBenefits(selectedCards, transactions, benefitYear) {
  const yearStart = new Date(benefitYear, 0, 1);
  const yearEnd   = new Date(benefitYear, 11, 31, 23, 59, 59);

  const yearTxns = transactions.filter(t =>
    t.date && t.date >= yearStart && t.date <= yearEnd
  );

  return selectedCards.map(card => correlateCard(card, yearTxns, benefitYear));
}

function correlateCard(card, yearTxns, benefitYear) {
  const benefitResults = card.benefits.map(benefit =>
    correlateBenefit(benefit, yearTxns, benefitYear)
  );

  // Roll up totals for trackable benefits only
  const trackable = benefitResults.filter(b => b.trackable && b.benefit.type !== 'cashback');
  const totalValue  = trackable.reduce((s, b) => s + (b.benefit.annualValue || 0), 0);
  const totalUsed   = trackable.reduce((s, b) => s + b.used, 0);

  // Cashback summation
  const cashbackResult = benefitResults.find(b => b.benefit.type === 'cashback');

  return {
    card,
    benefitResults,
    totalValue,
    totalUsed,
    totalRemaining: Math.max(0, totalValue - totalUsed),
    estimatedCashback: cashbackResult ? cashbackResult.estimatedEarnings : 0
  };
}

/* ─── Route to the right algorithm ─── */
function correlateBenefit(benefit, yearTxns, benefitYear) {
  switch (benefit.type) {
    case 'statement_credit':
      return correlateStatementCredit(benefit, yearTxns);
    case 'monthly_credit':
      return correlateMonthlyCredit(benefit, yearTxns, benefitYear);
    case 'semi_annual_credit':
      return correlateSemiAnnualCredit(benefit, yearTxns, benefitYear);
    case 'quarterly_credit':
      return correlateQuarterlyCredit(benefit, yearTxns, benefitYear);
    case 'cashback':
      return correlateCashback(benefit, yearTxns);
    default:
      // membership, free_night, companion_cert — not trackable via spending
      return {
        benefit,
        trackable: false,
        used: 0,
        remaining: benefit.annualValue || 0,
        matchedTxns: [],
        status: 'not_trackable'
      };
  }
}

/* ─── Statement Credit ─── */
function correlateStatementCredit(benefit, yearTxns) {
  const matched = matchTransactions(benefit, yearTxns);
  const sum = matched.reduce((s, t) => s + t.amount, 0);
  const used = Math.min(sum, benefit.annualValue);
  const remaining = Math.max(0, benefit.annualValue - used);
  const pct = benefit.annualValue > 0 ? used / benefit.annualValue : 0;

  return {
    benefit,
    trackable: true,
    used,
    remaining,
    pct,
    matchedTxns: matched,
    status: statusFromPct(pct)
  };
}

/* ─── Monthly Credit ─── */
function correlateMonthlyCredit(benefit, yearTxns, benefitYear) {
  const matched = matchTransactions(benefit, yearTxns);

  // Group by month
  const byMonth = {};
  for (let m = 0; m < 12; m++) byMonth[m] = [];
  for (const t of matched) {
    const m = t.date.getMonth();
    byMonth[m].push(t);
  }

  let totalUsed = 0;
  const monthlyBreakdown = [];
  for (let m = 0; m < 12; m++) {
    const txns = byMonth[m];
    const monthSum = txns.reduce((s, t) => s + t.amount, 0);
    const monthUsed = Math.min(monthSum, benefit.monthlyValue);
    totalUsed += monthUsed;
    monthlyBreakdown.push({
      month: MONTH_NAMES[m],
      monthIndex: m,
      txns,
      sum: monthSum,
      used: monthUsed,
      cap: benefit.monthlyValue
    });
  }

  const pct = benefit.annualValue > 0 ? totalUsed / benefit.annualValue : 0;

  return {
    benefit,
    trackable: true,
    used: totalUsed,
    remaining: Math.max(0, benefit.annualValue - totalUsed),
    pct,
    matchedTxns: matched,
    monthlyBreakdown,
    status: statusFromPct(pct)
  };
}

/* ─── Semi-Annual Credit ─── */
function correlateSemiAnnualCredit(benefit, yearTxns, benefitYear) {
  const matched = matchTransactions(benefit, yearTxns);

  // Split into H1 (Jan-Jun) and H2 (Jul-Dec)
  const halfValue = benefit.annualValue / 2;
  const h1txns = matched.filter(t => t.date.getMonth() < 6);
  const h2txns = matched.filter(t => t.date.getMonth() >= 6);

  const h1sum  = h1txns.reduce((s, t) => s + t.amount, 0);
  const h2sum  = h2txns.reduce((s, t) => s + t.amount, 0);
  const h1used = Math.min(h1sum, halfValue);
  const h2used = Math.min(h2sum, halfValue);
  const totalUsed = h1used + h2used;

  const pct = benefit.annualValue > 0 ? totalUsed / benefit.annualValue : 0;

  return {
    benefit,
    trackable: true,
    used: totalUsed,
    remaining: Math.max(0, benefit.annualValue - totalUsed),
    pct,
    matchedTxns: matched,
    semiAnnualBreakdown: [
      { period: 'Jan–Jun', txns: h1txns, sum: h1sum, used: h1used, cap: halfValue },
      { period: 'Jul–Dec', txns: h2txns, sum: h2sum, used: h2used, cap: halfValue }
    ],
    status: statusFromPct(pct)
  };
}

/* ─── Quarterly Credit ─── */
function correlateQuarterlyCredit(benefit, yearTxns, benefitYear) {
  const matched = matchTransactions(benefit, yearTxns);
  const quarterValue = benefit.annualValue / 4;

  // Q1=0-2, Q2=3-5, Q3=6-8, Q4=9-11
  const quarters = [0,1,2,3].map(q => {
    const txns = matched.filter(t => Math.floor(t.date.getMonth() / 3) === q);
    const sum  = txns.reduce((s,t) => s + t.amount, 0);
    const used = Math.min(sum, quarterValue);
    return { label: `Q${q+1}`, txns, sum, used, cap: quarterValue };
  });

  const totalUsed = quarters.reduce((s, q) => s + q.used, 0);
  const pct = benefit.annualValue > 0 ? totalUsed / benefit.annualValue : 0;

  return {
    benefit,
    trackable: true,
    used: totalUsed,
    remaining: Math.max(0, benefit.annualValue - totalUsed),
    pct,
    matchedTxns: matched,
    quarterlyBreakdown: quarters,
    status: statusFromPct(pct)
  };
}

/* ─── Cashback ─── */
function correlateCashback(benefit, yearTxns) {
  const categories = benefit.categories || { default: 0 };
  const defaultRate = categories.default || 0;

  let totalEarnings = 0;
  const categoryTotals = {};

  for (const t of yearTxns) {
    const rate = getRateForTransaction(t, categories, defaultRate);
    const earned = t.amount * rate;
    totalEarnings += earned;

    const cat = t.category || 'Other';
    if (!categoryTotals[cat]) categoryTotals[cat] = { spent: 0, earned: 0, rate };
    categoryTotals[cat].spent  += t.amount;
    categoryTotals[cat].earned += earned;
  }

  const topCategories = Object.entries(categoryTotals)
    .sort((a, b) => b[1].earned - a[1].earned)
    .slice(0, 6)
    .map(([cat, data]) => ({
      category: cat,
      spent: data.spent,
      earned: data.earned,
      rate: data.rate
    }));

  return {
    benefit,
    trackable: true,
    estimatedEarnings: totalEarnings,
    topCategories,
    matchedTxns: yearTxns,
    status: 'cashback'
  };
}

/* ─── Shared helpers ─── */
function matchTransactions(benefit, txns) {
  const keywords = (benefit.eligibleKeywords || []).map(k => k.toLowerCase());
  const categories = (benefit.eligibleCategories || []).map(c => c.toLowerCase());

  return txns.filter(t => {
    const desc = t.description.toLowerCase();
    const cat  = (t.category || '').toLowerCase();

    if (keywords.some(kw => desc.includes(kw))) return true;
    if (categories.length && categories.some(c => cat.includes(c) || c.includes(cat))) return true;
    return false;
  });
}

function getRateForTransaction(t, categories, defaultRate) {
  const cat = (t.category || '').toLowerCase();
  const desc = t.description.toLowerCase();

  for (const [key, rate] of Object.entries(categories)) {
    if (key === 'default') continue;
    const k = key.toLowerCase();
    if (cat.includes(k) || k.includes(cat) || desc.includes(k)) {
      return rate;
    }
  }
  return defaultRate;
}

function statusFromPct(pct) {
  if (pct >= 0.999) return 'full';
  if (pct > 0)      return 'partial';
  return 'unused';
}

/* ─── Overlap Detection ─── */

// Keywords that uniquely identify a benefit type — used for name-based matching
// when two benefits don't share eligibleKeywords but mean the same thing
const OVERLAP_NAME_PHRASES = [
  'global entry', 'tsa precheck', 'nexus',
  'priority pass', 'centurion lounge',
  'clear plus', 'clearme',
  'dashpass', 'door dash',
  'lounge buddy', 'loungebuddy',
  'walmart+',
  'companion certificate', 'companion cert', 'companion fare'
];

// Benefits that cannot be "double-dipped" — having the same benefit on two
// cards provides no extra value (you can only enroll once, use once, etc.)
const NON_STACKABLE_PHRASES = [
  'global entry', 'tsa precheck', 'nexus',  // one enrollment per person
  'dashpass',                                 // one subscription needed
  'clear plus', 'clearme',                   // one CLEAR membership
  'walmart+',                                // one subscription
  'companion',                               // one companion cert per year per airline
];

function benefitsOverlap(a, b) {
  if (a.type === 'cashback' || b.type === 'cashback') return false;

  const kwA = (a.eligibleKeywords || []).map(k => k.toLowerCase());
  const kwB = (b.eligibleKeywords || []).map(k => k.toLowerCase());

  // Keyword intersection (most specific signal)
  if (kwA.length && kwB.length && kwA.some(k => kwB.includes(k))) return true;

  // Name-based matching for memberships / benefits without keywords
  const nameA = a.name.toLowerCase();
  const nameB = b.name.toLowerCase();
  if (OVERLAP_NAME_PHRASES.some(p => nameA.includes(p) && nameB.includes(p))) return true;

  return false;
}

function isStackable(a, b) {
  const nameA = a.name.toLowerCase();
  const kwA   = (a.eligibleKeywords || []).map(k => k.toLowerCase());

  // Non-stackable: same benefit you can only hold/use once
  if (NON_STACKABLE_PHRASES.some(p =>
    nameA.includes(p) || kwA.some(k => k.includes(p))
  )) return false;

  // Free nights at the same hotel chain: non-stackable
  if (a.type === 'free_night' && b.type === 'free_night') return false;

  // Memberships of the same kind (Priority Pass, etc.): redundant even if "stackable"
  if (a.type === 'membership' && b.type === 'membership') return false;

  return true; // monthly/annual credits at same merchant CAN both be redeemed
}

function deriveOverlapLabel(a, b) {
  // Use the shared keyword as the canonical label
  const kwA = (a.eligibleKeywords || []).map(k => k.toLowerCase());
  const kwB = (b.eligibleKeywords || []).map(k => k.toLowerCase());
  const shared = kwA.find(k => kwB.includes(k));
  if (shared) return shared.replace(/\b\w/g, c => c.toUpperCase());

  // Fall back to shared name phrase
  const nameA = a.name.toLowerCase();
  const nameB = b.name.toLowerCase();
  const phrase = OVERLAP_NAME_PHRASES.find(p => nameA.includes(p) && nameB.includes(p));
  if (phrase) return phrase.replace(/\b\w/g, c => c.toUpperCase());

  return a.name; // last resort
}

function detectOverlaps(cardResults) {
  if (cardResults.length < 2) return [];

  // groups: Map<label → { label, stackable, entries[] }>
  const groups = new Map();

  for (let i = 0; i < cardResults.length; i++) {
    for (const brA of cardResults[i].benefitResults) {
      if (brA.benefit.type === 'cashback') continue;

      for (let j = i + 1; j < cardResults.length; j++) {
        for (const brB of cardResults[j].benefitResults) {
          if (brB.benefit.type === 'cashback') continue;
          if (!benefitsOverlap(brA.benefit, brB.benefit)) continue;

          const label     = deriveOverlapLabel(brA.benefit, brB.benefit);
          const stackable = isStackable(brA.benefit, brB.benefit);

          if (!groups.has(label)) {
            groups.set(label, { label, stackable, entries: [] });
          }
          const grp = groups.get(label);

          // Add card A entry if not already present
          if (!grp.entries.some(e => e.cardId === cardResults[i].card.id && e.benefit === brA.benefit)) {
            grp.entries.push({
              cardId:      cardResults[i].card.id,
              card:        cardResults[i].card,
              benefit:     brA.benefit,
              annualValue: brA.benefit.annualValue || 0
            });
          }
          // Add card B entry if not already present
          if (!grp.entries.some(e => e.cardId === cardResults[j].card.id && e.benefit === brB.benefit)) {
            grp.entries.push({
              cardId:      cardResults[j].card.id,
              card:        cardResults[j].card,
              benefit:     brB.benefit,
              annualValue: brB.benefit.annualValue || 0
            });
          }
        }
      }
    }
  }

  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/* ─── Card Recommendations ─── */
function generateRecommendations(cardResults, overlaps, manualBenefits = {}) {
  if (cardResults.length < 2) return [];

  // Non-stackable overlaps this card participates in
  const nonStackableOverlaps = overlaps.filter(o => !o.stackable);

  return cardResults.map(cr => {
    const trackableBrs = cr.benefitResults.filter(
      b => b.trackable && b.benefit.type !== 'cashback'
    );

    // Which of this card's benefits are covered by a non-stackable overlap?
    const duplicatedBenefits = new Set();
    for (const ovl of nonStackableOverlaps) {
      const myEntry    = ovl.entries.find(e => e.cardId === cr.card.id);
      const otherCards = ovl.entries.filter(e => e.cardId !== cr.card.id);
      if (myEntry && otherCards.length > 0) {
        duplicatedBenefits.add(myEntry.benefit);
      }
    }

    // Value of manually-claimed non-trackable benefits (e.g. Priority Pass, lounge access)
    const manualValue = cr.benefitResults
      .filter(b => !b.trackable && b.benefit.annualValue &&
                   manualBenefits[`${cr.card.id}::${b.benefit.name}`])
      .reduce((s, b) => s + b.benefit.annualValue, 0);

    // Unique value = trackable benefit value NOT in a non-stackable overlap, plus manually-claimed memberships
    const totalTrackableValue = trackableBrs.reduce(
      (s, b) => s + (b.benefit.annualValue || 0), 0
    ) + manualValue;
    const duplicatedValue = [...duplicatedBenefits].reduce(
      (s, ben) => s + (ben.annualValue || 0), 0
    );
    const uniqueValue    = Math.max(0, totalTrackableValue - duplicatedValue);
    const cashback       = cr.estimatedCashback || 0;
    const netUniqueValue = uniqueValue + cashback - cr.card.annualFee;

    const overlapCount = duplicatedBenefits.size;
    const totalCount   = trackableBrs.length;
    const overlapRatio = totalCount > 0 ? overlapCount / totalCount : 0;

    let verdict, reason;
    if (cr.card.annualFee === 0) {
      verdict = 'keep';
      reason  = 'No annual fee — always worth keeping regardless of overlap.';
    } else if (netUniqueValue >= 0) {
      verdict = 'keep';
      reason  = `Unique benefit value (${fmtDollarInline(uniqueValue)}) + estimated cashback (${fmtDollarInline(cashback)}) covers the ${fmtDollarInline(cr.card.annualFee)} annual fee.`;
    } else if (netUniqueValue >= -75 || overlapRatio < 0.4) {
      verdict = 'review';
      reason  = `Marginal net unique value (${fmtDollarInline(netUniqueValue)}). Worthwhile if you consistently use the non-overlapping benefits.`;
    } else {
      verdict = 'cancel';
      reason  = `${overlapCount} of ${totalCount} trackable benefit${totalCount !== 1 ? 's' : ''} duplicated by other selected cards. Unique value (${fmtDollarInline(uniqueValue)}) doesn't cover the ${fmtDollarInline(cr.card.annualFee)} fee.`;
    }

    return {
      card: cr.card,
      totalTrackableValue,
      duplicatedValue,
      uniqueValue,
      cashback,
      netUniqueValue,
      overlapCount,
      totalCount,
      duplicatedBenefits,
      verdict,
      reason
    };
  // Sort: cancel first, then review, then keep
  }).sort((a, b) => {
    const order = { cancel: 0, review: 1, keep: 2 };
    return order[a.verdict] - order[b.verdict];
  });
}

function fmtDollarInline(n) {
  const abs = Math.abs(n || 0);
  const s = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (n < 0 ? '-' : '') + s;
}

/* ─── Summary calculation ─── */
function calcSummary(cardResults) {
  let totalValue    = 0;
  let totalUsed     = 0;
  let totalCashback = 0;
  let totalAnnualFee = 0;

  for (const cr of cardResults) {
    totalValue     += cr.totalValue;
    totalUsed      += cr.totalUsed;
    totalCashback  += cr.estimatedCashback || 0;
    totalAnnualFee += cr.card.annualFee || 0;
  }

  const totalRemaining  = Math.max(0, totalValue - totalUsed);
  const netValue        = totalUsed + totalCashback - totalAnnualFee;

  return { totalValue, totalUsed, totalRemaining, totalCashback, totalAnnualFee, netValue };
}
