'use strict';
// PokeFarm — processo principal (Mac e Windows)
const { app, BrowserWindow, ipcMain, Notification, powerSaveBlocker, shell, session, Tray, Menu, nativeImage, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createLiveStatusService } = require('./live-status');
const { createReleaseChecker } = require('./release-updates');
const { resolveVersion } = require('./app-version');
const APP_VERSION = resolveVersion({ fallbackVersion: app.getVersion(), isPackaged: app.isPackaged });
const donations = require('./assets/donations/developers.json');

// Todas as lives, chats, jogo e janelas de login usam a mesma sessão: logou uma vez, vale para tudo
const PARTITION = 'persist:pokefarm';

// User-agent de Chrome normal (sem "Electron"), para Twitch/Kick servirem o site padrão
const CHROME_MAJOR = String(process.versions.chrome || '140').split('.')[0];
const OS_UA = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64';
const CHROME_UA = `Mozilla/5.0 (${OS_UA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// Rodar 24h: nada é pausado/desacelerado com janela atrás, minimizada ou tela bloqueada
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.userAgentFallback = CHROME_UA;
app.setName('PokeFarm');
if (process.platform === 'win32') app.setAppUserModelId('com.pokefarm.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let aboutWindow = null;
let summaryWindow = null;
let trayClickTimer = null;
let ignoreTrayClickUntil = 0;
let tray = null;
let quitting = false;
let updateChecker = null;
let updateTimer = null;

function showWindow() {
  if (quitting) return;
  clearTimeout(trayClickTimer);
  summaryWindow?.hide();
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const size = process.platform === 'darwin' ? 18 : 32;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: size, height: size });
  tray = new Tray(icon);
  tray.setToolTip('PokeFarm');
  const menu = Menu.buildFromTemplate([
    { label: 'Sobre', click: showAbout },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray.on('click', () => {
    if (Date.now() < ignoreTrayClickUntil) return;
    clearTimeout(trayClickTimer);
    trayClickTimer = setTimeout(() => {
      if (win && (!win.isVisible() || win.isMinimized())) showSessionSummary();
      else showWindow();
    }, 300);
  });
  tray.on('double-click', () => {
    ignoreTrayClickUntil = Date.now() + 500;
    showWindow();
  });
  // Menu explícito: setContextMenu também capturaria o clique esquerdo no macOS.
  tray.on('right-click', () => {
    clearTimeout(trayClickTimer);
    summaryWindow?.hide();
    tray.popUpContextMenu(menu);
  });
}

function showSessionSummary() {
  if (quitting) return;
  const bounds = tray.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(420, area.width - 16);
  const height = Math.min(680, area.height - 16);
  const x = Math.max(area.x + 8, Math.min(bounds.x + bounds.width - width, area.x + area.width - width - 8));
  const below = bounds.y + bounds.height + 8;
  const y = Math.max(area.y + 8, Math.min(below + height <= area.y + area.height ? below : bounds.y - height - 8, area.y + area.height - height - 8));
  if (!summaryWindow || summaryWindow.isDestroyed()) {
    const panel = new BrowserWindow({
      width, height, x, y, frame: false, show: false, resizable: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#141416',
      webPreferences: { preload: path.join(__dirname, 'session-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    summaryWindow = panel;
    panel.setMenu(null);
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', event => event.preventDefault());
    panel.on('blur', () => panel.hide());
    panel.on('closed', () => { summaryWindow = null; });
    panel.once('ready-to-show', () => {
      if (!quitting && win && (!win.isVisible() || win.isMinimized())) { panel.show(); panel.focus(); }
    });
    panel.loadFile(path.join(__dirname, 'renderer', 'session.html'));
  } else {
    summaryWindow.setBounds({ x, y, width, height });
    summaryWindow.show(); summaryWindow.focus();
  }
}

function showAbout() {
  if (quitting) return;
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    title: 'Sobre o PokeFarm', width: 440, height: 640, useContentSize: true,
    resizable: false, minimizable: false, maximizable: false, show: false,
    backgroundColor: '#141416', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'about-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  aboutWindow = window;
  window.setMenu(null);
  const aboutLinks = new Set([donations.repository, ...donations.developers.flatMap(profile => [profile.github, profile.linkedin])]);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (aboutLinks.has(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => { window.show(); window.focus(); });
  window.on('closed', () => { aboutWindow = null; });
  window.loadFile(path.join(__dirname, 'renderer', 'about.html'), {
    query: { version: APP_VERSION },
  });
}

ipcMain.handle('about-data', event => event.sender === aboutWindow?.webContents ? donations : null);
ipcMain.handle('about-copy-pix', (event, id) => {
  if (event.sender !== aboutWindow?.webContents) return false;
  const profile = donations.developers.find(profile => profile.id === id);
  if (!profile) return false;
  clipboard.writeText(profile.pix);
  return true;
});

function startUpdateChecks() {
  const settingsFile = path.join(app.getPath('userData'), 'update-notifications.json');
  let notifiedVersions = [];
  try { notifiedVersions = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) { /* primeira abertura */ }
  updateChecker = createReleaseChecker({
    currentVersion: APP_VERSION, notifiedVersions,
    persistNotified: versions => fs.writeFileSync(settingsFile, JSON.stringify(versions)),
    onChange: state => {
      if (win && !win.isDestroyed()) win.webContents.send('update-state', state);
    },
    onAvailable: update => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: 'Atualização do PokeFarm',
        body: `A versão ${update.version} está disponível. Clique para ver a release.` });
      notification.on('click', () => { void shell.openExternal(update.url).catch(() => {}); });
      notification.show();
    },
  });
  void updateChecker.check();
  updateTimer = setInterval(() => { void updateChecker.check(); }, 60 * 60 * 1000);
}

const LOGIN_URLS = {
  twitch: 'https://www.twitch.tv/login',
  kick: 'https://kick.com/',
};

// Só abre no Edge endereços destes sites, e só com caracteres seguros
const SAFE_URL = /^https:\/\/([a-z0-9-]+\.)*(kick\.com|twitch\.tv|pokeidle\.io)(\/[A-Za-z0-9_\-/]*)?$/;

// Caminhos da Twitch/Kick que não são canais
const RESERVED = new Set([
  'directory', 'videos', 'settings', 'login', 'signup', 'p', 'downloads', 'jobs', 'subscriptions',
  'inventory', 'wallet', 'drops', 'search', 'friends', 'messages', 'payments', 'prime', 'turbo',
  'store', 'popout', 'embed', 'moderator', 'categories', 'browse', 'following', 'dashboard',
  'terms-of-service', 'privacy-policy', 'community-guidelines', 'about', 'help', 'privacy', 'terms',
]);

/** Se a URL for de um canal da Kick/Twitch, devolve o link limpo (ex.: https://twitch.tv/rodil). */
function channelURL(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  const twitch = host === 'twitch.tv' || host.endsWith('.twitch.tv');
  const kick = host === 'kick.com' || host.endsWith('.kick.com');
  if (!(twitch || kick) || /^(player|dashboard|id)\./.test(host)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 1) return null;
  const name = parts[0].toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(name) || RESERVED.has(name)) return null;
  return `https://${twitch ? 'twitch.tv' : 'kick.com'}/${name}`;
}

