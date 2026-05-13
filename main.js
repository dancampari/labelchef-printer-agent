const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const { autoUpdater } = require('electron-updater');
const CONSTANTS = require('./src/config/constants');
const { isValidPrinterName } = require('./src/utils/printerValidator');

// ── Auto-update via GitHub Releases ──────────────────────────────────────────
// Estratégia profissional, controle MANUAL:
//  - autoDownload=false: detecta versão nova, NÃO baixa sem consentimento.
//  - autoInstallOnAppQuit=false: NÃO aplica sozinho — usuário decide quando.
//  - Skipped versions: persistidas em data/update-prefs.json. Versão pulada
//    não dispara notificação na próxima checagem (mas se sair uma posterior,
//    ela aparece normalmente).
//  - Checa só no boot + via ação manual (botão na UI ou item do tray).
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowDowngrade = false;

// Persistência de preferências (skipped versions)
const UPDATE_PREFS_FILE = path.join(app.getPath('userData'), 'update-prefs.json');

function readUpdatePrefs() {
    try {
        if (fs.existsSync(UPDATE_PREFS_FILE)) {
            const raw = fs.readFileSync(UPDATE_PREFS_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                skippedVersions: Array.isArray(parsed.skippedVersions) ? parsed.skippedVersions : [],
            };
        }
    } catch (e) {
        console.warn('[autoUpdater] falha ao ler update-prefs:', e.message);
    }
    return { skippedVersions: [] };
}

