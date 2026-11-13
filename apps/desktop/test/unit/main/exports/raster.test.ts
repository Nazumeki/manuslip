import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { captureRaster } from '../../../../src/main/exports/raster'

function fixture() {
  let bounds = { width: 1024, height: 512 }
  const geometry = { width: 1024, height: 1200.2, scale: 1 }
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 1024, height: 1201 }),
    toPNG: vi.fn(() => Buffer.from('png')),
    toJPEG: vi.fn(() => Buffer.from('jpeg')),
  }
  const executeJavaScript = vi.fn(async (script: string) =>
    script.includes('devicePixelRatio') ? geometry : undefined,
  )
  const capturePage = vi.fn(async () => image)
  const setContentSize = vi.fn((width: number, height: number) => {
    bounds = { width, height }
  })
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => bounds,
    setContentSize,
    webContents: {
      isDestroyed: () => false,
      setZoomFactor: vi.fn(),
      executeJavaScript,
      capturePage,
    },
  } as unknown as BrowserWindow
  return { window, image, geometry, executeJavaScript, capturePage, setContentSize }
}
it.each(['png', 'jpeg'] as const)(
  'captures complete admitted geometry and encodes %s without showing the window',
  async (format) => {
    const value = fixture()
    expect(await captureRaster(value.window, format, new AbortController().signal)).toEqual(
      Buffer.from(format),
    )
    expect(value.setContentSize).toHaveBeenCalledExactlyOnceWith(1024, 1201)
    expect(value.capturePage).toHaveBeenCalledExactlyOnceWith(
      { x: 0, y: 0, width: 1024, height: 1201 },
      { stayHidden: true, stayAwake: true },
    )
    if (format === 'jpeg') expect(value.image.toJPEG).toHaveBeenCalledExactlyOnceWith(92)
    else expect(value.image.toJPEG).not.toHaveBeenCalled()
  },
)
it.each([{ width: 2000 }, { height: 8193 }, { height: 5000, scale: 2 }, { height: NaN }])(
  'rejects over-cap/overflow geometry before native resize or bitmap allocation: %j',
  async (patch) => {
    const value = fixture()
    Object.assign(value.geometry, patch)
    await expect(
      captureRaster(value.window, 'png', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'export-image-limit' })
    expect(value.setContentSize).not.toHaveBeenCalled()
    expect(value.capturePage).not.toHaveBeenCalled()
  },
)
it('rejects unstable native sizing instead of silently cropping the content', async () => {
  const value = fixture()
  value.setContentSize.mockImplementation(() => {})
  await expect(
    captureRaster(value.window, 'png', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'export-image-limit' })
  expect(value.setContentSize).toHaveBeenCalledTimes(2)
  expect(value.capturePage).not.toHaveBeenCalled()
})
it('rechecks cancellation after layout and never captures or encodes a late job', async () => {
  const value = fixture(),
    controller = new AbortController()
  value.executeJavaScript.mockImplementation(async () => {
    controller.abort(new Error('cancelled'))
    return undefined
  })
  await expect(captureRaster(value.window, 'png', controller.signal)).rejects.toThrow('cancelled')
  expect(value.capturePage).not.toHaveBeenCalled()
  expect(value.image.toPNG).not.toHaveBeenCalled()
})
it('checks actual native image geometry before encoding', async () => {
  const value = fixture()
  value.image.getSize = () => ({ width: 8193, height: 1201 })
  await expect(
    captureRaster(value.window, 'png', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'export-image-limit' })
  expect(value.image.toPNG).not.toHaveBeenCalled()
})
it.each([
  { width: 1008, height: 1201 },
  { width: 1024, height: 1190 },
])(
  'rejects a clipped native bitmap instead of exporting incomplete content: %j',
  async (dimensions) => {
    const value = fixture()
    value.image.getSize = () => dimensions
    await expect(
      captureRaster(value.window, 'png', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'export-render' })
    expect(value.image.toPNG).not.toHaveBeenCalled()
  },
)