const isGame = (contents) => {
  try { return /(^|\.)pokeidle\.io$/.test(new URL(contents.getURL()).hostname); } catch (_) { return false; }
};

function addLive(link) {
  if (win && !win.isDestroyed()) win.webContents.send('add-live', link);
}

// Sessão de cada conta extra do Pokeidle: persist:pokefarm-acc-<id>
const ACCOUNT_PARTITION = /^persist:pokefarm-acc-[a-z0-9-]{8,40}$/;
const configuredSessions = new Set();

/** User-agent e scripts iguais em todas as sessões (a principal e a de cada conta). */
function setupSession(part) {
  if (configuredSessions.has(part)) return;
  configuredSessions.add(part);
  const ses = session.fromPartition(part);
  ses.setUserAgent(CHROME_UA);
  // Uma página de live pode abrir dezenas de iframes de sincronização de anúncios,
  // cada um com seu renderer. Impede só esse frame conhecido, dentro das webviews
  // de lives; players, chat, desafios de login e janelas de OAuth passam intactos.
  ses.webRequest.onBeforeRequest((details, callback) => {
    let cancel = false;
    if (details.resourceType === 'subFrame') {
      try {
        const page = details.webContents;
        if (new URL(details.url).hostname === 's.amazon-adsystem.com' &&
            page && !page.isDestroyed() && page.getType() === 'webview') {
          cancel = ['www.twitch.tv', 'twitch.tv', 'kick.com', 'www.kick.com', 'player.kick.com']
            .includes(new URL(page.getURL()).hostname);
        }
      } catch (_) { /* página em navegação/fechada: preserva a requisição */ }
    }
    callback({ cancel });
  });
  ses.registerPreloadScript({ id: 'pf-game-channels', type: 'frame', filePath: path.join(__dirname, 'game-channels.js') });
  ses.registerPreloadScript({ id: 'pf-game-session', type: 'frame', filePath: path.join(__dirname, 'game-session.js') });
  ses.registerPreloadScript({ id: 'pf-twitch-economy', type: 'frame', filePath: path.join(__dirname, 'twitch-economy.js') });
  ses.registerPreloadScript({ id: 'pf-kick-economy', type: 'frame', filePath: path.join(__dirname, 'kick-economy.js') });
}

