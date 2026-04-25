// UK Student Loan: pay-off vs invest calculator
//
// All rates are entered as percentages by the user; we convert to decimals
// internally. Years are tax years labelled by their starting April.
//
// Sources for default rules (2025/26 tax year):
//   Plan 1: threshold £26,065, 9%, interest = lower(RPI March, BoE base + 1%),
//           cancelled 25 yrs after first April due to repay (or age 65 for
//           pre-2006 loans — we model the 25-yr OR age-65, whichever first).
//   Plan 2: threshold £27,295 (frozen until Apr 2027, then CPI), 9%,
//           interest sliding RPI → RPI+3% across £27,295 to £49,130, hard cap
//           at the Prevailing Market Rate (~7.3%), cancelled 30 yrs.
//   Plan 4: threshold £31,395, 9%, interest = lower(RPI, BoE base + 1%),
//           cancelled 30 yrs (or age 65 for older SAAS loans).
//   Plan 5: threshold £25,000 (frozen until Apr 2027, then RPI), 9%,
//           interest = RPI, cancelled 40 yrs.
//   Postgrad: threshold £21,000, 6%, interest = RPI + 3%, cancelled 30 yrs.

const PLANS = {
  plan1: {
    label: "Plan 1",
    threshold: 26065,
    rate: 0.09,
    termYears: 25,
    cancelAtAge: 65,
    interest: ({ rpi, boe }) => Math.min(rpi, boe + 0.01),
    upperThreshold: null,
  },
  plan2: {
    label: "Plan 2",
    threshold: 27295,
    upperThreshold: 49130,
    rate: 0.09,
    termYears: 30,
    cancelAtAge: null,
    interest: ({ rpi, salary, threshold, upper, pmrCap }) => {
      let r;
      if (salary <= threshold) r = rpi;
      else if (salary >= upper) r = rpi + 0.03;
      else r = rpi + 0.03 * (salary - threshold) / (upper - threshold);
      return Math.min(r, pmrCap);
    },
  },
  plan4: {
    label: "Plan 4",
    threshold: 31395,
    rate: 0.09,
    termYears: 30,
    cancelAtAge: 65,
    interest: ({ rpi, boe }) => Math.min(rpi, boe + 0.01),
    upperThreshold: null,
  },
  plan5: {
    label: "Plan 5",
    threshold: 25000,
    rate: 0.09,
    termYears: 40,
    cancelAtAge: null,
    interest: ({ rpi }) => rpi,
    upperThreshold: null,
  },
  postgrad: {
    label: "Postgraduate",
    threshold: 21000,
    rate: 0.06,
    termYears: 30,
    cancelAtAge: null,
    interest: ({ rpi }) => rpi + 0.03,
    upperThreshold: null,
  },
};

const fmt0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 });
const pct = (v) => (v * 100).toFixed(2) + "%";

function readForm(form) {
  const f = new FormData(form);
  const num = (k) => parseFloat(f.get(k));
  const promotions = [];
  for (let i = 1; i <= 5; i++) {
    const year = num(`promoYear${i}`);
    const pct = num(`promoAmount${i}`);
    if (Number.isFinite(year) && Number.isFinite(pct) && pct > 0) {
      promotions.push({ year, pct: pct / 100 });
    }
  }
  return {
    plan: f.get("plan"),
    balance: num("balance"),
    firstRepayYear: num("firstRepayYear"),
    age: num("age"),
    salary: num("salary"),
    realWageGrowth: num("realWageGrowth") / 100,
    promotions,
    rpi: num("rpi") / 100,
    cpi: num("cpi") / 100,
    boe: num("boe") / 100,
    thresholdPolicy: f.get("thresholdPolicy"),
    freezeEnd: num("freezeEnd"),
    thresholdCustom: num("thresholdCustom") / 100,
    pmrCap: num("pmrCap") / 100,
    lumpSum: num("lumpSum"),
    invReturn: num("invReturn") / 100,
    invFees: num("invFees") / 100,
    wrapper: f.get("wrapper"),
    cgt: num("cgt") / 100,
  };
}

function thresholdGrowth(year, p) {
  switch (p.thresholdPolicy) {
    case "frozen":
      return year < p.freezeEnd ? 0 : p.cpi;
    case "freezeForever":
      return 0;
    case "cpi":
      return p.cpi;
    case "rpi":
      return p.rpi;
    case "custom":
      return p.thresholdCustom;
  }
  return 0;
}

