export function mountTrustedTemplate(markup, {
  root = globalThis.document,
  host = root?.body
} = {}) {
  if (!root?.createElement || !host?.append || typeof markup !== 'string') return [];
  const template = root.createElement('template');
  template.innerHTML = markup;
  const fragment = template.content.cloneNode(true);
  const mounted = [...fragment.children];
  host.append(fragment);
  return mounted;
}