function writeUpdatePrefs(prefs) {
    try {
        fs.mkdirSync(path.dirname(UPDATE_PREFS_FILE), { recursive: true });
        fs.writeFileSync(UPDATE_PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8');
    } catch (e) {
        console.warn('[autoUpdater] falha ao salvar update-prefs:', e.message);
    }
}

let updateState = {
    status: 'idle',        // idle | checking | available | downloading | ready | error | skipped
    info: null,            // { version, releaseNotes, releaseName, releaseDate, files }
    error: null,
    downloadProgress: 0,   // 0–100
    skippedVersions: readUpdatePrefs().skippedVersions,
    currentVersion: app.getVersion(),
    lastCheckedAt: null,   // ISO timestamp da última checagem concluída (ok ou erro)
    autoInstallAfterDownload: false, // se true, instala automaticamente ao terminar o download
};

function pushUpdateStateToAgent() {
    if (!agentProcess) return;
    try {
        agentProcess.send({
            type: 'UPDATE_STATUS',
            payload: {
                status: updateState.status,
                version: updateState.info && updateState.info.version,
                releaseNotes: updateState.info && (updateState.info.releaseNotes || ''),
                releaseName: updateState.info && (updateState.info.releaseName || ''),
                releaseDate: updateState.info && (updateState.info.releaseDate || null),
                currentVersion: updateState.currentVersion,
                error: updateState.error,
                progress: updateState.downloadProgress,
                skippedVersions: updateState.skippedVersions,
                lastCheckedAt: updateState.lastCheckedAt,
            },
        });
    } catch { /* ignore */ }
}

// ── Ações (chamadas via IPC do agent.js, originadas dos endpoints REST) ─────

function actionCheckForUpdates() {
    if (!app.isPackaged) return Promise.resolve({ ok: false, error: 'Não disponível em modo dev.' });
    return autoUpdater.checkForUpdates()
        .then((res) => {
            // BUG histórico: `res.updateInfo` é populado SEMPRE que o GitHub tem
            // qualquer release (mesmo a atual), então `!!res.updateInfo` retorna
            // true até quando estamos atualizados. Comparar versões de verdade.
            const latest = res && res.updateInfo && res.updateInfo.version;
            const current = app.getVersion();
            const hasUpdate = !!(latest && current && latest !== current);
            return { ok: true, hasUpdate, latest, current };
        })
        .catch((err) => ({ ok: false, error: err && err.message }));
}

function actionStartDownload(options = {}) {
    if (!app.isPackaged) return Promise.resolve({ ok: false, error: 'Não disponível em modo dev.' });
    if (!updateState.info) return Promise.resolve({ ok: false, error: 'Nenhuma atualização disponível.' });
    const autoInstall = !!options.autoInstall;

    if (updateState.status === 'downloading') {
        if (autoInstall) updateState.autoInstallAfterDownload = true;
        return Promise.resolve({ ok: false, error: 'Download já em andamento.' });
    }
    if (updateState.status === 'ready') {
        if (autoInstall) return Promise.resolve(actionInstallNow());
        return Promise.resolve({ ok: true, alreadyReady: true });
    }

    updateState.status = 'downloading';
    updateState.downloadProgress = 0;
    updateState.autoInstallAfterDownload = autoInstall;
    pushUpdateStateToAgent();
    updateTrayMenu();

    return autoUpdater.downloadUpdate()
        .then(() => ({ ok: true, autoInstall }))
        .catch((err) => {
            updateState.status = 'error';
            updateState.error = err && err.message;
            updateState.autoInstallAfterDownload = false;
            pushUpdateStateToAgent();
            updateTrayMenu();
            return { ok: false, error: err && err.message };
        });
}

function actionInstallNow() {
    if (updateState.status !== 'ready') {
        return { ok: false, error: 'Atualização ainda não foi baixada.' };
    }
    setTimeout(() => {
        try {
            app.isQuitting = true;
            if (agentProcess) {
                try { agentProcess.kill(); } catch { /* ignore */ }
            }
            autoUpdater.quitAndInstall(false, true);
        } catch (e) {
            console.error('[autoUpdater] falha ao instalar update:', e);
        }
    }, 500);
    return { ok: true };
}

function actionSkipVersion(version) {
    if (!version || typeof version !== 'string') return { ok: false, error: 'Versão inválida.' };
    const prefs = readUpdatePrefs();
    if (!prefs.skippedVersions.includes(version)) {
        prefs.skippedVersions.push(version);
        writeUpdatePrefs(prefs);
    }
    updateState.skippedVersions = prefs.skippedVersions;
    if (updateState.info && updateState.info.version === version) {
        updateState.status = 'skipped';
        updateState.info = null;
        updateState.downloadProgress = 0;
    }
    pushUpdateStateToAgent();
    updateTrayMenu();
    return { ok: true, skippedVersions: prefs.skippedVersions };
}

let mainWindow;
let persistentSpoolerWindow = null;
let tray;
let agentProcess;

// Estado para desenhar o menu
let agentState = {
    status: 'Iniciando...',
    printerName: 'Detectando...',
    printerStatus: '...'
};

// 🔒 SINGLE INSTANCE LOCK
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        // Fix notification name on Windows
        app.setAppUserModelId('LabelChef Agent');

        if (app.isPackaged) {
            app.setLoginItemSettings({
                openAtLogin: true,
                path: process.execPath,
                args: ['--hidden']
            });
        }

        createPersistentSpooler();
        startAgent();

        const shouldShow = !process.argv.includes('--hidden');
        createWindow(shouldShow);
        createTray();

        registerDeviceChangeWatcher();

        if (app.isPackaged) {
            setTimeout(() => {
                autoUpdater.checkForUpdates().catch((err) => {
                    console.warn('[autoUpdater] checagem inicial falhou:', err && err.message);
                });
            }, 8000);
        }
    });
}

// ── Listeners do autoUpdater ────────────────────────────────────────────────
autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = null;
    pushUpdateStateToAgent();
});

