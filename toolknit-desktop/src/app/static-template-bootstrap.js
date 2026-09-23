import donationTemplate from './templates/donation.html?raw';
import updatePreviewTemplate from './templates/update-preview.html?raw';
import settingsTemplate from './templates/settings.html?raw';
import helpTemplate from './templates/help.html?raw';
import legalTemplate from './templates/legal.html?raw';
import feedbackTemplate from './templates/feedback.html?raw';
import aiKeyTemplate from './templates/ai-key.html?raw';
import dependencyManagersTemplate from './templates/dependency-managers.html?raw';
import globalDialogsTemplate from './templates/global-dialogs.html?raw';
import { mountTrustedTemplate } from './trusted-template-runtime.js';

const STATIC_TEMPLATE_SPECS = Object.freeze([
  Object.freeze({
    name: 'donation',
    markup: donationTemplate,
    rootSelector: '#donationOverlay'
  }),
  Object.freeze({
    name: 'update-preview',
    markup: updatePreviewTemplate,
    rootSelector: '#updatePreviewOverlay'
  }),
  Object.freeze({
    name: 'settings',
    markup: settingsTemplate,
    rootSelector: '#settingsOverlay'
  }),
  Object.freeze({
    name: 'help',
    markup: helpTemplate,
    rootSelector: '#helpOverlay'
  }),
  Object.freeze({
    name: 'legal',
    markup: legalTemplate,
    rootSelector: '#legalOverlay'
  }),
  Object.freeze({
    name: 'feedback',
    markup: feedbackTemplate,
    rootSelector: '#feedbackOverlay'
  }),
  Object.freeze({
    name: 'ai-key',
    markup: aiKeyTemplate,
    rootSelector: '#apiKeyOverlay'
  }),
  Object.freeze({
    name: 'dependency-managers',
    markup: dependencyManagersTemplate,
    rootSelector: '#transcriptionModelOverlay'
  }),
  Object.freeze({
    name: 'global-dialogs',
    markup: globalDialogsTemplate,
    rootSelector: '#dependencyGateOverlay'
  })
]);

function mountTemplate({ markup, rootSelector }, host = document.body) {
  if (!host || typeof markup !== 'string') return null;
  const existing = rootSelector ? document.querySelector(rootSelector) : null;
  if (existing) return existing;

  mountTrustedTemplate(markup, { root: document, host });
  return rootSelector ? document.querySelector(rootSelector) : null;
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
