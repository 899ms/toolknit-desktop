export function formatMoney(value) {
  if (!Number.isFinite(value)) return '--';
  return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatWan(value, unit = '万') {
  if (!Number.isFinite(value)) return '--';
  return unit === '万' ? `${value.toFixed(2)} ${unit}` : formatMoney(value * 10000);
}

export function calculateMortgage({ amountWan, termYears, annualRate, method = 'equalPayment' } = {}) {
  const amount = Number.parseFloat(amountWan);
  const term = Number.parseFloat(termYears);
  const rate = Number.parseFloat(annualRate);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(term) || term <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
  const months = Math.round(term * 12);
  if (months < 1) return null;

  const principal = amount * 10000;
  const monthlyRate = rate / 100 / 12;
  const schedule = [];
  let totalInterest = 0;
  let totalPayment = 0;
  let firstMonthly = 0;
  let lastMonthly = 0;
  let monthlyDisplay = '';
  let monthlyKind = 'fixed';

  if (method === 'equalPrincipal') {
    const monthlyPrincipal = principal / months;
    let remaining = principal;
    for (let month = 1; month <= months; month += 1) {
      const interest = remaining * monthlyRate;
      const payment = monthlyPrincipal + interest;
      remaining -= monthlyPrincipal;
      if (month === months) remaining = 0;
      totalInterest += interest;
      schedule.push({ month, principal: monthlyPrincipal, interest, remaining: Math.max(0, remaining) });
      if (month === 1) firstMonthly = payment;
      if (month === months) lastMonthly = payment;
    }
    totalPayment = principal + totalInterest;
    monthlyDisplay = `${formatMoney(firstMonthly)} → ${formatMoney(lastMonthly)}`;
    monthlyKind = 'decreasing';
  } else {
    const factor = Math.pow(1 + monthlyRate, months);
    const monthlyPayment = monthlyRate === 0
      ? principal / months
      : principal * monthlyRate * factor / (factor - 1);
    let remaining = principal;
    firstMonthly = monthlyPayment;
    lastMonthly = monthlyPayment;
    for (let month = 1; month <= months; month += 1) {
      const interest = remaining * monthlyRate;
      const monthlyPrincipal = monthlyPayment - interest;
      remaining -= monthlyPrincipal;
      if (month === months) remaining = 0;
      totalInterest += interest;
      schedule.push({ month, principal: monthlyPrincipal, interest, remaining: Math.max(0, remaining) });
    }
    totalPayment = monthlyPayment * months;
    monthlyDisplay = formatMoney(monthlyPayment);
  }

  return {
    months,
    principal,
    totalInterest,
    totalPayment,
    firstMonthly,
    lastMonthly,
    monthlyDisplay,
    monthlyKind,
    schedule
  };
}