function projectLoan(p) {
  const plan = PLANS[p.plan];
  const startYear = new Date().getFullYear(); // current calendar year
  // Years already elapsed since first liable to repay (in April):
  const yearsSinceLiable = Math.max(0, startYear - p.firstRepayYear);
  // Remaining years until write-off:
  let remainingTerm = Math.max(0, plan.termYears - yearsSinceLiable);
  if (plan.cancelAtAge) {
    const yearsToAgeCancel = plan.cancelAtAge - p.age;
    remainingTerm = Math.min(remainingTerm, Math.max(0, yearsToAgeCancel));
  }

  let balance = p.balance;
  let salary = p.salary;
  let threshold = plan.threshold;
  let upper = plan.upperThreshold;
  const rows = [];
  let totalNominalRepaid = 0;
  let totalRealRepaid = 0;
  let cumulativeInflation = 1; // multiplier from year 0 → year t

  for (let t = 0; t < remainingTerm; t++) {
    const calYear = startYear + t;

    // 1. Wage growth (real + inflation), applied at start of the year
    if (t > 0) {
      salary *= (1 + p.realWageGrowth) * (1 + p.rpi);
    }
    // promotion bumps (up to 5, % uplift applied at the start of the named year)
    for (const promo of p.promotions) {
      if (t === Math.round(promo.year)) salary *= 1 + promo.pct;
    }

    // 2. Threshold uprating
    if (t > 0) {
      const g = thresholdGrowth(calYear, p);
      threshold *= 1 + g;
      if (upper) upper *= 1 + g;
    }

    // 3. Interest for this year
    const interestRate = plan.interest({
      rpi: p.rpi, boe: p.boe, salary, threshold, upper, pmrCap: p.pmrCap,
    });
    const interest = balance * interestRate;
    balance += interest;

    // 4. Repayment (annual, capped at balance)
    const liable = Math.max(0, salary - threshold);
    let repayment = Math.min(balance, liable * plan.rate);
    if (repayment < 0) repayment = 0;
    balance -= repayment;

    // 5. Real (today's £) repayment
    cumulativeInflation *= 1 + p.rpi;
    const realRepayment = repayment / cumulativeInflation;

    totalNominalRepaid += repayment;
    totalRealRepaid += realRepayment;

    rows.push({
      year: t + 1,
      calYear,
      salary,
      threshold,
      interestRate,
      interest,
      repayment,
      realRepayment,
      balance,
      cumNominal: totalNominalRepaid,
      cumReal: totalRealRepaid,
    });

    if (balance <= 0.005) {
      balance = 0;
      // Loan paid off — stop accruing further repayments
      break;
    }
  }

  const writtenOff = balance > 0;
  return {
    plan,
    rows,
    totalNominalRepaid,
    totalRealRepaid,
    writtenOff,
    finalBalance: balance,
    remainingTerm,
  };
}

function projectInvestment(p, years) {
  // Grow the lump sum at (return − fees) for `years`, then apply tax on gain.
  const netReturn = p.invReturn - p.invFees;
  const rows = [];
  let value = p.lumpSum;
  for (let t = 1; t <= years; t++) {
    value *= 1 + netReturn;
    rows.push({ year: t, calYear: new Date().getFullYear() + t, value });
  }
  let gain = Math.max(0, value - p.lumpSum);
  let taxOnGain = 0;
  if (p.wrapper === "gia") {
    taxOnGain = gain * p.cgt;
  }
  const afterTax = value - taxOnGain;
  // Real (today's £) terminal value
  const realAfterTax = afterTax / Math.pow(1 + p.rpi, years);
  return { rows, terminalNominal: value, taxOnGain, terminalAfterTax: afterTax, realTerminal: realAfterTax };
}

function pvRepayments(rows, discountRate) {
  let pv = 0;
  rows.forEach(r => { pv += r.repayment / Math.pow(1 + discountRate, r.year); });
  return pv;
}

