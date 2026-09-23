export function formatInterestMoney(value) {
  if (!Number.isFinite(value)) return '--';
  return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function calculateInterest({
  principal,
  regularAmount,
  annualRate,
  termYears,
  mode = 'simple',
  frequency = 'yearly'
} = {}) {
  const rate = Number.parseFloat(annualRate);
  const term = Number.parseFloat(termYears);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(term) || term <= 0) return null;
  const initialPrincipal = Number.parseFloat(principal);
  const recurringAmount = Number.parseFloat(regularAmount);
  if (mode === 'recurring' && (!Number.isFinite(recurringAmount) || recurringAmount <= 0)) return null;
  if (mode !== 'recurring' && (!Number.isFinite(initialPrincipal) || initialPrincipal <= 0)) return null;

  const monthlyRate = rate / 100 / 12;
  const dailyRate = rate / 100 / 365;
  const schedule = [];
  let totalAmount = 0;
  let totalInterest = 0;
  let totalInvested = 0;

  if (mode === 'simple') {
    totalInterest = initialPrincipal * (rate / 100) * term;
    totalAmount = initialPrincipal + totalInterest;
    totalInvested = initialPrincipal;
    for (let period = 1; period <= term; period += 1) {
      const periodInterest = initialPrincipal * (rate / 100);
      schedule.push({ period, invested: period === 1 ? initialPrincipal : 0, interest: periodInterest, balance: initialPrincipal + periodInterest * period });
    }
  } else if (mode === 'compound') {
    const periodsPerYear = frequency === 'yearly' ? 1 : frequency === 'monthly' ? 12 : 365;
    const ratePerPeriod = frequency === 'yearly' ? rate / 100 : frequency === 'monthly' ? monthlyRate : dailyRate;
    const totalPeriods = Math.round(term * periodsPerYear);
    let balance = initialPrincipal;
    totalInvested = initialPrincipal;
    if (frequency === 'daily') {
      let periodInterestSum = 0;
      for (let period = 1; period <= totalPeriods; period += 1) {
        const periodInterest = balance * ratePerPeriod;
        balance += periodInterest;
        periodInterestSum += periodInterest;
        if (period % periodsPerYear === 0) {
          const year = Math.floor(period / periodsPerYear);
          schedule.push({ period: year, invested: year === 1 ? initialPrincipal : 0, interest: periodInterestSum, balance });
          periodInterestSum = 0;
        }
      }
      if (periodInterestSum > 0) schedule.push({ period: schedule.length + 1, invested: 0, interest: periodInterestSum, balance });
    } else {
      for (let period = 1; period <= totalPeriods; period += 1) {
        const periodInterest = balance * ratePerPeriod;
        balance += periodInterest;
        schedule.push({ period, invested: period === 1 ? initialPrincipal : 0, interest: periodInterest, balance });
      }
    }
    totalAmount = balance;
    totalInterest = totalAmount - initialPrincipal;
  } else {
    const totalMonths = Math.round(term * 12);
    let balance = 0;
    totalInvested = 0;
    for (let period = 1; period <= totalMonths; period += 1) {
      balance += recurringAmount;
      totalInvested += recurringAmount;
      const periodInterest = balance * monthlyRate;
      balance += periodInterest;
      schedule.push({ period, invested: recurringAmount, interest: periodInterest, balance });
    }
    totalAmount = balance;
    totalInterest = totalAmount - totalInvested;
  }

  return { totalAmount, totalInterest, totalInvested, schedule };
}
