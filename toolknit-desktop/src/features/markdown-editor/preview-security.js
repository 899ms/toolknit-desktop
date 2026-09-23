export const MARKDOWN_PREVIEW_ASSET_ROOT = 'https://toolknit.local/markdown-asset/';

const SAFE_INLINE_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i;

export function markdownPreviewAssetUrl(id) {
  return `${MARKDOWN_PREVIEW_ASSET_ROOT}${encodeURIComponent(id)}`;
}

export function safeLivePreviewFragment(cleanHtml, assets = [], documentRef = document) {
  const template = documentRef.createElement('template');
  template.innerHTML = cleanHtml;
  const localImages = new Map(
    assets
      .filter(asset => asset?.id && asset?.previewDataUrl)
      .map(asset => [markdownPreviewAssetUrl(asset.id), asset.previewDataUrl])
  );

  template.content.querySelectorAll('img').forEach(image => {
    const source = image.getAttribute('src') || '';
    const localSource = localImages.get(source);
    if (localSource) {
      image.setAttribute('src', localSource);
      return;
    }
    if (SAFE_INLINE_IMAGE_PATTERN.test(source)) return;
    const blocked = documentRef.createElement('span');
    blocked.className = 'md-render-error';
    blocked.textContent = image.getAttribute('alt') || '远程图片预览已阻止';
    image.replaceWith(blocked);
  });

  template.content.querySelectorAll('a').forEach(link => {
    link.removeAttribute('target');
    link.setAttribute('rel', 'noopener noreferrer');
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    try {
      const parsed = new URL(href);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        link.removeAttribute('href');
      } else {
        link.setAttribute('href', parsed.href);
      }
    } catch {
      link.removeAttribute('href');
    }
  });

  return template.content;
}