autoUpdater.on('update-available', (info) => {
    updateState.lastCheckedAt = new Date().toISOString();
    if (updateState.skippedVersions.includes(info.version)) {
        console.log(`[autoUpdater] versão ${info.version} disponível mas foi pulada pelo usuário.`);
        updateState.status = 'skipped';
        updateState.info = info;
        pushUpdateStateToAgent();
        updateTrayMenu();
        return;
    }
    updateState.status = 'available';
    updateState.info = info;
    console.log(`[autoUpdater] versão ${info.version} disponível — aguardando decisão do usuário.`);
    showNotification({
        title: 'Atualização disponível',
        body: `LabelChef Agent ${info.version} pronto para instalar. Abra o painel para escolher.`,
    });
    pushUpdateStateToAgent();
    updateTrayMenu();
});

autoUpdater.on('update-not-available', () => {
    updateState.status = 'idle';
    updateState.info = null;
    updateState.lastCheckedAt = new Date().toISOString();
    pushUpdateStateToAgent();
    updateTrayMenu();
});

autoUpdater.on('download-progress', (progress) => {
    updateState.downloadProgress = Math.round(progress.percent || 0);
    pushUpdateStateToAgent();
});

autoUpdater.on('update-downloaded', (info) => {
    updateState.status = 'ready';
    updateState.info = info;
    updateState.downloadProgress = 100;
    console.log(`[autoUpdater] versão ${info.version} pronta para aplicar.`);
    pushUpdateStateToAgent();
    updateTrayMenu();

    if (updateState.autoInstallAfterDownload) {
        updateState.autoInstallAfterDownload = false;
        showNotification({
            title: 'Instalando atualização',
            body: `${info.version} pronta. O agent será reiniciado em instantes.`,
        });
        setTimeout(() => {
            const r = actionInstallNow();
            if (!r.ok) console.warn('[autoUpdater] auto-install falhou:', r.error);
        }, 1500);
    } else {
        showNotification({
            title: 'Atualização pronta',
            body: `${info.version} baixada. Clique em "Instalar agora" no painel quando preferir.`,
        });
    }
});

autoUpdater.on('error', (err) => {
    updateState.status = 'error';
    updateState.error = (err && err.message) || String(err);
    updateState.lastCheckedAt = new Date().toISOString();
    console.warn('[autoUpdater] erro:', updateState.error);
    pushUpdateStateToAgent();
    updateTrayMenu();
});

// Detecta plug/unplug de dispositivos USB via WM_DEVICECHANGE.
let lastDeviceChangeAt = 0;
function registerDeviceChangeWatcher() {
    try {
        const hookWin = new BrowserWindow({
            show: false,
            width: 1, height: 1,
            webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
        });
        const WM_DEVICECHANGE = 0x0219;
        if (typeof hookWin.hookWindowMessage === 'function') {
            hookWin.hookWindowMessage(WM_DEVICECHANGE, () => {
                const now = Date.now();
                if (now - lastDeviceChangeAt < 1000) return;
                lastDeviceChangeAt = now;
                if (agentProcess) {
                    agentProcess.send({ type: 'DEVICE_CHANGE' });
                }
            });
        }
    } catch (e) {
        console.error('[MAIN] Falha ao registrar WM_DEVICECHANGE:', e.message);
    }
}

nativeTheme.on('updated', () => {
    updateTrayMenu();
});

// ── Spooler Persistente ─────────────────────────────────────────────────────
// Para impressões HTML (caso futuro). Para ZPL/PDF, o caminho é printerUSB/
// printerNetwork/printerPDF e NÃO passa por este spooler.
function createPersistentSpooler() {
    persistentSpoolerWindow = new BrowserWindow({
        show: false,
        width: 400,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            offscreen: true,
            backgroundThrottling: true,
            preload: path.join(__dirname, 'preloadSpooler.js')
        }
    });
    try { persistentSpoolerWindow.webContents.setFrameRate(1); } catch { /* electron < 12 */ }
    persistentSpoolerWindow.loadFile(path.join(__dirname, 'public/blank-spooler.html'));

    ipcMain.on('spooler-ready-to-print', (event, { id, printerName, widthMicrons }) => {
        if (!persistentSpoolerWindow) return;

        if (!isValidPrinterName(printerName)) {
            if (agentProcess) {
                agentProcess.send({
                    type: 'PRINT_HTML_RESULT',
                    id,
                    success: false,
                    error: 'deviceName inválido no spooler — impressão abortada (não usar default printer).',
                });
            }
            return;
        }

        persistentSpoolerWindow.webContents.print({
            deviceName: printerName,
            silent: true,
            printBackground: true,
            pageSize: { width: widthMicrons, height: 297000 },
            margins: { marginType: 'none' }
        }, (success, failureReason) => {
            if (agentProcess) {
                if (success) {
                    agentProcess.send({ type: 'PRINT_HTML_RESULT', id, success: true });
                } else {
                    agentProcess.send({ type: 'PRINT_HTML_RESULT', id, success: false, error: failureReason || 'Falha na impressão pelo Spooler' });
                }
            }
        });
    });
}

