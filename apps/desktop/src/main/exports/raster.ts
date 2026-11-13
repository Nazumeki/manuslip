import { rasterLimits, rasterSize } from '@manuslip/renderer/raster'
import type { BrowserWindow } from 'electron'
import { FileOperationError } from '../files/errors'

const paint = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
const measure = `(() => {
  const article = document.querySelector('#document');
  if (!article) throw new Error('export-render');
  const rect = article.getBoundingClientRect();
  const style = getComputedStyle(article);
  return {
    width: Math.max(innerWidth, document.documentElement.scrollWidth, rect.left + article.scrollWidth),
    height: Math.max(1, rect.bottom + scrollY + (parseFloat(style.marginBottom) || 0)),
    scale: devicePixelRatio
  };
})()`

/** Bounds admission precedes surface resize and capture; no truncation is permitted. */
export async function captureRaster(
  window: BrowserWindow,
  format: 'png' | 'jpeg',
  signal: AbortSignal,
): Promise<Buffer> {
  const contents = window.webContents
  const alive = (): void => {
    signal.throwIfAborted()
    if (window.isDestroyed() || contents.isDestroyed())
      throw new FileOperationError('export-render')
  }
  alive()
  contents.setZoomFactor(1)
  await contents.executeJavaScript(paint)
  alive()
  let size: ReturnType<typeof rasterSize> | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const input: unknown = await contents.executeJavaScript(measure)
    alive()
    if (
      !input ||
      typeof input !== 'object' ||
      !('width' in input) ||
      !('height' in input) ||
      !('scale' in input) ||
      typeof input.width !== 'number' ||
      typeof input.height !== 'number' ||
      typeof input.scale !== 'number'
    )
      throw new FileOperationError('export-render')
    try {
      size = rasterSize(input.width, input.height, input.scale)
    } catch {
      throw new FileOperationError('export-image-limit')
    }
    if (size.width > rasterLimits.width) throw new FileOperationError('export-image-limit')
    const current = window.getContentBounds()
    if (current.width === size.width && current.height === size.height) break
    if (attempt === 2) throw new FileOperationError('export-image-limit')
    window.setContentSize(size.width, size.height)
    await contents.executeJavaScript(paint)
    alive()
  }
  if (!size) throw new FileOperationError('export-render')
  alive()
  const image = await contents.capturePage(
    { x: 0, y: 0, width: size.width, height: size.height },
    { stayHidden: true, stayAwake: true },
  )
  alive()
  if (image.isEmpty()) throw new FileOperationError('export-render')
  const dimensions = image.getSize()
  try {
    rasterSize(dimensions.width, dimensions.height)
  } catch {
    throw new FileOperationError('export-image-limit')
  }
  if (dimensions.width !== size.pixelWidth || dimensions.height !== size.pixelHeight)
    throw new FileOperationError('export-render')
  return format === 'png' ? image.toPNG() : image.toJPEG(rasterLimits.jpegQuality)
}