function render(p, loan, inv) {
  const results = document.getElementById("results");
  results.hidden = false;

  // Discount rate for apples-to-apples = the investment net return
  const discountRate = p.invReturn - p.invFees;
  const pv = pvRepayments(loan.rows, discountRate);

  const lumpSumNet = p.wrapper === "gia"
    ? p.lumpSum  // pre-tax lump sum used to pay off (no CGT due — repayment is settled in cash you already have)
    : p.lumpSum;

  // Net financial benefit of investing: future real value of investments
  // minus the real cost of letting the loan run.
  const benefitOfInvesting = inv.realTerminal - loan.totalRealRepaid;

  // --- Recommendation
  const rec = document.getElementById("recommendation");
  rec.classList.remove("invest", "payoff", "neutral");
  let verdict, reason, cls;
  if (Math.abs(benefitOfInvesting) < p.lumpSum * 0.05) {
    verdict = "It's roughly a wash.";
    reason = `Investing the lump sum is projected to leave you within ±5% of paying off the loan, in real terms. Pick the option that better suits your risk appetite.`;
    cls = "neutral";
  } else if (benefitOfInvesting > 0) {
    verdict = "Probably better to invest the lump sum.";
    reason = `Investing &pound;${p.lumpSum.toLocaleString()} at ${pct(p.invReturn - p.invFees)} net is projected to be worth ${fmt0.format(inv.realTerminal)} in today&rsquo;s &pound; after ${loan.rows.length} yr&mdash;${fmt0.format(benefitOfInvesting)} more than the real-terms cost of the loan (${fmt0.format(loan.totalRealRepaid)}).`;
    cls = "invest";
  } else {
    verdict = "Probably better to pay off the loan.";
    reason = `Letting the loan run will cost ${fmt0.format(loan.totalRealRepaid)} in today&rsquo;s &pound; over ${loan.rows.length} yr, more than the projected real value of investing the lump sum (${fmt0.format(inv.realTerminal)}). Net cost of choosing &lsquo;invest&rsquo; vs &lsquo;pay off&rsquo;: ${fmt0.format(-benefitOfInvesting)}.`;
    cls = "payoff";
  }
  rec.classList.add(cls);
  rec.innerHTML = `<strong>${verdict}</strong><br>${reason}`;

  // --- Summary table
  const summary = document.getElementById("summary");
  const writtenOffNote = loan.writtenOff
    ? ` <em>(balance of ${fmt0.format(loan.finalBalance)} written off)</em>`
    : ` <em>(loan repaid in full)</em>`;
  summary.innerHTML = `
    <tr><td>Plan</td><td>${loan.plan.label}</td></tr>
    <tr><td>Years modelled until write-off / payoff</td><td>${loan.rows.length}${writtenOffNote}</td></tr>
    <tr><td>Total <strong>nominal</strong> repaid over loan</td><td>${fmt0.format(loan.totalNominalRepaid)}</td></tr>
    <tr><td>Total <strong>real</strong> repaid (today&rsquo;s &pound;)</td><td>${fmt0.format(loan.totalRealRepaid)}</td></tr>
    <tr><td>PV of repayments at investment discount rate (${pct(discountRate)})</td><td>${fmt0.format(pv)}</td></tr>
    <tr><td>Lump sum if invested for ${loan.rows.length} yr at ${pct(p.invReturn - p.invFees)} net</td><td>${fmt0.format(inv.terminalNominal)}</td></tr>
    <tr><td>&hellip;after ${p.wrapper === "gia" ? "CGT on gain" : "(ISA — no CGT)"}</td><td>${fmt0.format(inv.terminalAfterTax)}</td></tr>
    <tr><td>&hellip;in today&rsquo;s &pound; (real terminal value)</td><td>${fmt0.format(inv.realTerminal)}</td></tr>
    <tr><td>Net real benefit of investing vs paying off</td>
        <td class="${benefitOfInvesting >= 0 ? 'pos' : 'neg'}">${fmt0.format(benefitOfInvesting)}</td></tr>
  `;

  // --- Assumptions echo
  const assum = document.getElementById("assumptions");
  assum.innerHTML = `
    <tr><td>Plan threshold (year 0)</td><td>${fmt0.format(loan.plan.threshold)}</td></tr>
    <tr><td>Repayment rate above threshold</td><td>${pct(loan.plan.rate)}</td></tr>
    <tr><td>Statutory term</td><td>${loan.plan.termYears} yr${loan.plan.cancelAtAge ? ` or age ${loan.plan.cancelAtAge}` : ""}</td></tr>
    <tr><td>RPI / CPI / BoE base</td><td>${pct(p.rpi)} / ${pct(p.cpi)} / ${pct(p.boe)}</td></tr>
    <tr><td>Real wage growth</td><td>${pct(p.realWageGrowth)} p.a.</td></tr>
    <tr><td>Threshold policy</td><td>${describeThresholdPolicy(p)}</td></tr>
    <tr><td>Investment net return</td><td>${pct(p.invReturn - p.invFees)} (${pct(p.invReturn)} gross &minus; ${pct(p.invFees)} fees)</td></tr>
    <tr><td>Tax wrapper</td><td>${p.wrapper === "gia" ? `GIA, CGT ${pct(p.cgt)} on gains` : "ISA / SIPP drawdown — tax-free growth"}</td></tr>
  `;

  // --- Year by year schedule
  // Each money cell shows: nominal £ with today's-£ (real) value in brackets.
  const sched = document.getElementById("schedule");
  const money = (nominal, year) => {
    const real = nominal / Math.pow(1 + p.rpi, year);
    return `${fmt0.format(nominal)} <span class="real">(${fmt0.format(real)})</span>`;
  };
  sched.innerHTML = `
    <thead><tr>
      <th>Yr</th><th>Tax yr (Apr)</th><th>Salary</th><th>Threshold</th>
      <th>Int. rate</th><th>Interest</th><th>Repayment</th>
      <th>Balance end</th><th>Cumulative repaid</th>
    </tr></thead>
    <tbody>
      ${loan.rows.map(r => `
        <tr>
          <td>${r.year}</td>
          <td>${r.calYear}</td>
          <td class="num">${money(r.salary, r.year)}</td>
          <td class="num">${money(r.threshold, r.year)}</td>
          <td class="num">${pct(r.interestRate)}</td>
          <td class="num">${money(r.interest, r.year)}</td>
          <td class="num">${money(r.repayment, r.year)}</td>
          <td class="num">${money(r.balance, r.year)}</td>
          <td class="num">${money(r.cumNominal, r.year)}</td>
        </tr>`).join("")}
    </tbody>`;

  // --- Investment schedule
  const invTable = document.getElementById("investment");
  invTable.innerHTML = `
    <thead><tr><th>Yr</th><th>Calendar yr</th><th>Nominal value</th><th>Real value (today&rsquo;s &pound;)</th></tr></thead>
    <tbody>
      ${inv.rows.map(r => `
        <tr>
          <td>${r.year}</td>
          <td>${r.calYear}</td>
          <td class="num">${fmt0.format(r.value)}</td>
          <td class="num">${fmt0.format(r.value / Math.pow(1 + p.rpi, r.year))}</td>
        </tr>`).join("")}
    </tbody>`;

  // --- Explainer
  const exp = document.getElementById("explainer");
  exp.innerHTML = explainer(p, loan);
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function describeThresholdPolicy(p) {
  switch (p.thresholdPolicy) {
    case "frozen": return `Frozen until April ${p.freezeEnd}, then CPI`;
    case "freezeForever": return "Frozen for the whole term";
    case "cpi": return "Uprated by CPI each year";
    case "rpi": return "Uprated by RPI each year";
    case "custom": return `Uprated by a custom ${pct(p.thresholdCustom)} p.a.`;
  }
}

function explainer(p, loan) {
  return `
    <ol>
      <li><strong>Loop</strong> from now until the earlier of the statutory write-off date${loan.plan.cancelAtAge ? `, age ${loan.plan.cancelAtAge}` : ""} or the year your balance hits zero.</li>
      <li><strong>Salary</strong> grows by <code>(1 + real wage growth) &times; (1 + RPI)</code> each year, plus your one-off promotion bump.</li>
      <li><strong>Threshold</strong> uprating follows your selected government policy (${describeThresholdPolicy(p)}).</li>
      <li><strong>Interest rate</strong> for ${loan.plan.label}: ${interestRule(loan.plan)}. Applied to the opening balance.</li>
      <li><strong>Repayment</strong> = <code>${pct(loan.plan.rate)} &times; max(0, salary &minus; threshold)</code>, capped at the remaining balance. Deducted at year-end.</li>
      <li><strong>Real cash flows</strong> are deflated each year by RPI to express everything in today&rsquo;s &pound;.</li>
      <li><strong>Investment alternative:</strong> the same lump sum compounds at <code>${pct(p.invReturn)} &minus; ${pct(p.invFees)} fees = ${pct(p.invReturn - p.invFees)}</code>. ${p.wrapper === "gia" ? `On withdrawal, ${pct(p.cgt)} CGT applies to the gain (annual exemption ignored).` : "ISA/SIPP-drawdown is treated as tax-free."} The terminal value is then deflated by RPI to today&rsquo;s &pound;.</li>
      <li><strong>Recommendation</strong> compares <em>real terminal value of investing</em> against <em>total real cost of repayments</em>. Differences within 5% of the lump sum are flagged as a wash, since the model is sensitive to small changes in RPI and investment-return assumptions.</li>
    </ol>
    <p><em>Caveats:</em> annual (not daily) interest; ignores ISA/CGT allowance; ignores National Insurance and income-tax interactions on salary growth; assumes you stay UK-resident under PAYE; PMR cap on Plan 2 is applied as a hard ceiling on the year's interest rate; doesn't model overpayments, only a single optional one-off lump sum payoff today.</p>
  `;
}

function interestRule(plan) {
  switch (plan.label) {
    case "Plan 1": return "lower of RPI (March) or BoE base rate + 1%";
    case "Plan 2": return `sliding scale, RPI at the lower threshold rising linearly to RPI + 3% at the upper threshold (currently &pound;49,130), capped at the Prevailing Market Rate`;
    case "Plan 4": return "lower of RPI or BoE base rate + 1%";
    case "Plan 5": return "RPI";
    case "Postgraduate": return "RPI + 3%";
  }
}

document.getElementById("inputs").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = readForm(e.target);
  const loan = projectLoan(p);
  const inv = projectInvestment(p, Math.max(1, loan.rows.length));
  render(p, loan, inv);
});

document.getElementById("inputs").addEventListener("reset", () => {
  document.getElementById("results").hidden = true;
});