// 1. INICIA O MOTOR (AGENT.JS)
function startAgent() {
    agentProcess = fork(path.join(__dirname, 'agent.js'), [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
            ...process.env,
            ELECTRON_RUN: 'true',
            USER_DATA_PATH: app.getPath('userData'),
            RESOURCES_PATH: process.resourcesPath
        }
    });

    agentProcess.on('message', (msg) => {
        if (msg.type === 'UPDATE_DATA') {
            agentState = msg.payload;
            updateTrayMenu();
        } else if (msg.type === 'NOTIFICATION') {
            showNotification(msg);
        } else if (msg.type === 'UPDATE_ACTION') {
            // Ação vinda dos endpoints REST do agent (POST /api/update/*).
            const { requestId, action, version } = msg;
            const respond = (result) => {
                try { agentProcess.send({ type: 'UPDATE_ACTION_RESULT', requestId, ...result }); } catch { /* ignore */ }
            };
            try {
                if (action === 'check') {
                    Promise.resolve(actionCheckForUpdates()).then(respond);
                } else if (action === 'download') {
                    Promise.resolve(actionStartDownload({ autoInstall: !!msg.autoInstall })).then(respond);
                } else if (action === 'install') {
                    respond(actionInstallNow());
                } else if (action === 'skip') {
                    respond(actionSkipVersion(version));
                } else if (action === 'status') {
                    respond({ ok: true, state: {
                        status: updateState.status,
                        version: updateState.info && updateState.info.version,
                        releaseNotes: updateState.info && (updateState.info.releaseNotes || ''),
                        releaseName: updateState.info && (updateState.info.releaseName || ''),
                        releaseDate: updateState.info && (updateState.info.releaseDate || null),
                        currentVersion: updateState.currentVersion,
                        error: updateState.error,
                        progress: updateState.downloadProgress,
                        skippedVersions: updateState.skippedVersions,
                        lastCheckedAt: updateState.lastCheckedAt,
                    }});
                } else {
                    respond({ ok: false, error: 'Ação desconhecida: ' + action });
                }
            } catch (e) {
                respond({ ok: false, error: e && e.message });
            }
        } else if (msg.type === 'ENCRYPT') {
            const { id, data } = msg;
            try {
                if (app.isReady() && safeStorage.isEncryptionAvailable()) {
                    const encrypted = safeStorage.encryptString(data);
                    agentProcess.send({ type: 'ENCRYPT_RESULT', id, success: true, data: encrypted.toString('hex') });
                } else {
                    agentProcess.send({ type: 'ENCRYPT_RESULT', id, success: false, error: 'Encryption unavailable' });
                }
            } catch (e) {
                agentProcess.send({ type: 'ENCRYPT_RESULT', id, success: false, error: e.message });
            }
        } else if (msg.type === 'DECRYPT') {
            const { id, dataHex } = msg;
            try {
                if (app.isReady() && safeStorage.isEncryptionAvailable()) {
                    const buffer = Buffer.from(dataHex, 'hex');
                    const decrypted = safeStorage.decryptString(buffer);
                    agentProcess.send({ type: 'DECRYPT_RESULT', id, success: true, data: decrypted });
                } else {
                    agentProcess.send({ type: 'DECRYPT_RESULT', id, success: false, error: 'Encryption unavailable' });
                }
            } catch (e) {
                agentProcess.send({ type: 'DECRYPT_RESULT', id, success: false, error: e.message });
            }
        } else if (msg.type === 'PRINT_TEST_LABEL') {
            // 🖨️ Imprime etiqueta de teste via Electron webContents.print()
            // LabelChef: etiqueta 60×60mm (formato ZPL Zebra padrão).
            const { id, company, printerName } = msg;

            if (!isValidPrinterName(printerName)) {
                agentProcess.send({
                    type: 'PRINT_TEST_LABEL_RESULT',
                    id,
                    success: false,
                    error: 'deviceName inválido — teste de impressão abortado.',
                });
                return;
            }

            const labelWin = new BrowserWindow({
                width: 300,
                height: 300,
                show: false,
                webPreferences: { nodeIntegration: false }
            });

            const staticPath = path.join(__dirname, 'public');
            const encodedCompany = encodeURIComponent(company || '');
            labelWin.loadFile(path.join(staticPath, 'test-label.html'), {
                query: { company: encodedCompany }
            });

            labelWin.webContents.once('did-finish-load', async () => {
                await new Promise(r => setTimeout(r, 400));

                labelWin.webContents.print({
                    deviceName: printerName,
                    silent: true,
                    printBackground: true,
                    // LabelChef: 60mm x 60mm (etiqueta padrão ZPL para alimentos)
                    pageSize: { width: 60000, height: 60000 },
                    margins: { marginType: 'none' }
                }, (success, failureReason) => {
                    labelWin.destroy();
                    if (success) {
                        agentProcess.send({ type: 'PRINT_TEST_LABEL_RESULT', id, success: true });
                    } else {
                        agentProcess.send({ type: 'PRINT_TEST_LABEL_RESULT', id, success: false, error: failureReason || 'Falha na impressão' });
                    }
                });
            });

            labelWin.webContents.on('did-fail-load', (event, code, desc) => {
                agentProcess.send({ type: 'PRINT_TEST_LABEL_RESULT', id, success: false, error: desc });
                labelWin.destroy();
            });

        } else if (msg.type === 'PRINT_HTML') {
            // 🖨️ Impressão HTML via spooler persistente (caminho opcional/futuro).
            // Fluxo principal do LabelChef é ZPL/Network/PDF e NÃO passa por aqui.
            const { id, htmlContent, printerName } = msg;

            if (!isValidPrinterName(printerName)) {
                agentProcess.send({
                    type: 'PRINT_HTML_RESULT',
                    id,
                    success: false,
                    error: 'deviceName inválido — impressão HTML abortada (não usar default printer).',
                });
                return;
            }

            if (!persistentSpoolerWindow || persistentSpoolerWindow.isDestroyed()) {
                createPersistentSpooler();
            }

            try {
                const match = (htmlContent || "").match(/@page\s*\{[^}]*size:\s*([0-9.]+)\s*mm/i);
                const widthMm = match ? parseFloat(match[1]) : 60; // default 60mm para LabelChef
                const widthMicrons = Math.round((Number.isFinite(widthMm) ? widthMm : 60) * 1000);

                persistentSpoolerWindow.webContents.send('inject-html-for-print', {
                    id,
                    htmlContent,
                    printerName,
                    widthMicrons
                });
            } catch (e) {
                agentProcess.send({ type: 'PRINT_HTML_RESULT', id, success: false, error: 'Erro no pipeline persistente: ' + e.message });
            }
        }
    });

    // Debug no terminal
    agentProcess.stdout.on('data', d => process.stdout.write(`[AGENT] ${d}`));
    agentProcess.stderr.on('data', d => process.stderr.write(`[AGENT:ERR] ${d}`));
}

