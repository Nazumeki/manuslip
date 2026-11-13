import { join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
} from 'electron'
import { assetLimits } from '../shared/asset-contracts'
import {
  type Bootstrap,
  channels,
  parseClipboardAction,
  parseExternalLink,
  parseSettings,
  type Settings,
} from '../shared/contracts'
import { type DocumentCommand, fileChannels } from '../shared/file-contracts'
import { parseAssetUrl } from '../shared/image-contracts'
import { incomingChannels } from '../shared/incoming-contracts'
import { workspaceChannels } from '../shared/workspace-contracts'
import { appEntry, registerAppProtocol } from './app-protocol'
import { registerAssetHandlers } from './assets/ipc'
import { LocalAssets } from './assets/repository'
import { ClipboardConverter } from './clipboard/converter'
import { Diagrams } from './diagrams/ipc'
import { installDocumentShortcuts } from './document-shortcuts'
import { registerExportHandlers } from './exports/ipc'
import { ExportManager } from './exports/manager'
import { registerFileHandlers } from './file-ipc'
import { FileOperationError } from './files/errors'
import { RecoveryRepository } from './files/recovery'
import type { FileSessions } from './files/sessions'
import { registerImageHandlers } from './images/ipc'
import { ImageRepository } from './images/repository'
import { IncomingFiles, launchPaths } from './incoming'
import { registerIncomingHandlers } from './incoming-ipc'
import { createAuthorizedHandler } from './ipc'
import { nativeStrings } from './native-strings'
import { registerPandocHandlers } from './pandoc/ipc'
import { PandocRepository } from './pandoc/repository'
import { PandocTools } from './pandoc/tools'
import { registerPluginHandlers } from './plugins/ipc'
import { PluginRepository } from './plugins/repository'
import { Plugins } from './plugins/service'
import { registerSearchHandlers } from './search/ipc'
import { SearchRepository } from './search/repository'
import { productionCsp } from './security'
import { SettingsRepository } from './settings'
import { configureSpellcheck, installEditingMenu, prepareDictionary } from './spellcheck'
import { registerStyleHandlers } from './styles/ipc'
import { WritingStyleRepository } from './styles/repository'
import { WritingStyles } from './styles/service'
import { registerSyncHandlers } from './sync/ipc'
import type { SyncService } from './sync/service'
import { registerTranslationHandlers } from './translation/ipc'
import type { TranslationService } from './translation/service'
import { registerWorkspaceHandlers } from './workspace/ipc'
import { WorkspaceRepository } from './workspace/repository'
import { WorkspaceStateRepository } from './workspace/state'

// Test and development launches use their own profile, never the real writing profile.
if (!app.isPackaged || process.env.MANUSLIP_TEST_PROFILE) {
  app.setPath(
    'userData',
    resolve(
      process.env.MANUSLIP_TEST_PROFILE || join(app.getPath('appData'), 'Manuslip Development'),
    ),
  )
}

let window: BrowserWindow | null = null
let rendererUrl = ''
let settings: SettingsRepository
let spellcheckAvailable = false
let files: FileSessions
let recovery: RecoveryRepository
let workspaces: WorkspaceRepository
let searches: SearchRepository | undefined
const images = new ImageRepository()
let assets: LocalAssets | undefined
const converter = new ClipboardConverter()
let diagrams: Diagrams | undefined
let exports: ExportManager | undefined
let translations: TranslationService | undefined
let writingStyles: WritingStyles | undefined
let pandocTools: PandocTools | undefined
let plugins: Plugins | undefined
let sync: SyncService | undefined
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'manuslip-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  { scheme: 'manuslip-plugin', privileges: { standard: true, secure: true } },
  { scheme: 'manuslip-asset', privileges: { standard: true, secure: true } },
  {
    scheme: 'manuslip-diagram',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'manuslip-print',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])
