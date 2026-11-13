const { app, BrowserWindow } = require('electron')

app.setPath('userData', process.env.MANUSLIP_WIDGET_TEST_PROFILE)
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  await window.loadURL(process.env.MANUSLIP_WIDGET_TEST_URL)
  app.focus({ steal: true })
  window.focus()
})
app.on('window-all-closed', () => app.quit())
