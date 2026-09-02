export const IMAGE_CROP_MIN_SIZE = 8;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

export function normalizeRotation(value) {
  const rotation = Math.round(finite(value) / 90) * 90;
  return ((rotation % 360) + 360) % 360;
}

export function transformedImageSize(width, height, rotation = 0) {
  const normalized = normalizeRotation(rotation);
  return normalized === 90 || normalized === 270
    ? { width: finite(height), height: finite(width) }
    : { width: finite(width), height: finite(height) };
}

export function normalizeCropRect(rect, bounds, minSize = IMAGE_CROP_MIN_SIZE) {
  const widthLimit = Math.max(1, finite(bounds?.width, 1));
  const heightLimit = Math.max(1, finite(bounds?.height, 1));
  const minWidth = Math.min(widthLimit, Math.max(1, finite(minSize, IMAGE_CROP_MIN_SIZE)));
  const minHeight = Math.min(heightLimit, Math.max(1, finite(minSize, IMAGE_CROP_MIN_SIZE)));
  const width = clamp(rect?.width, minWidth, widthLimit);
  const height = clamp(rect?.height, minHeight, heightLimit);
  return {
    x: clamp(rect?.x, 0, widthLimit - width),
    y: clamp(rect?.y, 0, heightLimit - height),
    width,
    height
  };
}

export function fitCropToRatio(bounds, ratio = null, coverage = 0.86) {
  const widthLimit = Math.max(1, finite(bounds?.width, 1));
  const heightLimit = Math.max(1, finite(bounds?.height, 1));
  const safeCoverage = clamp(coverage, 0.05, 1);
  let width = widthLimit * safeCoverage;
  let height = heightLimit * safeCoverage;
  const targetRatio = finite(ratio, 0);
  if (targetRatio > 0) {
    if (width / height > targetRatio) width = height * targetRatio;
    else height = width / targetRatio;
  }
  return normalizeCropRect({
    x: (widthLimit - width) / 2,
    y: (heightLimit - height) / 2,
    width,
    height
  }, bounds, 1);
}

export function constrainCropToRatio(rect, bounds, ratio) {
  const current = normalizeCropRect(rect, bounds, 1);
  const targetRatio = finite(ratio, 0);
  if (targetRatio <= 0) return current;
  const area = current.width * current.height;
  let width = Math.sqrt(area * targetRatio);
  let height = width / targetRatio;
  const scale = Math.min(1, bounds.width / width, bounds.height / height);
  width *= scale;
  height *= scale;
  return normalizeCropRect({
    x: current.x + current.width / 2 - width / 2,
    y: current.y + current.height / 2 - height / 2,
    width,
    height
  }, bounds, 1);
}

export function moveCropRect(rect, deltaX, deltaY, bounds) {
  const normalized = normalizeCropRect(rect, bounds);
  return {
    ...normalized,
    x: clamp(normalized.x + finite(deltaX), 0, bounds.width - normalized.width),
    y: clamp(normalized.y + finite(deltaY), 0, bounds.height - normalized.height)
  };
}

export function resizeCropRect(rect, handle, deltaX, deltaY, bounds, ratio = null, minSize = IMAGE_CROP_MIN_SIZE) {
  const current = normalizeCropRect(rect, bounds, minSize);
  const hasWest = handle.includes('w');
  const hasEast = handle.includes('e');
  const hasNorth = handle.includes('n');
  const hasSouth = handle.includes('s');
  const anchorX = hasWest ? current.x + current.width : current.x;
  const anchorY = hasNorth ? current.y + current.height : current.y;
  let movingX = hasWest ? current.x + finite(deltaX) : hasEast ? current.x + current.width + finite(deltaX) : current.x + current.width;
  let movingY = hasNorth ? current.y + finite(deltaY) : hasSouth ? current.y + current.height + finite(deltaY) : current.y + current.height;

  if (!hasWest && !hasEast) movingX = current.x + current.width;
  if (!hasNorth && !hasSouth) movingY = current.y + current.height;

  let width = Math.max(minSize, Math.abs(movingX - anchorX));
  let height = Math.max(minSize, Math.abs(movingY - anchorY));
  const targetRatio = finite(ratio, 0);
  if (targetRatio > 0) {
    if (hasWest || hasEast) height = width / targetRatio;
    else width = height * targetRatio;
  }

  const maxWidth = hasWest ? anchorX : bounds.width - anchorX;
  const maxHeight = hasNorth ? anchorY : bounds.height - anchorY;
  if (targetRatio > 0) {
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    width *= scale;
    height *= scale;
  } else {
    width = Math.min(width, maxWidth);
    height = Math.min(height, maxHeight);
  }

  return normalizeCropRect({
    x: hasWest ? anchorX - width : anchorX,
    y: hasNorth ? anchorY - height : anchorY,
    width,
    height
  }, bounds, Math.min(minSize, width, height));
}