const fromApp = (e) => !!(e.senderFrame && String(e.senderFrame.url).startsWith('file://'));
const liveStatus = createLiveStatusService((url, options) => session.fromPartition(PARTITION).fetch(url, options));

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1000,
    minHeight: 560,
    title: 'PokeFarm',
    backgroundColor: '#141416',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // A janela principal nunca navega para fora nem abre pop-ups
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => setTimeout(() => win && !win.isDestroyed() && win.reload(), 2000));
  win.on('close', event => {
    if (quitting || !tray || tray.isDestroyed()) return;
    event.preventDefault();
    // Oculta sem destruir o renderer/webviews ou alterar o estado de áudio.
    win.hide();
  });
  // O Windows não emite before-quit ao encerrar a sessão do usuário.
  win.on('session-end', () => { quitting = true; });
  win.on('closed', () => { win = null; });
}

app.on('web-contents-created', (_e, contents) => {
  // Toda <webview> recebe o nosso preload e configurações seguras, na sessão compartilhada
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.backgroundThrottling = false;
    // Contas extras do Pokeidle usam sessão própria (login separado); o resto, a compartilhada
    const part = ACCOUNT_PARTITION.test(params.partition || '') ? params.partition : PARTITION;
    setupSession(part);
    webPreferences.partition = part;
    if (!/^https:\/\//.test(params.src || '')) event.preventDefault();
  });

  // Pop-ups das páginas (login, OAuth) abrem numa janela própria, na mesma sessão
  if (contents.getType() === 'webview') {
    // No jogo, link/botão de live da Kick/Twitch vira bloco na aba Lives em vez de abrir
    contents.on('will-navigate', (e, url) => {
      if (!isGame(contents)) return;
      const link = channelURL(url);
      if (link) { e.preventDefault(); addLive(link); }
    });
    contents.on('did-create-window', (child) => {
      if (!isGame(contents)) return;
      // Pop-up aberto em branco e depois mandado para a live
      child.webContents.on('will-navigate', (e, url) => {
        const link = channelURL(url);
        if (link) { e.preventDefault(); addLive(link); child.close(); }
      });
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isGame(contents)) {
        const link = channelURL(url);
        if (link) { addLive(link); return { action: 'deny' }; }
      }
      if (url === 'about:blank' && isGame(contents)) {
        return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { session: contents.session, contextIsolation: true, sandbox: true, nodeIntegration: false } } };
      }
      if (!/^https:\/\//.test(url)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 760,
          title: 'Entrar',
          autoHideMenuBar: true,
          // Mesma sessão da página que abriu: o login de cada conta fica na conta certa
          webPreferences: { session: contents.session, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    });
  }
});

// MARK: IPC da interface

const fromMainWindow = e => !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame;
const fromSummaryWindow = e => !!summaryWindow && e.sender === summaryWindow.webContents && e.senderFrame === summaryWindow.webContents.mainFrame;
ipcMain.handle('session-summary', async e => {
  if (!fromSummaryWindow(e) || !win || win.isDestroyed()) return null;
  let timer;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript('window.__pfCollectSessions ? window.__pfCollectSessions() : ({accounts: []})'),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Game summary timeout')), 4000); }),
    ]);
  } finally { clearTimeout(timer); }
});
ipcMain.on('session-open', e => { if (fromSummaryWindow(e)) showWindow(); });
ipcMain.on('session-close', e => { if (fromSummaryWindow(e)) summaryWindow.hide(); });
ipcMain.on('open-about', e => { if (fromMainWindow(e)) showAbout(); });
ipcMain.handle('update-state', e => fromMainWindow(e) ? updateChecker?.getState() : null);
ipcMain.handle('check-updates', e => fromMainWindow(e) ? updateChecker?.check() : null);
ipcMain.handle('open-update', async e => {
  if (!fromMainWindow(e)) return false;
  const url = updateChecker?.getState().release?.url;
  if (!url) return false;
  try { await shell.openExternal(url); return true; } catch (_) { return false; }
});

ipcMain.handle('live-status', (e, platform, channels) => {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) {
    return {};
  }
  return liveStatus.check(platform, channels);
});

