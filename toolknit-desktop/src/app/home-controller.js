import { createLifecycleScope } from './tool-lifecycle.js';

/** Owns the home shell, category navigation and legacy category search. */
export function createHomeController({
  root = document,
  transitionMask = root.getElementById?.('transitionMask'),
  appRoot = root.querySelector?.('.app'),
  mainContent = root.querySelector?.('.main-content'),
  onOpenTool,
  isTauri = false,
  appWindow = null,
  isScreenPickerWindow = false,
  handleWindowControlAction,
  syncCustomBackground = () => {},
  translate = key => key
} = {}) {
  const scope = createLifecycleScope();
  const view = root.defaultView || globalThis.window;
  let switching = false;
  let bound = false;

  const syncHomeBackground = () => {
    if (!appRoot?.classList.contains('is-v2-home') || root.body?.classList.contains('update-preview-open')) return;
    syncCustomBackground();
  };
  const syncHomeShell = category => {
    const isHome = category === 'home';
    appRoot?.classList.toggle('is-v2-home', isHome);
    root.body?.classList.toggle('v2-home-active', isHome);
    syncCustomBackground();
    syncHomeBackground();
  };

  function switchCategory(category) {
    if (switching) return;
    switching = true;
    const navItems = root.querySelectorAll('.nav-item');
    const contentSections = root.querySelectorAll('.content-section');
    navItems.forEach(item => item.classList.toggle('active', item.dataset.category === category));
    contentSections.forEach(section => section.classList.remove('active', 'section-entering'));
    const escapedCategory = globalThis.CSS?.escape?.(category) || String(category).replace(/"/g, '\\"');
    const targetSection = root.querySelector(`.content-section[data-category="${escapedCategory}"]`);
    if (targetSection) {
      targetSection.classList.add('active');
      if (mainContent) mainContent.scrollTop = 0;
      void targetSection.offsetWidth;
      targetSection.classList.add('section-entering');
      const clearEnteringState = event => {
        if (event.target !== targetSection || event.animationName !== 'sectionMicroEnter') return;
        targetSection.classList.remove('section-entering');
        targetSection.removeEventListener('animationend', clearEnteringState);
      };
      scope.event(targetSection, 'animationend', clearEnteringState, { once: true });
    }
    syncHomeShell(category);
    switching = false;
  }

  const launchTool = toolId => onOpenTool?.(toolId);

  function installCardInteractions() {
    root.querySelectorAll('.tool-card').forEach(card => {
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      const toolName = card.querySelector('.tool-name');
      if (toolName) card.setAttribute('aria-label', toolName.textContent || translate('common.tool'));
      scope.event(card, 'mousemove', event => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--mouse-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
        card.style.setProperty('--mouse-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
      });
      scope.event(card, 'keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        card.click();
      });
    });
    root.querySelectorAll('.audio-list-item').forEach(item => {
      scope.event(item, 'mousemove', event => {
        const rect = item.getBoundingClientRect();
        item.style.setProperty('--mouse-x', `${((event.clientX - rect.left) / rect.width) * 100}%`);
        item.style.setProperty('--mouse-y', `${((event.clientY - rect.top) / rect.height) * 100}%`);
      });
      scope.event(item, 'keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        item.click();
      });
    });
  }

  function installSearch() {
    const searchInput = root.getElementById?.('audioSearchInput');
    const searchButton = root.getElementById?.('audioSearchBtn');
    const clearButton = root.getElementById?.('audioClearBtn');
    const footer = root.getElementById?.('audioSearchFooter');
    let busy = false;
    const setMask = visible => transitionMask?.classList.toggle('visible', visible);
    const clear = () => {
      if (busy) return;
      busy = true;
      setMask(true);
      scope.timeout(() => {
        root.querySelectorAll('.audio-list-item').forEach(item => { item.style.display = ''; });
        if (searchInput) { searchInput.value = ''; searchInput.style.display = ''; }
        if (searchButton) searchButton.style.display = '';
        if (clearButton) clearButton.style.display = 'none';
        if (footer) footer.style.display = 'none';
        setMask(false);
        busy = false;
      }, 1000);
    };
    const search = () => {
      if (busy || !searchInput) return;
      busy = true;
      setMask(true);
      scope.timeout(() => {
        const query = searchInput.value.trim().toLowerCase();
        root.querySelectorAll('.audio-list-item').forEach(item => { item.style.display = item.textContent.toLowerCase().includes(query) ? '' : 'none'; });
        searchInput.style.display = 'none';
        if (searchButton) searchButton.style.display = 'none';
        if (clearButton) clearButton.style.display = 'block';
        if (footer) footer.style.display = 'flex';
        setMask(false);
        busy = false;
      }, 1000);
    };
    if (searchButton) scope.event(searchButton, 'click', search);
    if (searchInput) scope.event(searchInput, 'keydown', event => { if (event.key === 'Enter') search(); });
    if (clearButton) scope.event(clearButton, 'click', clear);

    root.querySelectorAll('.content-section').forEach(section => {
      if (section.dataset.category === 'audio') return;
      const input = section.querySelector('.tools-search-input');
      const button = section.querySelector('.tools-search-btn');
      const clear = section.querySelector('.tools-clear-btn');
      if (!input || !button) return;
      let sectionBusy = false;
      const reset = () => {
        if (sectionBusy) return;
        sectionBusy = true;
        setMask(true);
        scope.timeout(() => {
          section.querySelectorAll('.audio-list-item').forEach(item => { item.style.display = ''; });
          input.value = ''; input.style.display = ''; button.style.display = '';
          if (clear) clear.style.display = 'none';
          setMask(false); sectionBusy = false;
        }, 1000);
      };
      const run = () => {
        if (sectionBusy || !input.value.trim()) return;
        sectionBusy = true; setMask(true);
        scope.timeout(() => {
          const query = input.value.trim().toLowerCase();
          section.querySelectorAll('.audio-list-item').forEach(item => { item.style.display = item.textContent.toLowerCase().includes(query) ? '' : 'none'; });
          input.style.display = 'none'; button.style.display = 'none';
          if (clear) clear.style.display = 'block';
          setMask(false); sectionBusy = false;
        }, 1000);
      };
      scope.event(button, 'click', run);
      scope.event(input, 'keydown', event => { if (event.key === 'Enter') run(); });
      if (clear) scope.event(clear, 'click', reset);
    });
  }

  function bind() {
    if (bound || scope.disposed) return;
    bound = true;
    installCardInteractions();
    installSearch();
    syncHomeShell(root.querySelector('.content-section.active')?.dataset.category || 'home');
    root.querySelectorAll('.nav-item').forEach(item => scope.event(item, 'click', () => {
      if (item.dataset.category && !item.classList.contains('active')) switchCategory(item.dataset.category);
    }));
    root.querySelectorAll('[data-home-return]').forEach(button => scope.event(button, 'click', () => switchCategory('home')));
    if (isTauri && appWindow && !isScreenPickerWindow) {
      root.querySelectorAll('.ctrl-btn[data-action]').forEach(button => {
        scope.event(button, 'pointerdown', event => event.stopPropagation(), { capture: true });
        scope.event(button, 'mousedown', event => event.stopPropagation(), { capture: true });
        scope.event(button, 'click', event => {
          event.preventDefault(); event.stopPropagation();
          void handleWindowControlAction?.(button.dataset.action);
        });
      });
    }
    if (view?.addEventListener) scope.event(view, 'pagehide', () => scope.dispose(), { once: true });
  }

  const filter = query => {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    root.querySelectorAll('[data-tool]').forEach(card => {
      const haystack = `${card.textContent || ''} ${card.getAttribute('data-tool') || ''}`.toLocaleLowerCase();
      card.hidden = Boolean(normalized) && !haystack.includes(normalized);
    });
  };
  return Object.freeze({ bind, dispose: scope.dispose, filter, open: launchTool, launchTool, switchCategory, syncHomeBackground, syncHomeShell });
}
