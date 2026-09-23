import assert from 'node:assert/strict';
import { calculateInterest, formatInterestMoney } from '../src/features/interest-calculator/core.js';

const simple = calculateInterest({ principal: 10000, annualRate: 5, termYears: 10, mode: 'simple' });
assert.ok(simple);
assert.equal(simple.totalAmount, 15000);
assert.equal(simple.schedule.length, 10);
const compound = calculateInterest({ principal: 10000, annualRate: 5, termYears: 10, mode: 'compound', frequency: 'monthly' });
assert.ok(compound);
assert.equal(compound.schedule.length, 120);
assert.ok(compound.totalAmount > simple.totalAmount);
const recurring = calculateInterest({ regularAmount: 1000, annualRate: 5, termYears: 10, mode: 'recurring' });
assert.ok(recurring);
assert.equal(recurring.schedule.length, 120);
assert.equal(recurring.totalInvested, 120000);
assert.equal(calculateInterest({ principal: 0, annualRate: 5, termYears: 10 }), null);
assert.equal(formatInterestMoney(1234.5), '1,234.50');
console.log('Interest calculator core regression checks passed');