export function rotateCropRect(rect, sourceSize, direction = 90) {
  const current = normalizeCropRect(rect, sourceSize, 1);
  const rotation = normalizeRotation(direction);
  if (rotation === 90) {
    return {
      rect: { x: sourceSize.height - current.y - current.height, y: current.x, width: current.height, height: current.width },
      size: { width: sourceSize.height, height: sourceSize.width }
    };
  }
  if (rotation === 180) {
    return {
      rect: { x: sourceSize.width - current.x - current.width, y: sourceSize.height - current.y - current.height, width: current.width, height: current.height },
      size: { ...sourceSize }
    };
  }
  if (rotation === 270) {
    return {
      rect: { x: current.y, y: sourceSize.width - current.x - current.width, width: current.height, height: current.width },
      size: { width: sourceSize.height, height: sourceSize.width }
    };
  }
  return { rect: current, size: { ...sourceSize } };
}

export function flipCropRect(rect, bounds, axis) {
  const current = normalizeCropRect(rect, bounds, 1);
  if (axis === 'horizontal') return { ...current, x: bounds.width - current.x - current.width };
  if (axis === 'vertical') return { ...current, y: bounds.height - current.y - current.height };
  return current;
}

export function sourceRectToDisplay(rect, imageDisplayRect, imageSize) {
  const scaleX = imageDisplayRect.width / imageSize.width;
  const scaleY = imageDisplayRect.height / imageSize.height;
  return {
    x: imageDisplayRect.x + rect.x * scaleX,
    y: imageDisplayRect.y + rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY
  };
}

export function displayPointToSource(point, imageDisplayRect, imageSize) {
  return {
    x: clamp((point.x - imageDisplayRect.x) * imageSize.width / imageDisplayRect.width, 0, imageSize.width),
    y: clamp((point.y - imageDisplayRect.y) * imageSize.height / imageDisplayRect.height, 0, imageSize.height)
  };
}

export function snapCropToCenter(rect, bounds, pixelsPerSourceUnit, previous = {}, options = {}) {
  const current = normalizeCropRect(rect, bounds);
  const enterPixels = finite(options.enterPixels, 8);
  const releasePixels = Math.max(enterPixels, finite(options.releasePixels, 14));
  const scale = Math.max(0.000001, finite(pixelsPerSourceUnit, 1));
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  const deltaX = bounds.width / 2 - centerX;
  const deltaY = bounds.height / 2 - centerY;
  const snapX = Math.abs(deltaX * scale) <= (previous.x ? releasePixels : enterPixels);
  const snapY = Math.abs(deltaY * scale) <= (previous.y ? releasePixels : enterPixels);
  return {
    rect: moveCropRect(current, snapX ? deltaX : 0, snapY ? deltaY : 0, bounds),
    snapped: { x: snapX, y: snapY }
  };
}

export function exportCropRect(rect, bounds) {
  const normalized = normalizeCropRect(rect, bounds, 1);
  const left = clamp(Math.round(normalized.x), 0, Math.max(0, Math.floor(bounds.width) - 1));
  const top = clamp(Math.round(normalized.y), 0, Math.max(0, Math.floor(bounds.height) - 1));
  const right = clamp(Math.round(normalized.x + normalized.width), left + 1, Math.floor(bounds.width));
  const bottom = clamp(Math.round(normalized.y + normalized.height), top + 1, Math.floor(bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function cropStatesEqual(left, right, epsilon = 0.001) {
  if (!left || !right) return false;
  const rectKeys = ['x', 'y', 'width', 'height'];
  return left.rotation === right.rotation
    && Boolean(left.flipHorizontal) === Boolean(right.flipHorizontal)
    && Boolean(left.flipVertical) === Boolean(right.flipVertical)
    && rectKeys.every(key => Math.abs(finite(left.rect?.[key]) - finite(right.rect?.[key])) <= epsilon);
}
