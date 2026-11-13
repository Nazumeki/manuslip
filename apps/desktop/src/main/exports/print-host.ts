import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  session,
} from 'electron'
import { exportChannels, exportLimits, type PrintPayload } from '../../shared/export-contracts'
import { record } from '../../shared/file-contracts'
import { diagramAssetPath } from '../diagrams/policy'
import { FileOperationError } from '../files/errors'
import { preparePandocHtml } from './pandoc-html'
import { captureRaster } from './raster'

export const printCsp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
export class PrintHost {
  private window: BrowserWindow | null = null
  private cleanup: (() => void) | null = null
  private readonly partition = session.fromPartition(`manuslip-print-${randomUUID()}`, {
    cache: false,
  })
  private readonly url: string
  constructor(private readonly editorProcess: () => number) {
    const dev = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    this.url = dev
      ? `${dev.replace(/\/$/, '')}/print/index.html`
      : 'manuslip-print://render/print/index.html'
    this.partition.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    this.partition.setPermissionCheckHandler(() => false)
    this.partition.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: dev
          ? !details.url.startsWith(`${dev.replace(/\/$/, '')}/`)
          : !this.assetPath(details.url),
      }),
    )
    this.partition.webRequest.onHeadersReceived((details, callback) =>
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [printCsp] },
      }),
    )
    if (!dev)
      this.partition.protocol.handle('manuslip-print', async (request) => {
        const path = this.assetPath(request.url)
        if (!path || request.method !== 'GET') return new Response(null, { status: 404 })
        try {
          return new Response(await readFile(join(import.meta.dirname, '../renderer', path)), {
            headers: {
              'Content-Type': path.endsWith('.html')
                ? 'text/html'
                : extname(path) === '.js'
                  ? 'text/javascript'
                  : extname(path) === '.css'
                    ? 'text/css'
                    : extname(path) === '.woff2'
                      ? 'font/woff2'
                      : 'application/octet-stream',
              'Content-Security-Policy': printCsp,
              'X-Content-Type-Options': 'nosniff',
            },
          })
        } catch {
          return new Response(null, { status: 404 })
        }
      })
  }
  private assetPath(value: string): string | null {
    if (value === 'manuslip-print://render/print/index.html') return 'print/index.html'
    if (!value.startsWith('manuslip-print://render/assets/')) return null
    return diagramAssetPath(value.replace('manuslip-print:', 'manuslip-diagram:'))
  }
  render(payload: PrintPayload, asset: (reference: string) => Promise<string>): Promise<string> {
    const window = new BrowserWindow({
      show: false,
      width: payload.mode === 'presentation' ? 1280 : payload.mode === 'raster' ? 1024 : 643,
      height: payload.mode === 'presentation' ? 800 : payload.mode === 'raster' ? 512 : 1000,
      useContentSize: payload.mode === 'raster',
      // Hidden image surfaces must retain their admitted size on small displays.
      frame: payload.mode !== 'raster',
      enableLargerThanScreen: payload.mode === 'raster',
      title: payload.mode === 'presentation' ? payload.title : 'Manuslip export renderer',
      skipTaskbar: payload.mode !== 'presentation',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/print.cjs'),
        session: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    })
    this.window = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
      this.window === window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame?.url === this.url
    return new Promise((resolve, reject) => {
      let started = false
      const startup = setTimeout(
        () => reject(new FileOperationError('export-timeout')),
        exportLimits.resourceMs,
      )
      const ready = (event: IpcMainEvent): void => {
        if (!trusted(event) || started) return
        started = true
        clearTimeout(startup)
        if (window.webContents.getOSProcessId() === this.editorProcess()) {
          reject(new FileOperationError('export-render'))
          return
        }
        window.webContents.send(exportChannels.job, payload)
      }
      const result = (event: IpcMainEvent, input: unknown): void => {
        if (!trusted(event)) return
        try {
          const value = record(input)
          if (
            value.jobId !== payload.jobId ||
            Object.keys(value).some((key) => !['jobId', 'html', 'error'].includes(key))
          )
            throw new Error('Invalid export host')
          if (
            typeof value.html === 'string' &&
            Buffer.byteLength(value.html) <= exportLimits.output
          )
            resolve(value.html)
          else
            reject(
              new FileOperationError(
                value.error === 'export-asset'
                  ? 'export-asset'
                  : value.error === 'export-limit'
                    ? 'export-limit'
                    : value.error === 'export-timeout'
                      ? 'export-timeout'
                      : value.error === 'presentation-limit'
                        ? 'presentation-limit'
                        : value.error === 'presentation-empty'
                          ? 'presentation-empty'
                          : 'export-render',
              ),
            )
        } catch {
          reject(new FileOperationError('export-render'))
        }
      }
      const gone = (): void => reject(new FileOperationError('export-render'))
      const assetChannel = `${exportChannels.asset}:${payload.jobId}`
      ipcMain.handle(assetChannel, async (event, input) => {
        if (!trusted(event)) throw new Error('Unauthorized export renderer')
        const value = record(input)
        if (
          value.jobId !== payload.jobId ||
          Object.keys(value).some((key) => !['jobId', 'reference'].includes(key)) ||
          typeof value.reference !== 'string' ||
          value.reference.length > exportLimits.html
        )
          throw new Error('Invalid export resource')
        return asset(value.reference)
      })
      ipcMain.on(exportChannels.ready, ready)
      ipcMain.on(exportChannels.result, result)
      window.webContents.once('render-process-gone', gone)
      window.once('closed', gone)
      this.cleanup = () => {
        clearTimeout(startup)
        ipcMain.removeHandler(assetChannel)
        ipcMain.removeListener(exportChannels.ready, ready)
        ipcMain.removeListener(exportChannels.result, result)
        gone()
      }
      void window.loadURL(this.url).catch(gone)
    })
  }
  async present(owner: BrowserWindow): Promise<void> {
    const window = this.window
    if (!window || window.isDestroyed()) throw new FileOperationError('export-render')
    const contents = window.webContents
    await new Promise<void>((resolve, reject) => {
      const gone = (): void => reject(new FileOperationError('export-render'))
      contents.once('render-process-gone', gone)
      window.once('closed', () => {
        contents.removeListener('render-process-gone', gone)
        if (!owner.isDestroyed()) owner.focus()
        resolve()
      })
      window.setParentWindow(owner)
      window.setFullScreen(true)
      window.show()
      window.focus()
    })
  }
  async raster(format: 'png' | 'jpeg', signal: AbortSignal): Promise<Buffer> {
    if (!this.window || this.window.isDestroyed()) throw new FileOperationError('export-render')
    return captureRaster(this.window, format, signal)
  }
  async pandocHtml(signal: AbortSignal): Promise<string> {
    if (!this.window || this.window.isDestroyed()) throw new FileOperationError('export-render')
    return preparePandocHtml(this.window, signal)
  }
  async pdf(): Promise<Buffer> {
    if (!this.window || this.window.isDestroyed()) throw new FileOperationError('export-render')
    return this.window.webContents.printToPDF({
      pageSize: 'A4',
      margins: { top: 20 / 25.4, bottom: 20 / 25.4, left: 20 / 25.4, right: 20 / 25.4 },
      preferCSSPageSize: true,
      printBackground: true,
      pageRanges: `1-${exportLimits.pages + 1}`,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    })
  }
  dispose(): void {
    this.cleanup?.()
    this.cleanup = null
    const window = this.window
    this.window = null
    if (window && !window.isDestroyed()) {
      if (
        window.webContents.getOSProcessId() &&
        window.webContents.getOSProcessId() !== this.editorProcess()
      )
        window.webContents.forcefullyCrashRenderer()
      window.destroy()
    }
    this.partition.webRequest.onBeforeRequest(null)
    this.partition.webRequest.onHeadersReceived(null)
    void this.partition.protocol.unhandle('manuslip-print')
    void this.partition.clearStorageData()
  }
}