let allowClose = false
let quitRequested = false
const incoming = new IncomingFiles(() => {
  if (window && !window.isDestroyed()) window.webContents.send(incomingChannels.changed)
})
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
else {
  incoming.enqueue(launchPaths(process.argv, process.cwd(), Boolean(process.defaultApp)))
  // macOS can deliver open-file before ready; keep paths in main until the renderer is ready.
  app.on('open-file', (event, path) => {
    event.preventDefault()
    incoming.enqueue([path])
    if (app.isReady() && workspaces)
      void focusWindow().catch(() => console.error('Unable to open Manuslip window'))
  })
  app.on('second-instance', (_event, argv, cwd) => {
    incoming.enqueue(launchPaths(argv, cwd, Boolean(process.defaultApp)))
    if (app.isReady() && workspaces)
      void focusWindow().catch(() => console.error('Unable to open Manuslip window'))
  })
}

async function focusWindow(): Promise<void> {
  if (!window) await createWindow()
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
}

function command(value: DocumentCommand): void {
  window?.webContents.send(fileChannels.command, value)
}

function updateMenu(): void {
  const text = nativeStrings(settings.get().locale)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      {
        label: text.file,
        submenu: [
          { label: text.new, accelerator: 'CmdOrCtrl+N', click: () => command('new') },
          { label: text.open, accelerator: 'CmdOrCtrl+O', click: () => command('open') },
          {
            label: text.openFolder,
            accelerator: 'CmdOrCtrl+Alt+O',
            click: () => command('open-folder'),
          },
          { type: 'separator' },
          { label: text.save, accelerator: 'CmdOrCtrl+S', click: () => command('save') },
          { label: text.saveAs, accelerator: 'CmdOrCtrl+Shift+S', click: () => command('save-as') },
          { label: text.copy, click: () => command('save-copy') },
          { label: text.exportHtml, click: () => command('export-html') },
          { label: text.exportPdf, click: () => command('export-pdf') },
          { type: 'separator' },
          {
            label: text.closeDocument,
            accelerator: 'CmdOrCtrl+W',
            click: () => command('close-document'),
          },
          { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
        ],
      },
      { role: 'editMenu', label: settings.get().locale === 'zh-CN' ? '编辑' : 'Edit' },
      {
        label: text.view,
        submenu: [
          {
            label: text.nextDocument,
            accelerator: 'Ctrl+Tab',
            click: () => command('next-document'),
          },
          {
            label: text.previousDocument,
            accelerator: 'Ctrl+Shift+Tab',
            click: () => command('previous-document'),
          },
          { type: 'separator' },
          { label: text.findFile, accelerator: 'CmdOrCtrl+P', click: () => command('find-file') },
          {
            label: text.searchWorkspace,
            accelerator: 'CmdOrCtrl+Shift+F',
            click: () => command('search-workspace'),
          },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
        ],
      },
      { role: 'windowMenu' },
      { role: 'help', submenu: [{ role: 'about' }] },
    ]),
  )
  if (window && process.platform !== 'darwin') {
    window.setAutoHideMenuBar(true)
    window.setMenuBarVisibility(false)
  }
}

function handle<T>(channel: string, operation: (input: unknown) => Promise<T> | T): void {
  ipcMain.handle(
    channel,
    createAuthorizedHandler(
      () =>
        window
          ? {
              sender: window.webContents,
              mainFrame: window.webContents.mainFrame,
              rendererUrl,
            }
          : null,
      operation,
    ),
  )
}

