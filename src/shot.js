"use strict";

function cropPixels(view, image, selection) {
  const viewWidth = Number(view && view.width);
  const viewHeight = Number(view && view.height);
  const imageWidth = Number(image && image.width);
  const imageHeight = Number(image && image.height);
  if (!(viewWidth > 0) || !(viewHeight > 0) || !(imageWidth > 0) || !(imageHeight > 0)) return null;
  let x = Number(selection && selection.x);
  let y = Number(selection && selection.y);
  let width = Number(selection && selection.width);
  let height = Number(selection && selection.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  if (x + width > viewWidth) width = viewWidth - x;
  if (y + height > viewHeight) height = viewHeight - y;
  if (!(width > 1) || !(height > 1)) return null;
  const scaleX = imageWidth / viewWidth;
  const scaleY = imageHeight / viewHeight;
  const pixelX = Math.max(0, Math.min(imageWidth - 1, Math.round(x * scaleX)));
  const pixelY = Math.max(0, Math.min(imageHeight - 1, Math.round(y * scaleY)));
  let pixelWidth = Math.round(width * scaleX);
  let pixelHeight = Math.round(height * scaleY);
  if (pixelX + pixelWidth > imageWidth) pixelWidth = imageWidth - pixelX;
  if (pixelY + pixelHeight > imageHeight) pixelHeight = imageHeight - pixelY;
  if (pixelWidth < 1 || pixelHeight < 1) return null;
  return { x: pixelX, y: pixelY, width: pixelWidth, height: pixelHeight };
}

module.exports = { cropPixels };
