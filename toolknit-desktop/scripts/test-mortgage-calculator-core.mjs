import assert from 'node:assert/strict';
import { calculateMortgage, formatMoney, formatWan } from '../src/features/mortgage-calculator/core.js';

const equalPayment = calculateMortgage({ amountWan: 100, termYears: 30, annualRate: 4.2, method: 'equalPayment' });
assert.ok(equalPayment);
assert.equal(equalPayment.months, 360);
assert.equal(equalPayment.schedule.length, 360);
assert.ok(equalPayment.totalPayment > equalPayment.principal);
assert.equal(equalPayment.monthlyKind, 'fixed');
const equalPrincipal = calculateMortgage({ amountWan: 100, termYears: 30, annualRate: 4.2, method: 'equalPrincipal' });
assert.ok(equalPrincipal);
assert.equal(equalPrincipal.monthlyKind, 'decreasing');
assert.ok(equalPrincipal.firstMonthly > equalPrincipal.lastMonthly);
assert.equal(calculateMortgage({ amountWan: 0, termYears: 30, annualRate: 4.2 }), null);
assert.equal(formatMoney(1234.5), '1,234.50');
assert.equal(formatWan(10), '10.00 万');
console.log('Mortgage calculator core regression checks passed');