// 2. NOTIFICAÇÕES TIPO "TOAST"
function showNotification({ title, body, urgency }) {
    const notification = new Notification({
        title: title,
        body: body,
        icon: path.join(__dirname, 'public/icon.png'),
        urgency: urgency || 'normal'
    });

    notification.on('click', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    notification.show();
}

// 3. JANELA PRINCIPAL (DASHBOARD)
function createWindow(shouldShow = false) {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        icon: path.join(__dirname, 'public/icon.png'),
        backgroundColor: '#09090B', // Coincide com var(--background) escuro do shadcn
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false }
    });

    const checkServer = async (attempt = 1) => {
        const { net } = require('electron');
        const request = net.request(`http://127.0.0.1:${CONSTANTS.HTTP_PORT}/login.html`);

        request.on('response', (response) => {
            if (response.statusCode === 200) {
                mainWindow.loadURL(`http://127.0.0.1:${CONSTANTS.HTTP_PORT}`);
                if (shouldShow) {
                    mainWindow.once('ready-to-show', () => {
                        mainWindow.show();
                        mainWindow.focus();
                    });
                    setTimeout(() => {
                        if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
                    }, 1000);
                }
            } else {
                if (attempt < 10) setTimeout(() => checkServer(attempt + 1), 500);
            }
        });

        request.on('error', () => {
            if (attempt < 20) {
                setTimeout(() => checkServer(attempt + 1), 500);
            } else {
                console.error('SERVER', 'Timeout aguardando servidor Express.');
            }
        });

        request.end();
    };

    setTimeout(checkServer, 1000);

    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
        return false;
    });
}

