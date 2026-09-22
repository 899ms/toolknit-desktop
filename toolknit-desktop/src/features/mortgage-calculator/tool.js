import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { onLangChange, t } from '../../i18n.js';
import { calculateMortgage, formatMoney, formatWan } from './core.js';
import './mortgage-calculator.css';

export function initMortgageCalculatorTool({
  overlay,
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance
} = {}) {
  if (!overlay) throw new Error('mortgage-calculator:missing-overlay');
  const lifecycle = createLifecycleScope();
  const q = selector => overlay.querySelector(selector);
  const back = q('#mortgageCalcBack');
  const background = q('#mortgageCalcBg');
  const methodTabs = q('#mortgageCalcMethodTabs');
  const calculateButton = q('#mortgageCalcBtn');
  const resultEmpty = q('#mortgageCalcResultEmpty');
  const resultContent = q('#mortgageCalcResultContent');
  const scheduleBody = q('#mortgageCalcScheduleBody');
  let method = 'equalPayment';
  let plasma = null;
  let lastResult = null;

  const input = id => q(`#${id}`);

  function syncSelection() {
    methodTabs?.querySelectorAll('.mortgage-calc-method-tab').forEach(tab => {
      const selected = tab.dataset.method === method;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-pressed', String(selected));
    });
  }

  function renderSchedule(schedule) {
    if (!scheduleBody) return;
    const fragment = document.createDocumentFragment();
    for (const row of schedule) {
      const element = document.createElement('div');
      element.className = 'mortgage-calc-schedule-row';
      for (const value of [row.month, formatMoney(row.principal), formatMoney(row.interest), formatMoney(row.remaining)]) {
        const span = document.createElement('span');
        span.textContent = String(value);
        element.append(span);
      }
      fragment.append(element);
    }
    scheduleBody.replaceChildren(fragment);
  }

  function showEmpty() {
    if (resultEmpty) resultEmpty.style.display = '';
    if (resultContent) resultContent.style.display = 'none';
    lastResult = null;
    scheduleBody?.replaceChildren();
  }

  function renderResult(result = lastResult) {
    if (!result) return showEmpty();
    resultEmpty && (resultEmpty.style.display = 'none');
    resultContent && (resultContent.style.display = '');
    const unit = t('home.mortgageCalc.loanAmountUnit');
    const monthlyValue = q('#mortgageCalcMonthlyValue');
    const monthlyLabel = q('#mortgageCalcMonthlyLabel');
    const monthlyTag = q('#mortgageCalcMonthlyTag');
    const totalValue = q('#mortgageCalcTotalValue');
    const totalTag = q('#mortgageCalcTotalTag');
    const interestValue = q('#mortgageCalcInterestValue');
    const interestTag = q('#mortgageCalcInterestTag');
    const ratioValue = q('#mortgageCalcRatioValue');
    if (monthlyValue) monthlyValue.textContent = result.monthlyDisplay;
    if (monthlyLabel) monthlyLabel.textContent = t('home.mortgageCalc.monthlyPayment');
    if (monthlyTag) monthlyTag.textContent = result.monthlyKind === 'decreasing' ? t('home.mortgageCalc.monthlyDecreasing') : t('home.mortgageCalc.fixedMonthly');
    if (totalValue) totalValue.textContent = formatWan(result.totalPayment / 10000, unit);
    if (totalTag) totalTag.textContent = `${result.months} ${t('home.mortgageCalc.months')}`;
    if (interestValue) interestValue.textContent = formatWan(result.totalInterest / 10000, unit);
    if (interestTag) interestTag.textContent = formatMoney(result.totalInterest);
    if (ratioValue) ratioValue.textContent = `${result.totalPayment > 0 ? (result.totalInterest / result.totalPayment * 100).toFixed(1) : '0'}%`;
    renderSchedule(result.schedule);
  }

  function calculate() {
    const result = calculateMortgage({
      amountWan: input('mortgageCalcAmount')?.value,
      termYears: input('mortgageCalcTerm')?.value,
      annualRate: input('mortgageCalcRate')?.value,
      method
    });
    if (!result) return showEmpty();
    lastResult = result;
    renderResult(result);
  }

  function open() {
    lifecycle.invalidate();
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    if (background && !plasma) plasma = initStandardToolPlasma(background);
    method = 'equalPayment';
    syncSelection();
    const defaults = [['mortgageCalcAmount', '100'], ['mortgageCalcTerm', '30'], ['mortgageCalcRate', '4.2']];
    for (const [id, value] of defaults) {
      const element = input(id);
      if (element && !element.value.trim()) element.value = value;
    }
    showEmpty();
  }

  function close() {
    lifecycle.invalidate();
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    plasma = disposeStandardToolPlasma(plasma);
  }

  lifecycle.event(back, 'click', close);
  lifecycle.event(methodTabs, 'click', event => {
    const tab = event.target.closest('.mortgage-calc-method-tab');
    if (!tab || !methodTabs.contains(tab)) return;
    method = tab.dataset.method || 'equalPayment';
    syncSelection();
  });
  lifecycle.event(calculateButton, 'click', calculate);
  for (const id of ['mortgageCalcAmount', 'mortgageCalcTerm', 'mortgageCalcRate']) {
    lifecycle.event(input(id), 'keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); calculate(); }
    });
  }
  lifecycle.use(onLangChange(() => renderResult()));

  return {
    open,
    close,
    dispose() {
      close();
      lifecycle.dispose();
    }
  };
}