async function createWindow(): Promise<void> {
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  rendererUrl = developmentUrl || appEntry
  const workArea = screen.getPrimaryDisplay().workAreaSize
  window = new BrowserWindow({
    width: Math.min(1360, workArea.width),
    height: Math.min(900, workArea.height),
    minWidth: 360,
    minHeight: 500,
    title: 'Manuslip',
    icon: join(import.meta.dirname, 'icon.png'),
    backgroundColor: '#f7f7f2',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  installDocumentShortcuts(window.webContents, command)
  installEditingMenu(
    window,
    () => settings.get().locale,
    () => Boolean(settings.get().spellcheck) && spellcheckAvailable,
  )
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window?.show())
  const owner = window.webContents.id
  allowClose = false
  window.on('close', (event) => {
    if (!allowClose && files.diagnostics.sessions) {
      event.preventDefault()
      command('close-window')
    }
  })
  window.on('focus', () => {
    void files.checkExternal(owner)
    workspaces.checkExternal(owner)
  })
  window.webContents.on('render-process-gone', () => {
    allowClose = true
  })
  window.on('closed', () => {
    incoming.closeOwner(owner)
    workspaces.closeOwner(owner)
    images.revokeOwner(owner)
    assets?.revokeOwner(owner)
    converter.closeOwner(owner)
    diagrams?.closeOwner(owner)
    exports?.closeOwner(owner)
    translations?.closeOwner(owner)
    writingStyles?.closeOwner(owner)
    pandocTools?.closeOwner(owner)
    plugins?.closeOwner(owner)
    sync?.closeOwner(owner)
    void files.closeOwner(owner)
    window = null
  })
  await window.loadURL(rendererUrl)
}

if (primaryInstance)
  app
    .whenReady()
    .then(async () => {
      registerAppProtocol(protocol, join(import.meta.dirname, '../renderer'))
      settings = new SettingsRepository(join(app.getPath('userData'), 'preferences.json'))
      await settings.load()
      const dictionaries = join(app.getAppPath(), 'vendor', 'dictionaries')
      spellcheckAvailable =
        process.platform === 'darwin' ||
        (await prepareDictionary(dictionaries, app.getPath('sessionData')))
      configureSpellcheck(
        session.defaultSession,
        dictionaries,
        Boolean(settings.get().spellcheck) && spellcheckAvailable,
      )
      recovery = new RecoveryRepository(join(app.getPath('userData'), 'recovery'))
      await recovery.load()
      protocol.handle('manuslip-asset', async (request) => {
        try {
          const url = parseAssetUrl(request.url)
          const owner = window?.webContents.id
          const id = url.slice('manuslip-asset://image/'.length)
          const asset =
            owner !== undefined ? images.get(owner, id) || (await assets?.get(owner, id)) : null
          if (!asset) return new Response(null, { status: 404 })
          return new Response(new Uint8Array(asset.bytes), {
            headers: {
              'Content-Type': asset.mime,
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'no-store',
            },
          })
        } catch {
          return new Response(null, { status: 404 })
        }
      })
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      )
      session.defaultSession.setPermissionCheckHandler(() => false)
      if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) {
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              'Content-Security-Policy': [productionCsp],
            },
          })
        })
      }
      handle<Bootstrap>(channels.bootstrap, (input) => {
        if (input !== null) throw new Error('Expected no input')
        return {
          settings: settings.get(),
          settingsRecovered: settings.recovered,
          settingsReadOnly: settings.readOnly,
          spellcheckAvailable,
          runtime: {
            app: app.getVersion(),
            electron: process.versions.electron,
            node: process.versions.node,
            chrome: process.versions.chrome,
          },
        }
      })
      handle<Settings>(channels.settings, async (input) => {
        const parsed = parseSettings(input)
        const result = await settings.save(parsed)
        session.defaultSession.setSpellCheckerEnabled(
          Boolean(result.spellcheck) && spellcheckAvailable,
        )
        updateMenu()
        return result
      })
      handle<null>(channels.openLink, async (input) => {
        await shell.openExternal(parseExternalLink(input), { activate: true })
        return null
      })
      handle<null>(channels.edit, (input) => {
        const action = parseClipboardAction(input)
        window?.webContents[action]()
        return null
      })
      files = registerFileHandlers(
        handle,
        () => window,
        () => settings.get().locale,
        (proceed) => {
          if (!proceed) {
            quitRequested = false
            return
          }
          allowClose = true
          if (quitRequested) app.quit()
          else window?.close()
        },
        recovery,
        (owner, id) => {
          images.revoke(owner, id)
          assets?.revoke(owner, id)
          converter.closeDocument(owner, id)
          diagrams?.closeDocument(owner, id)
          exports?.closeDocument(owner, id)
          translations?.closeDocument(owner, id)
          writingStyles?.closeDocument(owner, id)
          sync?.closeDocument(owner, id)
        },
      )
      assets = new LocalAssets(files, async () => {
        const items = await clipboard.read()
        const item = items.find((item) => item.types.includes('image/png'))
        if (!item) throw new FileOperationError('asset-capture')
        const image = await item.getType('image/png')
        if (!(image instanceof Blob)) throw new FileOperationError('asset-capture')
        if (image.size > assetLimits.bytes) throw new FileOperationError('asset-large')
        return Buffer.from(await image.arrayBuffer())
      })
      registerAssetHandlers(handle, () => window, files, assets, converter)
      diagrams = new Diagrams(() => window, files)
      diagrams.register(handle)
      const styleRepository = new WritingStyleRepository(
        join(app.getPath('userData'), 'writing-styles.json'),
      )
      await styleRepository.load()
      writingStyles = new WritingStyles(files, styleRepository)
      registerStyleHandlers(
        handle,
        () => window,
        () => settings.get().locale,
        writingStyles,
      )
      const pandocRepository = new PandocRepository(
        join(app.getPath('userData'), 'pandoc-tool.json'),
      )
      await pandocRepository.load()
      pandocTools = new PandocTools(pandocRepository)
      registerPandocHandlers(
        handle,
        () => window,
        () => settings.get().locale,
        pandocTools,
      )
      exports = new ExportManager(files, images, writingStyles, pandocTools)
      const pluginRepository = new PluginRepository(join(app.getPath('userData'), 'plugins.json'))
      await pluginRepository.load()
      plugins = new Plugins(pluginRepository, files)
      registerPluginHandlers(
        handle,
        () => window,
        () => settings.get().locale,
        plugins,
      )
      sync = registerSyncHandlers(
        handle,
        () => window,
        files,
        app.getPath('userData'),
        () => settings.get().locale,
      )
      translations = registerTranslationHandlers(
        handle,
        () => window,
        files,
        app.getPath('userData'),
      )
      registerExportHandlers(handle, () => window, exports)
      registerIncomingHandlers(handle, () => window, incoming, files)
      registerImageHandlers(
        handle,
        () => window,
        () => settings.get().locale,
        files,
        images,
      )
      const workspaceState = new WorkspaceStateRepository(
        join(app.getPath('userData'), 'workspace-state.json'),
      )
      await workspaceState.load()
      workspaces = new WorkspaceRepository(
        workspaceState,
        files,
        (owner) => searches?.closeOwner(owner),
        (owner, change) => {
          if (window && !window.isDestroyed() && window.webContents.id === owner)
            window.webContents.send(workspaceChannels.changed, change)
        },
      )
      searches = new SearchRepository(files)
      registerSearchHandlers(handle, () => window, workspaces, searches, files)
      registerWorkspaceHandlers(
        handle,
        () => window,
        () => settings.get().locale,
        workspaces,
        files,
      )
      updateMenu()
      await createWindow()
      app.on('activate', () => {
        if (!window) void createWindow()
      })
    })
    .catch((error: unknown) => {
      console.error(
        'Unable to start Manuslip:',
        error instanceof Error ? error.message : 'Unknown error',
      )
      app.exit(1)
    })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('will-quit', () => translations?.dispose())

app.on('before-quit', (event) => {
  if (window && !allowClose && files.diagnostics.sessions) {
    event.preventDefault()
    quitRequested = true
    command('close-window')
  }
})