// 4. MENU DA BANDEJA (NATIVO WINDOWS)
function createTray() {
    let trayIcon;

    if (process.platform === 'win32') {
        const icoPath = path.join(__dirname, 'public/icon.ico');
        trayIcon = nativeImage.createFromPath(icoPath);
    } else {
        trayIcon = getIcon('tray-icon.png') || getIcon('icon.png');
    }

    if (!trayIcon || trayIcon.isEmpty()) {
        const iconPng = path.join(__dirname, 'public/icon.png');
        trayIcon = nativeImage.createFromPath(iconPng).resize({ width: 16, height: 16 });
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('LabelChef Agent - Protegido');

    tray.on('double-click', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    updateTrayMenu();
}

function getIcon(name) {
    try {
        const p = path.join(__dirname, 'public', name);
        return nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
    } catch (e) { return null; }
}

function updateTrayMenu() {
    if (!tray) return;

    const themeSuffix = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';

    const sysStatus = (agentState.status || '').toUpperCase();
    const prnStatus = (agentState.printerStatus || '').toUpperCase();
    const prnName = (agentState.printerName || '');

    let sysIcon = 'status-off.png';
    if (sysStatus.includes('INICIANDO') || sysStatus.includes('CONNECTING') || sysStatus === '...') {
        sysIcon = `wait-${themeSuffix}.png`;
    } else if (sysStatus.includes('ONLINE') || sysStatus.includes('SUBSCRIBED') || sysStatus.includes('CONNECTED')) {
        sysIcon = 'status-on.png';
    }

    let prnIcon = 'status-off.png';
    if (prnStatus === '...' || prnStatus.includes('DETECTANDO') || prnStatus.includes('AGUARDANDO') || prnName === 'Detectando...') {
        prnIcon = `wait-${themeSuffix}.png`;
    } else if (
        prnStatus.includes('ONLINE') ||
        prnStatus.includes('PRONTA') ||
        prnStatus.includes('IMPRIMINDO') ||
        prnStatus.includes('IDLE')
    ) {
        prnIcon = 'status-on.png';
    }

    const overallStatus = (sysIcon === 'status-on.png' && prnIcon === 'status-on.png') ? 'Operacional' : 'Aguardando/Atenção';
    tray.setToolTip(`LabelChef Agent: ${overallStatus}\nSistema: ${agentState.status}\nImpressora: ${agentState.printerStatus}`);

    // ── Itens de update contextuais ─────────────────────────────────────
    const updateContextItems = [];
    if (updateState.status === 'available' && updateState.info) {
        updateContextItems.push({
            label: `Atualização disponível: v${updateState.info.version}`,
            enabled: false,
        });
        updateContextItems.push({
            label: 'Baixar e instalar',
            click: () => { actionStartDownload({ autoInstall: true }); },
        });
        updateContextItems.push({
            label: 'Pular esta versão',
            click: () => { actionSkipVersion(updateState.info.version); },
        });
        updateContextItems.push({ type: 'separator' });
    } else if (updateState.status === 'downloading' && updateState.info) {
        const willInstall = updateState.autoInstallAfterDownload ? ' (instala ao terminar)' : '';
        updateContextItems.push({
            label: `Baixando v${updateState.info.version} (${updateState.downloadProgress}%)${willInstall}`,
            enabled: false,
        });
        updateContextItems.push({ type: 'separator' });
    } else if (updateState.status === 'ready' && updateState.info) {
        updateContextItems.push({
            label: `Versão v${updateState.info.version} pronta para instalar`,
            enabled: false,
        });
        updateContextItems.push({
            label: 'Instalar e reiniciar agora',
            click: () => { actionInstallNow(); },
        });
        updateContextItems.push({
            label: 'Pular esta versão',
            click: () => { actionSkipVersion(updateState.info.version); },
        });
        updateContextItems.push({ type: 'separator' });
    }

    const checkLabel =
        updateState.status === 'checking' ? 'Verificando atualizações...' :
        updateState.status === 'downloading' ? 'Aguarde o download...' :
        'Verificar atualizações';
    const checkEnabled = app.isPackaged
        && updateState.status !== 'checking'
        && updateState.status !== 'downloading';

    const contextMenu = Menu.buildFromTemplate([
        {
            label: `LabelChef Agent v${updateState.currentVersion}`,
            icon: getIcon('icon.png'),
            enabled: false,
        },
        { type: 'separator' },
        ...updateContextItems,
        {
            label: `Sistema: ${agentState.status}`,
            icon: getIcon(sysIcon),
            enabled: false,
        },
        {
            label: `Impressora: ${agentState.printerName}`,
            icon: getIcon(prnIcon),
            enabled: false,
        },
        {
            label: `Status: ${agentState.printerStatus}`,
            icon: getIcon(prnIcon),
            enabled: false,
        },
        { type: 'separator' },
        {
            label: checkLabel,
            icon: getIcon(`refresh-ccw-dot-${themeSuffix}.png`),
            enabled: checkEnabled,
            click: () => { actionCheckForUpdates(); },
        },
        {
            label: 'Corrigir Fila de Impressão',
            icon: getIcon(`action-clean-${themeSuffix}.png`),
            click: () => {
                if (agentProcess) agentProcess.send({ type: 'FORCE_CLEAR_QUEUE' });
                tray.displayBalloon({ title: 'Manutenção', content: 'Limpando spooler...' });
            },
        },
        {
            label: 'Imprimir Página de Teste',
            icon: getIcon(`printer-${themeSuffix}.png`),
            click: () => {
                if (agentProcess) agentProcess.send({ type: 'RUN_TEST_PRINT' });
            },
        },
        {
            label: 'Abrir Painel de Controle',
            icon: getIcon(`action-settings-${themeSuffix}.png`),
            click: () => mainWindow && mainWindow.show(),
        },
        { type: 'separator' },
        {
            label: 'Sair',
            icon: getIcon(`action-exit-${themeSuffix}.png`),
            click: () => {
                app.isQuitting = true;
                if (agentProcess) agentProcess.kill();
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);
}

app.on('before-quit', () => {
    if (agentProcess) agentProcess.kill();
});