ipcMain.on('notify', (e, msg) => {
  if (!fromApp(e) || !msg || !Notification.isSupported()) return;
  const n = new Notification({ title: String(msg.title).slice(0, 120), body: String(msg.body).slice(0, 300) });
  n.on('click', () => {
    if (quitting) return;
    showWindow();
    win.webContents.send('open-tab', 'game');
  });
  n.show();
});

ipcMain.on('attention', (e) => {
  if (!fromApp(e) || !win) return;
  if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational');
  else if (!win.isFocused()) win.flashFrame(true);
});

ipcMain.on('open-edge', (e, url) => {
  if (!fromApp(e) || typeof url !== 'string' || !SAFE_URL.test(url)) return;
  if (process.platform === 'darwin') {
    const p = spawn('open', ['-a', 'Microsoft Edge', url], { stdio: 'ignore' });
    p.on('error', () => shell.openExternal(url));
    p.on('exit', (code) => { if (code !== 0) shell.openExternal(url); });
  } else if (process.platform === 'win32') {
    // O Windows registra o protocolo microsoft-edge: para abrir direto no Edge
    shell.openExternal(`microsoft-edge:${url}`).catch(() => shell.openExternal(url));
  } else {
    shell.openExternal(url);
  }
});

// Login numa janela própria (não numa webview): o Google recusa login dentro de webview embutida.
// Aceita os pop-ups de OAuth (Google/Twitch/Kick) como janelas-filhas na mesma sessão.
ipcMain.on('open-login', (e, platform, partition) => {
  const url = LOGIN_URLS[platform];
  if (!fromApp(e) || !url) return;
  const part = ACCOUNT_PARTITION.test(partition || '') ? partition : PARTITION;
  setupSession(part);
  openLoginWindow(url, platform === 'twitch' ? 'Entrar na Twitch' : 'Entrar na Kick', part);
});

ipcMain.on('open-game-login', (e, partition) => {
  if (!fromApp(e)) return;
  const part = ACCOUNT_PARTITION.test(partition || '') ? partition : PARTITION;
  setupSession(part);
  openLoginWindow('https://pokeidle.io/app', 'Entrar no Pokeidle', part);
});

function openLoginWindow(url, title, part) {
  const w = new BrowserWindow({
    width: 540, height: 760, title, autoHideMenuBar: true,
    webPreferences: { partition: part, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // UA de navegador real (sem "Electron"); o Google bloqueia webview/apps embutidos
  w.webContents.setUserAgent(CHROME_UA);
  // Pop-up do OAuth (Google etc.): abre como janela-filha na MESMA sessão, não bloqueia
  const childOpts = {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 540, height: 720, autoHideMenuBar: true,
      webPreferences: { session: w.webContents.session, contextIsolation: true, sandbox: true, nodeIntegration: false },
    },
  };
  w.webContents.setWindowOpenHandler(({ url: u }) => (/^https:\/\//.test(u) ? childOpts : { action: 'deny' }));
  w.webContents.on('did-create-window', (child) => {
    child.webContents.setUserAgent(CHROME_UA);
    child.webContents.setWindowOpenHandler(({ url: u }) => (/^https:\/\//.test(u) ? childOpts : { action: 'deny' }));
  });
  w.loadURL(url);
}

// Amostras brutas do mercado (ajudam a ajustar a leitura depois)
ipcMain.on('write-sample', (e, msg) => {
  if (!fromApp(e) || !msg) return;
  const file = path.join(app.getPath('userData'), 'market-samples.jsonl');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 3_000_000) return;
    const line = JSON.stringify({ date: new Date().toISOString(), url: String(msg.url).slice(0, 500), body: String(msg.text).slice(0, 30000) });
    fs.appendFileSync(file, line + '\n');
  } catch (_) { /* ignora */ }
});

// Conta removida: apaga o login dela (só contas extras; a principal é a mesma das lives)
ipcMain.handle('clear-account', async (e, id) => {
  const part = `persist:pokefarm-acc-${String(id)}`;
  if (!fromApp(e) || !ACCOUNT_PARTITION.test(part)) return false;
  try { await session.fromPartition(part).clearStorageData(); return true; } catch (_) { return false; }
});

ipcMain.on('open-data-dir', (e) => {
  if (fromApp(e)) shell.openPath(app.getPath('userData'));
});

// MARK: Ciclo de vida

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  setupSession(PARTITION);
  // Mantém o Mac/PC ativo com o app aberto, mas permite que a tela apague.
  powerSaveBlocker.start('prevent-app-suspension');
  createTray();
  createWindow();
  startUpdateChecks();
  app.on('activate', () => { if (!summaryWindow?.isVisible()) showWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  clearTimeout(trayClickTimer);
  if (updateTimer) clearInterval(updateTimer);
});
app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
});
