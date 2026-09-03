import donationTemplate from './templates/donation.html?raw';

const STATIC_TEMPLATE_SPECS = Object.freeze([
  Object.freeze({
    name: 'donation',
    markup: donationTemplate,
    rootSelector: '#donationOverlay'
  })
]);

function mountTemplate({ markup, rootSelector }, host = document.body) {
  if (!host || typeof markup !== 'string') return null;
  const existing = rootSelector ? document.querySelector(rootSelector) : null;
  if (existing) return existing;

  // These files are trusted, versioned application templates bundled by Vite.
  const template = document.createElement('template');
  template.innerHTML = markup;
  const fragment = template.content.cloneNode(true);
  host.append(fragment);
  return rootSelector ? document.querySelector(rootSelector) : fragment;
}

export function bootstrapStaticTemplates(host = document.body) {
  if (!host) return [];
  return STATIC_TEMPLATE_SPECS
    .map(spec => mountTemplate(spec, host))
    .filter(Boolean);
}

// main.js is loaded at the end of body, so synchronous mounting avoids a
// race with application initialization and keeps all template DOM contracts.
if (typeof document !== 'undefined' && document.body) bootstrapStaticTemplates();

