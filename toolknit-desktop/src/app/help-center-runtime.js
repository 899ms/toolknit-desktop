import { createLifecycleScope } from './tool-lifecycle.js';
import { moveFocusOutOfHiddenRegion } from '../shared/tool-page-shell.js';

/** Owns help, feedback and legal overlays without coupling them to app startup. */
export function createHelpCenterRuntime({
  root = globalThis.document,
  windowRef = globalThis.window,
  translate: t = key => key,
  getLanguage = () => 'zh',
  onLangChange = () => () => {},
  getHelpContent = () => ({}),
  getLegalContent = () => ({}),
  escapeHtml = value => String(value ?? ''),
  initLightRays,
  getTheme = () => 'dark',
  onThemeChange = () => () => {},
  settingsOverlay,
  settingsContent,
  pageTransition = null,
  syncCustomBackgroundPreviewPlayback = () => {}
} = {}) {
  const scope = createLifecycleScope();
  const byId = id => root?.getElementById?.(id) || null;
  const on = (target, type, listener, options) => target?.addEventListener
    ? scope.event(target, type, listener, options)
    : () => {};

  const helpOverlay = byId('helpOverlay');
  const helpBackBtn = byId('helpBackBtn');
  const helpNav = byId('helpNav');
  const helpContentBody = byId('helpContentBody');
  const helpContentTitle = byId('helpContentTitle');
  const helpSearchInput = byId('helpSearchInput');
  const helpLinks = [byId('helpBtn'), byId('helpLink')].filter(Boolean);
  const feedbackLink = byId('feedbackLink');
  const declarationLink = byId('declarationLink');
  const usagePolicyLink = byId('usagePolicyLink');
  const feedbackOverlay = byId('feedbackOverlay');
  const feedbackBack = byId('feedbackBack');
  const feedbackSettings = byId('feedbackV2Settings');
  const feedbackBtn = byId('feedbackBtn');
  const lightraysBg = byId('lightraysBg');
  const legalOverlay = byId('legalOverlay');
  const legalBackBtn = byId('legalBackBtn');
  const legalNav = byId('legalNav');
  const legalContentTitle = byId('legalContentTitle');
  const legalContentBody = byId('legalContentBody');
  const marqueeTrack = byId('marqueeTrack');

  let helpSearchCache = null;
  let lightraysInstance = null;

  const runTransition = action => pageTransition?.run
    ? pageTransition.run(action)
    : Promise.resolve().then(action);

  function closeSettingsForHelp() {
    if (!settingsOverlay?.classList.contains('visible')) return;
    moveFocusOutOfHiddenRegion(settingsOverlay);
    settingsOverlay.classList.remove('visible');
    settingsOverlay.style.zIndex = '';
    syncCustomBackgroundPreviewPlayback();
  }

  function closeHelpOverlay() {
    return runTransition(() => {
      if (!helpOverlay) return;
      moveFocusOutOfHiddenRegion(helpOverlay);
      helpOverlay.classList.remove('visible');
      if (helpSearchInput) helpSearchInput.value = '';
      helpNav?.querySelectorAll('.help-nav-item').forEach(item => { item.style.display = ''; });
      helpNav?.querySelectorAll('.help-nav-group').forEach(group => { group.style.display = ''; });
    });
  }

  function buildHelpSearchCache() {
    const content = getHelpContent();
    if (helpSearchCache || !content) return;
    helpSearchCache = {};
    for (const key in content) {
      const entry = content[key];
      helpSearchCache[key] = `${entry.title} ${entry.html}`.toLowerCase();
    }
  }

  function showHelpSection(sectionId) {
    const content = getHelpContent();
    if (!content || !content[sectionId]) return;
    const data = content[sectionId];
    if (helpContentTitle) helpContentTitle.textContent = data.title;
    if (helpContentBody) {
      helpContentBody.innerHTML = data.html;
      helpContentBody.scrollTop = 0;
    }
    if (helpSearchInput) helpSearchInput.value = '';
    helpNav?.querySelectorAll('.help-nav-item').forEach(item => {
      item.style.display = '';
      item.classList.toggle('active', item.dataset.helpSection === sectionId);
    });
    helpNav?.querySelectorAll('.help-nav-group').forEach(group => { group.style.display = ''; });
  }

  function openHelpOverlay(sectionId = 'overview') {
    return runTransition(() => {
      if (!helpOverlay) return;
      closeSettingsForHelp();
      helpOverlay.classList.add('visible');
      showHelpSection(sectionId || 'overview');
    });
  }

  function syncFeedbackBackground() {
    if (getTheme() === 'light' || !feedbackOverlay?.classList.contains('visible')) {
      lightraysInstance?.destroy?.();
      lightraysInstance = null;
      return;
    }
    if (lightraysBg && !lightraysInstance && typeof initLightRays === 'function') {
      lightraysInstance = initLightRays(lightraysBg, {
        raysOrigin: 'top-center', raysColor: '#ffffff', raysSpeed: 0.6,
        lightSpread: 0.6, rayLength: 3, followMouse: true, mouseInfluence: 0.1,
        noiseAmount: 0, distortion: 0, pulsating: false, fadeDistance: 1, saturation: 1
      });
    }
  }
  scope.use(onThemeChange(syncFeedbackBackground));

  function openFeedbackOverlay() {
    return runTransition(() => {
      if (!feedbackOverlay) return;
      feedbackOverlay.classList.add('visible');
      syncFeedbackBackground();
    });
  }

  function closeFeedbackOverlay() {
    return runTransition(() => {
      moveFocusOutOfHiddenRegion(feedbackOverlay);
      feedbackOverlay?.classList.remove('visible');
      lightraysInstance?.destroy?.();
      lightraysInstance = null;
    });
  }

  function getReviewers() {
    return [
      ['Sarah', 'home.feedbackPage.review1'], ['Michael', 'home.feedbackPage.review2'],
      ['Emily', 'home.feedbackPage.review3'], ['David', 'home.feedbackPage.review4'],
      ['Jessica', 'home.feedbackPage.review5'], ['James', 'home.feedbackPage.review6'],
      ['Olivia', 'home.feedbackPage.review7'], ['Christopher', 'home.feedbackPage.review8'],
      ['Amanda', 'home.feedbackPage.review9'], ['Matthew', 'home.feedbackPage.review10'],
      ['Elizabeth', 'home.feedbackPage.review11'], ['Daniel', 'home.feedbackPage.review12']
    ].map(([name, key]) => ({ name, text: t(key) }));
  }

  function renderReviews() {
    if (!marqueeTrack) return;
    const stars = Array.from({ length: 5 }, () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>').join('');
    const palettes = [
      ['#667eea', '#764ba2'], ['#f093fb', '#f5576c'], ['#4facfe', '#00f2fe'],
      ['#43e97b', '#38f9d7'], ['#fa709a', '#fee140'], ['#30cfd0', '#330867'],
      ['#a8edea', '#fed6e3'], ['#ff9a9e', '#fecfef'], ['#ffecd2', '#fcb69f'],
      ['#a18cd1', '#fbc2eb'], ['#fbc2eb', '#a6c1ee'], ['#84fab0', '#8fd3f4']
    ];
    const cards = getReviewers().map((reviewer, index) => {
      const initial = reviewer.name.charAt(0).toUpperCase();
      const [c1, c2] = palettes[index % palettes.length];
      const avatar = `<div class="marquee-avatar" style="background:var(--feedback-avatar-bg,linear-gradient(135deg,${c1},${c2}));display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#fff;flex-shrink:0;">${escapeHtml(initial)}</div>`;
      return `<div class="marquee-card"><div class="marquee-card-header">${avatar}<div class="marquee-info"><div class="marquee-name">${escapeHtml(reviewer.name)}</div><div class="marquee-stars">${stars}</div></div></div><p class="marquee-text">${escapeHtml(reviewer.text)}</p></div>`;
    }).join('');
    marqueeTrack.innerHTML = cards + cards;
  }

  function showLegalSection(sectionId) {
    const content = getLegalContent();
    if (!content || !content[sectionId]) return;
    const data = content[sectionId];
    if (legalContentTitle) legalContentTitle.textContent = data.title;
    if (legalContentBody) {
      legalContentBody.innerHTML = data.html;
      legalContentBody.scrollTop = 0;
    }
    legalNav?.querySelectorAll('.help-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.legalSection === sectionId);
    });
  }

  function openLegalOverlay(sectionId = 'declaration') {
    return runTransition(() => {
      legalOverlay?.classList.add('visible');
      showLegalSection(sectionId);
    });
  }

  function closeLegalOverlay() {
    return runTransition(() => {
      moveFocusOutOfHiddenRegion(legalOverlay);
      legalOverlay?.classList.remove('visible');
    });
  }

  helpLinks.forEach(button => on(button, 'click', event => {
    event.preventDefault();
    openHelpOverlay(button.id === 'helpBtn' ? 'overview' : undefined);
  }));
  on(helpBackBtn, 'click', closeHelpOverlay);
  on(helpNav, 'click', event => {
    const item = event.target.closest('.help-nav-item');
    if (item?.dataset.helpSection) showHelpSection(item.dataset.helpSection);
  });
  on(helpContentBody, 'click', async event => {
    const button = event.target.closest('.help-prompt-copy');
    const prompt = button?.dataset.copyPrompt || '';
    if (!button || !prompt) return;
    const originalLabel = button.textContent;
    try {
      await windowRef?.navigator?.clipboard?.writeText?.(prompt);
      button.textContent = getLanguage() === 'zh' ? '已复制' : 'Copied';
      button.classList.add('is-copied');
      windowRef?.setTimeout?.(() => { button.textContent = originalLabel; button.classList.remove('is-copied'); }, 1600);
    } catch (error) {
      console.error('Could not copy Agent prompt:', error);
    }
  });
  on(helpSearchInput, 'input', () => {
    const query = helpSearchInput.value.trim().toLowerCase();
    if (!helpNav) return;
    if (!query) {
      helpNav.querySelectorAll('.help-nav-item').forEach(item => { item.style.display = ''; });
      helpNav.querySelectorAll('.help-nav-group').forEach(group => { group.style.display = ''; });
      const activeItem = helpNav.querySelector('.help-nav-item.active');
      if (activeItem?.dataset.helpSection) showHelpSection(activeItem.dataset.helpSection);
      return;
    }
    buildHelpSearchCache();
    let anyVisible = false;
    helpNav.querySelectorAll('.help-nav-group').forEach(group => {
      let groupHasVisible = false;
      group.querySelectorAll('.help-nav-item').forEach(item => {
        const section = item.dataset.helpSection || '';
        const cached = helpSearchCache?.[section] || '';
        const match = item.textContent.toLowerCase().includes(query) || cached.includes(query);
        item.style.display = match ? '' : 'none';
        if (match) groupHasVisible = true;
      });
      group.style.display = groupHasVisible ? '' : 'none';
      if (groupHasVisible) anyVisible = true;
    });
    if (helpContentBody && !anyVisible) helpContentBody.innerHTML = `<div class="help-search-empty">${escapeHtml(t('help.searchEmpty'))}</div>`;
  });
  on(root, 'keydown', event => {
    if (event.key === 'Escape' && helpOverlay?.classList.contains('visible')) closeHelpOverlay();
  });

  on(feedbackLink, 'click', event => { event.preventDefault(); openFeedbackOverlay(); });
  on(feedbackBtn, 'click', openFeedbackOverlay);
  on(feedbackBack, 'click', closeFeedbackOverlay);
  on(feedbackSettings, 'click', closeFeedbackOverlay);

  on(legalBackBtn, 'click', closeLegalOverlay);
  legalNav?.querySelectorAll('.help-nav-item').forEach(item => on(item, 'click', () => {
    if (item.dataset.legalSection) showLegalSection(item.dataset.legalSection);
  }));
  on(declarationLink, 'click', event => { event.preventDefault(); openLegalOverlay('declaration'); });
  on(usagePolicyLink, 'click', event => { event.preventDefault(); openLegalOverlay('usage-policy'); });

  scope.use(onLangChange(() => {
    helpSearchCache = null;
    const activeHelp = helpNav?.querySelector('.help-nav-item.active');
    if (activeHelp?.dataset.helpSection) showHelpSection(activeHelp.dataset.helpSection);
    const activeLegal = legalNav?.querySelector('.help-nav-item.active');
    if (legalOverlay?.classList.contains('visible')) showLegalSection(activeLegal?.dataset.legalSection || 'declaration');
    renderReviews();
  }));
  renderReviews();

  return Object.freeze({
    closeFeedbackOverlay,
    closeHelpOverlay,
    closeLegalOverlay,
    dispose: () => {
      lightraysInstance?.destroy?.();
      lightraysInstance = null;
      scope.dispose();
    },
    openFeedbackOverlay,
    openHelpOverlay,
    openLegalOverlay,
    showHelpSection,
    showLegalSection
  });
}
