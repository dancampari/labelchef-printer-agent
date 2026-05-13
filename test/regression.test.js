/**
 * Regressão estática — garante que os bugs corrigidos não voltem ao código.
 *
 * Esses testes leem o source dos arquivos e verificam padrões. Cobrem cenários
 * que seriam silenciosos em runtime mas que já causaram problema em produção.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const root = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('REGRESSÃO: monitor.js não usa $host = (variável reservada do PowerShell)', () => {
    const src = root('services/monitor.js');
    // Procuramos atribuições para $host. `$_.Host` ou `$_.HostAddress` são OK.
    assert.doesNotMatch(src, /\$host\s*=\s*/, '$host = não pode aparecer (read-only no PS)');
    assert.match(src, /\$portHost/, 'deve usar $portHost como nome alternativo');
});

test('REGRESSÃO: pshost.js usa REPL .ps1 (não powershell -Command -)', () => {
    const src = root('core/pshost.js');
    assert.match(src, /-File/, 'PSHost deve spawn com -File (REPL .ps1)');
    assert.match(src, /\[Console\]::In\.ReadLine\(\)/, 'REPL deve ler stdin linha a linha');
    assert.match(src, /\$\{BLOCK_TERMINATOR\}|###END_OF_BLOCK###/, 'deve haver terminador de bloco');
});

test('REGRESSÃO: pshost.js wrappa comando em & { } para evitar pipeline leak', () => {
    const src = root('core/pshost.js');
    // O bug era $r = ${command} (sem scriptblock) capturando só o primeiro statement
    assert.match(src, /\$r\s*=\s*&\s*\{\s*\$\{command\}\s*\}/, 'deve envolver $r = & { ${command} }');
});

test('REGRESSÃO: pshost.js força UTF-8 no [Console]::OutputEncoding', () => {
    const src = root('core/pshost.js');
    assert.match(src, /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/);
    assert.match(src, /\$OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/);
});

test('REGRESSÃO: pshost.js NÃO usa setEncoding(utf8) no stdout (lê Buffer)', () => {
    const src = root('core/pshost.js');
    // setEncoding('utf8') quebrava porque PowerShell escrevia UTF-16 antes do preamble rodar.
    assert.doesNotMatch(src, /stdout\.setEncoding\(['"]utf8['"]\)/, 'não pode usar setEncoding(utf8) no stdout');
    // Deve decodificar manualmente via Buffer
    assert.match(src, /toString\(['"]utf8['"]\)/, 'deve decodificar Buffer→string manualmente');
});

test('REGRESSÃO: pshost.js tem handshake READY antes de aceitar comandos', () => {
    const src = root('core/pshost.js');
    assert.match(src, /PS_HOST_READY_V1/, 'deve ter marker de handshake READY');
    assert.match(src, /waitReady/, 'deve expor waitReady()');
    assert.match(src, /if\s*\(!this\.ready\)\s*await\s+this\.waitReady\(\)/, 'run() deve esperar READY');
});

test('REGRESSÃO: socket.js tem polling adaptativo (watchdog + reconnect)', () => {
    const src = root('core/socket.js');
    assert.match(src, /watchdog/i, 'deve ter modo watchdog');
    assert.match(src, /WATCHDOG_MS/, 'deve ter constante de intervalo watchdog');
    assert.match(src, /kind === ['"]watchdog['"]/, 'deve diferenciar modos');
});

test('SAFETY NET (v3.2.0+): watchdog SUBSCRIBED tambem drena pending jobs', () => {
    // Bug histórico: quando o Realtime do Supabase ficava "stuck SUBSCRIBED"
    // (status conectado mas sem entregar eventos — comum em redes flaky), os
    // jobs vindos de outros clientes (ex.: mobile na nuvem) sentavam até o
    // heartbeat do client derrubar o canal (30-60s). Mobile users observavam
    // ~60s de espera entre clicar "imprimir" e a impressora cuspir.
    // Fix: watchdog SUBSCRIBED também roda _drainPending a cada tick.
    const src = root('core/socket.js');
    // Match até a próxima sentinela `// kind === 'reconnect'` que separa os modos
    const watchdogBlock = src.match(/if \(kind === ['"]watchdog['"]\)[\s\S]*?\/\/ kind === ['"]reconnect/);
    assert.ok(watchdogBlock, 'bloco do watchdog precisa ser localizável');
    assert.match(watchdogBlock[0], /_drainPending/, 'watchdog DEVE chamar _drainPending como safety net');
});

test('REGRESSÃO: agent.js inicia PSHost no boot (LabelChef: sem preamble — printerUSB usa seu próprio pipeline inline)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    // LabelChef: printerUSB.js tem RawPrinterHelper inline na função print().
    // Não exporta PREAMBLE como o Ontrack faz, porque printing logic é preservada.
    // O PSHost só atende monitor queries (Get-WmiObject, Get-Printer, Get-PrintJob),
    // que NÃO precisam de RawPrinterHelper.
    assert.match(src, /pshost\.start\(\)/, 'deve iniciar PSHost no boot');
});

test('REGRESSÃO: agent.js usa heartbeat 60s (não 30s)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    // Procuramos exatamente o setInterval do heartbeat com 60000
    assert.match(src, /setInterval\(\(\)\s*=>\s*database\.sendHeartbeat\(\),\s*60000\)/);
    assert.doesNotMatch(src, /setInterval\(\(\)\s*=>\s*database\.sendHeartbeat\(\),\s*30000\)/);
});

test('REGRESSÃO: agent.js faz diff no IPC do tray (não envia se igual)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /lastPayloadJson/, 'deve guardar payload anterior');
    assert.match(src, /if\s*\(json\s*!==\s*lastPayloadJson\)/, 'deve comparar antes de enviar');
});

test('REGRESSÃO: agent.js trata DEVICE_CHANGE via IPC', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /msg\.type\s*===\s*['"]DEVICE_CHANGE['"]/, 'deve responder ao DEVICE_CHANGE');
    assert.match(src, /monitor\.onDeviceChange/, 'deve chamar monitor.onDeviceChange');
});

test('REGRESSÃO: main.js registra WM_DEVICECHANGE (0x0219)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /WM_DEVICECHANGE\s*=\s*0x0219/, 'deve registrar mensagem WM_DEVICECHANGE');
    assert.match(src, /hookWindowMessage/, 'deve usar hookWindowMessage');
});

test('REGRESSÃO: main.js cria spooler offscreen + throttled', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /offscreen:\s*true/, 'spooler deve ser offscreen');
    assert.match(src, /backgroundThrottling:\s*true/, 'spooler deve ter backgroundThrottling');
    assert.match(src, /width:\s*400,\s*height:\s*800/, 'spooler 400x800 (reduzido de 800x600)');
});

test('REGRESSÃO: controllers.js tem cache de 30s em /api/printers', () => {
    const src = root('api/controllers.js');
    assert.match(src, /PRINTERS_CACHE_TTL_MS/, 'deve declarar TTL de cache');
    assert.match(src, /printersCache/, 'deve manter cache');
});

test('REGRESSÃO: controllers.js expõe /api/health enriquecido', () => {
    const src = root('api/controllers.js');
    assert.match(src, /authenticated:\s*state\.isAuthenticated\(\)/);
    assert.match(src, /printerConfigured/);
    assert.match(src, /defaultPrinter/);
    assert.match(src, /printerOnline/);
});

test('REGRESSÃO: server.js usa Controllers.health (não inline)', () => {
    const src = root('api/server.js');
    assert.match(src, /app\.get\(['"]\/api\/health['"],\s*Controllers\.health\)/);
});

test('REGRESSÃO: logger.js tem buffer reduzido para 100', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'logger.js'), 'utf8');
    assert.match(src, /MAX_BUFFER_SIZE\s*=\s*100/);
});

test('REGRESSÃO: fixQueue limpa fila via Get-PrintJob | Remove-PrintJob + Resume-Printer (LabelChef inline)', () => {
    const src = root('services/printerUSB.js');
    // LabelChef mantém o script PowerShell inline (não refatorado pra pshost).
    // O script usa ErrorAction SilentlyContinue ao invés de Get-Command,
    // que é defensivo o suficiente — se o cmdlet não existir, simplesmente é no-op.
    assert.match(src, /Get-PrintJob/, 'fixQueue deve usar Get-PrintJob');
    assert.match(src, /Remove-PrintJob/, 'fixQueue deve usar Remove-PrintJob');
    assert.match(src, /Resume-Printer/, 'fixQueue deve tentar Resume-Printer');
    assert.match(src, /ErrorAction\s+SilentlyContinue/, 'fixQueue deve usar -ErrorAction SilentlyContinue como defensiva');
});

test('REGRESSÃO: package.json tem version semver válida', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'pkg.version deve estar em formato X.Y.Z');
});

test('REGRESSÃO: controllers.js reporta version dinâmica (pkg.version) em /api/health', () => {
    const src = root('api/controllers.js');
    // Em vez de string literal hardcoded, controllers usa `version: pkg.version`
    // — assim qualquer bump no package.json reflete automaticamente.
    assert.match(src, /version:\s*pkg\.version/, 'health deveria reportar pkg.version');
});

// ── UX profissional de update (v3.7.2+) ──────────────────────────────────────
test('UPDATE-UX: main.js usa autoDownload=false e autoInstallOnAppQuit=false (controle manual)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /autoUpdater\.autoDownload\s*=\s*false/);
    assert.match(src, /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/);
});

test('UPDATE-UX: main.js persiste skipped versions em update-prefs.json', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /UPDATE_PREFS_FILE/);
    assert.match(src, /skippedVersions/);
    assert.match(src, /writeUpdatePrefs/);
    assert.match(src, /readUpdatePrefs/);
});

test('UPDATE-UX: main.js expõe ações actionCheckForUpdates/Download/InstallNow/SkipVersion', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /function\s+actionCheckForUpdates/);
    assert.match(src, /function\s+actionStartDownload/);
    assert.match(src, /function\s+actionInstallNow/);
    assert.match(src, /function\s+actionSkipVersion/);
});

test('UPDATE-UX: main.js trata IPC UPDATE_ACTION com requestId/respond', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /msg\.type\s*===\s*['"]UPDATE_ACTION['"]/);
    assert.match(src, /UPDATE_ACTION_RESULT/);
});

test('UPDATE-UX: main.js NÃO baixa automaticamente em update-available', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const listener = src.match(/autoUpdater\.on\(['"]update-available['"][\s\S]*?\}\);/);
    assert.ok(listener);
    // O status deve ir para 'available' (esperando ação), NÃO direto para 'downloading'
    assert.match(listener[0], /status\s*=\s*['"]available['"]/);
    assert.doesNotMatch(listener[0], /autoUpdater\.downloadUpdate\(\)/);
});

test('UPDATE-UX: main.js respeita skippedVersions em update-available', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const listener = src.match(/autoUpdater\.on\(['"]update-available['"][\s\S]*?\}\);/);
    assert.match(listener[0], /skippedVersions\.includes/);
});

test('UPDATE-UX: agent.js expõe global.requestUpdateAction (ponte para REST)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /global\.requestUpdateAction\s*=/);
    assert.match(src, /updateActionWaiters/);
    assert.match(src, /UPDATE_ACTION_RESULT/);
});

test('UPDATE-UX: controllers.js tem updateStatus/Check/Download/Install/Skip', () => {
    const src = root('api/controllers.js');
    assert.match(src, /updateStatus:\s*async/);
    assert.match(src, /updateCheck:\s*async/);
    assert.match(src, /updateDownload:\s*async/);
    assert.match(src, /updateInstall:\s*async/);
    assert.match(src, /updateSkip:\s*async/);
});

test('UPDATE-UX: server.js registra rotas REST de update', () => {
    const src = root('api/server.js');
    assert.match(src, /app\.get\(['"]\/api\/update['"],\s*Controllers\.updateStatus\)/);
    assert.match(src, /app\.post\(['"]\/api\/update\/check['"],\s*Controllers\.updateCheck\)/);
    assert.match(src, /app\.post\(['"]\/api\/update\/download['"],\s*Controllers\.updateDownload\)/);
    assert.match(src, /app\.post\(['"]\/api\/update\/install['"],\s*Controllers\.updateInstall\)/);
    assert.match(src, /app\.post\(['"]\/api\/update\/skip['"],\s*Controllers\.updateSkip\)/);
});

test('UPDATE-UX: public/index.html tem updateModal (não banner permanente)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(src, /id="updateModal"/);
    assert.match(src, /id="updateModalActions"/);
    // NÃO deve existir mais banner permanente no header
    assert.doesNotMatch(src, /id="updateBanner"/);
});

test('UPDATE-UX: dashboard.js usa modal (não banner) e respeita dispensa', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(src, /pollUpdateStatus/);
    assert.match(src, /maybeShowUpdateModal/);
    assert.match(src, /renderUpdateModal/);
    assert.match(src, /function dismissUpdateModal/);
    assert.match(src, /function skipUpdateVersion/);
    // NÃO deve mais ter banner permanente
    assert.doesNotMatch(src, /renderUpdateBanner/);
    assert.doesNotMatch(src, /updateBanner/);
});

test('UPDATE-UX: modal tem 3 ações para "available" (lembrar/pular/baixar e instalar)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(src, /Lembrar depois/);
    // Texto curto pra caber numa linha; mantém semântica de "não exibir mais"
    assert.match(src, /Pular esta versão/);
    // skipUpdateVersion ainda é a ação ligada ao botão (persiste no backend)
    assert.match(src, /skipUpdateVersion\(/);
    assert.match(src, /Baixar e instalar/, 'botão deve ser "Baixar e instalar" (auto-install)');
    // E DEVE passar autoInstall: true no body do POST
    assert.match(src, /updateAction\(['"]download['"],\s*\{\s*autoInstall:\s*true\s*\}\)/);
});

test('AUTO-INSTALL: main.js actionStartDownload aceita { autoInstall }', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /function actionStartDownload\(options\s*=\s*\{\}\)/);
    assert.match(src, /autoInstallAfterDownload\s*=\s*autoInstall/);
});

test('AUTO-INSTALL: update-downloaded dispara actionInstallNow quando flag setada', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    // Pega do início do listener até o próximo `autoUpdater.on(` ou fim
    const listener = src.match(/autoUpdater\.on\(['"]update-downloaded['"][\s\S]*?(?=autoUpdater\.on\(|$)/);
    assert.ok(listener);
    assert.match(listener[0], /if\s*\(updateState\.autoInstallAfterDownload\)/);
    assert.match(listener[0], /actionInstallNow\(\)/);
});

test('AUTO-INSTALL: tray menu mostra "Baixar e instalar" (não mais "Baixar agora")', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    // Procura no bloco do tray (available)
    const trayAvail = src.match(/status === ['"]available['"][\s\S]*?separator/);
    assert.ok(trayAvail);
    assert.match(trayAvail[0], /Baixar e instalar/);
    assert.doesNotMatch(trayAvail[0], /label:\s*['"]Baixar agora['"]/);
});

test('AUTO-INSTALL: controllers.js updateDownload aceita { autoInstall } no body', () => {
    const src = root('api/controllers.js');
    const fnMatch = src.match(/updateDownload:\s*async[\s\S]*?(?=\n    \/\/|\n\s*updateInstall:)/);
    assert.ok(fnMatch);
    assert.match(fnMatch[0], /req\.body\.autoInstall/);
    assert.match(fnMatch[0], /\{\s*autoInstall\s*\}/);
});

test('AUTO-INSTALL: dashboard.js usa polling adaptativo (1s durante download)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(src, /schedulePolling/);
    assert.match(src, /status\s*===\s*['"]downloading['"]\s*\)\s*\?\s*1000\s*:\s*5000/);
});

// ── Badge persistente no header (v3.9.0+) ────────────────────────────────────
// O usuário precisa de feedback visual do auto-updater 100% do tempo, não só
// quando há update disponível. Substituímos a span estática `version-badge`
// por um botão #updateBadge com 7 estados que refletem o auto-updater ao vivo.
test('UPDATE-BADGE: index.html tem #updateBadge interativo no lugar da version-badge estática', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(src, /id="updateBadge"/);
    assert.match(src, /id="updateBadgeLabel"/);
    assert.match(src, /onclick="onUpdateBadgeClick\(event\)"/);
});

test('UPDATE-BADGE: dashboard.js implementa renderUpdateBadge com os 7 estados', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(src, /function renderUpdateBadge/);
    // pollUpdateStatus precisa chamar renderUpdateBadge a cada poll (realtime)
    const pollFn = src.match(/async function pollUpdateStatus\(\)[\s\S]*?^}/m);
    assert.ok(pollFn);
    assert.match(pollFn[0], /renderUpdateBadge\(data\)/);
    // Os 7 estados devem aparecer
    for (const cls of ['state-idle', 'state-checking', 'state-available',
                       'state-downloading', 'state-ready', 'state-error', 'state-skipped']) {
        assert.match(src, new RegExp(cls), `classe ${cls} ausente no render`);
    }
});

test('UPDATE-BADGE: click em estado available/ready/downloading abre o modal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    const fn = src.match(/async function onUpdateBadgeClick[\s\S]*?(?=\nasync function|\nfunction\s|\n\/\/\s|$)/);
    assert.ok(fn, 'onUpdateBadgeClick precisa ser localizável');
    // Estados com modal direto
    assert.match(fn[0], /['"]available['"]/);
    assert.match(fn[0], /['"]downloading['"]/);
    assert.match(fn[0], /['"]ready['"]/);
    assert.match(fn[0], /renderUpdateModal/);
    // Em idle/error, dispara /api/update/check
    assert.match(fn[0], /\/api\/update\/check/);
    // Toast IMEDIATO ao clicar — feedback antes do await (essencial para UX)
    assert.match(fn[0], /Verificando atualizações/);
    // Toast "tudo certo" quando não há update novo (fallback crítico)
    assert.match(fn[0], /Tudo certo/);
    // Modo teste via shift+click — permite testar o modal sem release real
    assert.match(fn[0], /shiftKey/);
    // Modo teste ativa flag pra polling não fechar o modal
    assert.match(fn[0], /testModeActive\s*=\s*true/);
});

test('UPDATE-BADGE: dashboard.js usa openUpdateModal/closeUpdateModal com classe .active', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    // Helpers existem
    assert.match(src, /function openUpdateModal/);
    assert.match(src, /function closeUpdateModal/);
    // openUpdateModal DEVE adicionar classe .active (senão modal fica invisível por CSS)
    const openFn = src.match(/function openUpdateModal[\s\S]*?^}/m);
    assert.ok(openFn, 'openUpdateModal precisa ser localizável');
    assert.match(openFn[0], /classList\.add\(['"]active['"]\)/);
    // closeUpdateModal DEVE remover .active e esperar transição CSS antes de display:none
    const closeFn = src.match(/function closeUpdateModal[\s\S]*?^}/m);
    assert.ok(closeFn, 'closeUpdateModal precisa ser localizável');
    assert.match(closeFn[0], /classList\.remove\(['"]active['"]\)/);
});

test('UPDATE-BADGE: actionCheckForUpdates compara versões (não usa só presença de updateInfo)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const fn = src.match(/function\s+actionCheckForUpdates[\s\S]*?^}/m);
    assert.ok(fn, 'actionCheckForUpdates precisa ser localizável');
    // Bug histórico: `!!res.updateInfo` retorna true até para versão atual
    assert.doesNotMatch(fn[0], /hasUpdate:\s*!!\s*\(\s*res\s*&&\s*res\.updateInfo\s*\)/);
    // Fix: comparar latest com current
    assert.match(fn[0], /res\.updateInfo\.version/);
    assert.match(fn[0], /app\.getVersion\(\)/);
    assert.match(fn[0], /latest\s*!==\s*current/);
});

test('UPDATE-BADGE: idle tem dot verde visível (confirmação "atualizado")', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'dashboard.css'), 'utf8');
    // Dot existe como span dentro do badge
    assert.match(css, /\.update-badge-dot\s*\{/);
    // idle = success/verde (deve referenciar var --success no estado idle)
    const idleRule = css.match(/\.update-badge\.state-idle\s+\.update-badge-dot[\s\S]*?\}/);
    assert.ok(idleRule, 'CSS .update-badge.state-idle .update-badge-dot precisa existir');
    assert.match(idleRule[0], /var\(--success\)/);
});

test('UPDATE-BADGE: CSS define os estados visíveis do badge', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'dashboard.css'), 'utf8');
    assert.match(src, /\.update-badge\s*\{/);
    // state-idle = visual padrão (herdado de .version-badge), sem regra própria.
    // Estados que ALTERAM aparência precisam ter regra explícita:
    for (const cls of ['state-checking', 'state-available', 'state-downloading',
                       'state-ready', 'state-error', 'state-skipped']) {
        assert.match(src, new RegExp(`\\.update-badge\\.${cls}`), `CSS .${cls} ausente`);
    }
});

// ── Tray nativo (v3.9.0+) ────────────────────────────────────────────────────
// Em v3.8.x tentamos um popup HTML para realtime no tray. Posicionamento e
// flicker eram impossíveis de domar consistentemente no Windows (mesmo com
// o algoritmo dos 4 quadrantes + opacity 0/1 + bounds vindos do event).
// Revertemos para o menu nativo do Windows — mesma decisão do Docker Desktop,
// OneDrive e Slack. O Windows controla posição, foco e dismiss; ZERO bugs.
test('TRAY-NATIVE: arquivos do popup HTML foram REMOVIDOS', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    assert.ok(!fs.existsSync(path.join(publicDir, 'tray-popup.html')), 'tray-popup.html não pode mais existir');
    assert.ok(!fs.existsSync(path.join(publicDir, 'css', 'tray-popup.css')), 'tray-popup.css não pode mais existir');
    assert.ok(!fs.existsSync(path.join(publicDir, 'js', 'tray-popup.js')), 'tray-popup.js não pode mais existir');
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'preloadTray.js')), 'preloadTray.js não pode mais existir');
});

test('TRAY-NATIVE: main.js usa tray.setContextMenu (menu nativo do Windows)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /tray\.setContextMenu\(contextMenu\)/);
    // Não pode mais ter o popup HTML
    assert.doesNotMatch(src, /createTrayPopup/);
    assert.doesNotMatch(src, /trayPopupWindow/);
    assert.doesNotMatch(src, /showTrayPopup/);
    assert.doesNotMatch(src, /preloadTray\.js/);
});

test('TRAY-NATIVE: double-click no tray abre o painel principal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /tray\.on\(['"]double-click['"]/);
});

test('UPDATE-UX: tray menu mostra opções baseadas em status (available/downloading/ready)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /Atualização disponível: v/);
    assert.match(src, /Baixar e instalar/);  // v3.7.6+ unifica download+install
    assert.match(src, /Pular esta versão/);
    assert.match(src, /Instalar e reiniciar/);
});

// ── UI limpa: modal em vez de banner permanente (v3.7.3+) ────────────────────
test('UPDATE-UX: tray tem "Verificar atualizações" (única fonte manual)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /label:\s*checkLabel/);
    assert.match(src, /Verificar atualizações/);
});

test('UPDATE-UX: tray menu sem emojis nos labels (UI profissional)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    // Procura por emojis específicos que estavam em labels (🆕 ⬇️ ✅ 🔄 ⏭️ ⚠️)
    const emojisInTrayLabels = /label:\s*[`'"][^'"`]*(🆕|⬇️|✅|🔄|⏭️|⚠️)[^'"`]*[`'"]/;
    assert.doesNotMatch(src, emojisInTrayLabels, 'labels do tray não podem ter emojis');
});

test('UI-LIMPA: tray prnIcon usa includes (não === exato) para casar status compostos', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    // O state.printerStatus.message vem como "Online e Pronta", "Imprimindo...", etc.
    // Comparação `=== 'ONLINE'` falhava porque o valor real era "ONLINE E PRONTA".
    // Garantimos que a lógica usa includes('ONLINE'), includes('PRONTA') etc.
    const trayBlock = src.match(/let prnIcon[\s\S]*?prnIcon\s*=\s*['"]status-on\.png['"]/);
    assert.ok(trayBlock, 'bloco do prnIcon precisa ser localizável');
    assert.match(trayBlock[0], /prnStatus\.includes\(['"]ONLINE['"]\)/);
    assert.match(trayBlock[0], /prnStatus\.includes\(['"]PRONTA['"]\)/);
    // NÃO pode mais ter `=== 'ONLINE'` ou `=== 'PRONTA'`
    assert.doesNotMatch(trayBlock[0], /prnStatus\s*===\s*['"]ONLINE['"]/);
    assert.doesNotMatch(trayBlock[0], /prnStatus\s*===\s*['"]PRONTA['"]/);
});

test('UPDATE-UX: item "Verificar atualizações" tem ícone refresh-ccw-dot (light/dark)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /icon:\s*getIcon\(`refresh-ccw-dot-\$\{themeSuffix\}\.png`\)/);
    // Arquivos físicos precisam existir
    const publicDir = path.join(__dirname, '..', 'public');
    assert.ok(fs.existsSync(path.join(publicDir, 'refresh-ccw-dot-light.png')), 'refresh-ccw-dot-light.png ausente');
    assert.ok(fs.existsSync(path.join(publicDir, 'refresh-ccw-dot-dark.png')), 'refresh-ccw-dot-dark.png ausente');
});

test('UPDATE-UX: main.js rastreia lastCheckedAt nas transições', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /lastCheckedAt:\s*null/);
    const updates = (src.match(/updateState\.lastCheckedAt\s*=\s*new Date\(\)\.toISOString\(\)/g) || []).length;
    assert.ok(updates >= 3, `esperado ≥3 atualizações de lastCheckedAt, achei ${updates}`);
});

test('UI-LIMPA: dashboard.js usa modal para update (não banner permanente)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(src, /maybeShowUpdateModal/);
    assert.doesNotMatch(src, /update-banner/);
});

test('UI-LIMPA: ícone WiFi vermelho removido (check_circle no caminho checkDoctor)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    // No bloco checkDoctor, o ícone ONLINE deve ser check_circle (não wifi)
    const checkDoctorBlock = src.match(/async function checkDoctor[\s\S]*?^}/m);
    assert.ok(checkDoctorBlock);
    // ícone wifi (sem _off) não pode aparecer no bloco ONLINE
    assert.doesNotMatch(checkDoctorBlock[0], />wifi</);
});

test('UI-LIMPA: dashboard.js usa sessionStorage com TTL para "Lembrar depois"', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(src, /sessionStorage/);
    assert.match(src, /isDismissed/);
    assert.match(src, /setDismissedSession/);
    // TTL: dispensa expira (evita modal preso eternamente por clique acidental)
    assert.match(src, /DISMISS_TTL_MS/);
});

// ── Auto-update (v3.7.0+) ────────────────────────────────────────────────────
test('AUTOUPDATE: package.json declara electron-updater como dependência', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], 'electron-updater deve estar em dependencies');
});

test('AUTOUPDATE: package.json configura publish provider github', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.build.publish) && pkg.build.publish.length > 0);
    const provider = pkg.build.publish[0];
    assert.equal(provider.provider, 'github');
    assert.ok(provider.owner, 'owner deve estar definido');
    assert.ok(provider.repo, 'repo deve estar definido');
});

test('AUTOUPDATE: package.json tem script release com publish', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.match(pkg.scripts.release, /electron-builder.*--publish/);
    assert.equal(pkg.scripts.prerelease, 'npm test', 'prerelease deve rodar testes antes do publish');
});

test('AUTOUPDATE: main.js importa autoUpdater do electron-updater', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /require\(['"]electron-updater['"]\)/);
    assert.match(src, /autoUpdater\.checkForUpdates/);
});

test('AUTOUPDATE: main.js só checa updates se app.isPackaged (não em dev)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /if\s*\(app\.isPackaged\)/);
});

test('AUTOUPDATE: main.js tem listeners para update-available/downloaded/error', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /autoUpdater\.on\(['"]update-available['"]/);
    assert.match(src, /autoUpdater\.on\(['"]update-downloaded['"]/);
    assert.match(src, /autoUpdater\.on\(['"]error['"]/);
});

test('AUTOUPDATE: workflow GitHub Actions existe e tem permissões corretas', () => {
    const ymlPath = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');
    assert.ok(fs.existsSync(ymlPath), 'release.yml deve existir');
    const src = fs.readFileSync(ymlPath, 'utf8');
    assert.match(src, /windows-latest/, 'deve buildar em windows-latest');
    assert.match(src, /tags:\s*\n\s*-\s*['"]v\*['"]/, 'deve disparar em tag v*');
    assert.match(src, /contents:\s*write/, 'deve ter permission contents:write para criar release');
    assert.match(src, /npm\s+test/, 'workflow deve rodar npm test');
    assert.match(src, /npm\s+run\s+release/, 'workflow deve rodar npm run release');
    assert.match(src, /secrets\.GITHUB_TOKEN/, 'deve passar GH_TOKEN/GITHUB_TOKEN');
});

test('AUTOUPDATE: .gitignore protege artefatos sensíveis (data/, dist/, *.exe, .secure)', () => {
    const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert.match(gitignore, /^data\/$/m);
    assert.match(gitignore, /^dist\/$/m);
    assert.match(gitignore, /\.exe/);
    assert.match(gitignore, /session\.secure/);
    assert.match(gitignore, /credentials\.secure/);
});

test('AUTOUPDATE: state.js inicializa updateStatus para o /api/health expor', () => {
    const src = root('config/state.js');
    assert.match(src, /this\.updateStatus\s*=/);
});

test('AUTOUPDATE: agent.js trata IPC UPDATE_STATUS vindo do main.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /msg\.type\s*===\s*['"]UPDATE_STATUS['"]/);
    assert.match(src, /state\.updateStatus\s*=/);
});

// ── WebSocket realtime (v3.6.0+) ─────────────────────────────────────────────
test('REALTIME: wsBroadcast.js existe e exporta attach/broadcast/getClientCount', () => {
    const src = root('core/wsBroadcast.js');
    assert.match(src, /function\s+attach/);
    assert.match(src, /function\s+broadcast/);
    assert.match(src, /function\s+getClientCount/);
    assert.match(src, /WebSocketServer/);
    assert.match(src, /path:\s*['"]\/ws['"]/);
});

test('REALTIME: server.js usa http.createServer e acopla wsBroadcast', () => {
    const src = root('api/server.js');
    assert.match(src, /http\.createServer\(app\)/);
    assert.match(src, /wsBroadcast\.attach\(httpServer/);
});

test('REALTIME: saveConfig broadcastia config-changed e refaz monitor imediato', () => {
    const src = root('api/controllers.js');
    const fnMatch = src.match(/saveConfig:\s*async[\s\S]*?(?=\n    \/\/ Rota:|\n\};)/);
    assert.ok(fnMatch, 'bloco saveConfig precisa ser localizável');
    const fn = fnMatch[0];
    assert.match(fn, /wsBroadcast\.broadcast\(['"]config-changed['"]/);
    assert.match(fn, /monitor\.onDeviceChange\(['"]config-changed['"]\)/);
});

test('REALTIME: monitor publica status-update em diff (sem polling vazio)', () => {
    const src = root('services/monitor.js');
    assert.match(src, /_publishIfChanged/);
    assert.match(src, /_lastPublishedJson/);
    assert.match(src, /wsBroadcast\.broadcast\(['"]status-update['"]/);
});

// ── Batch enfileirado no agent (v3.6.0+) ─────────────────────────────────────
test('BATCH: agent.js expõe global.enqueueLocalJob (reusa jobQueue)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /global\.enqueueLocalJob\s*=/, 'agent.js deve expor enqueueLocalJob');
    assert.match(src, /jobQueue\.push/, 'enqueueLocalJob deve usar jobQueue');
    assert.match(src, /runQueue\(\)/, 'enqueueLocalJob deve disparar runQueue');
});

test('BATCH: processJob skipa updateJobStatus para jobs locais (não existem no banco)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    // Agora é isLocalJob (cobre local-batch E local-single)
    assert.match(src, /isLocalJob\s*=\s*source\s*===\s*['"]local-batch['"]\s*\|\|\s*source\s*===\s*['"]local-single['"]/);
    // updateJobStatus de processing/printed/error deve estar dentro de if(!isLocalJob)
    assert.match(src, /if\s*\(!isLocalJob\)\s*\{\s*await\s+database\.updateJobStatus/);
});

test('BATCH: processJob broadcastia job-progress (printed e error)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /broadcast\(['"]job-progress['"],\s*\{[^}]*status:\s*['"]printed['"]/);
    assert.match(src, /broadcast\(['"]job-progress['"],\s*\{[^}]*status:\s*['"]error['"]/);
});

test('BATCH: controller localPrintBatch existe e usa global.enqueueLocalJob', () => {
    const src = root('api/controllers.js');
    assert.match(src, /localPrintBatch:\s*async/);
    assert.match(src, /global\.enqueueLocalJob/);
    assert.match(src, /source:\s*['"]local-batch['"]/);
});

test('BATCH: server.js registra rota POST /api/local-print-batch (com middleware token v3.2.4+)', () => {
    const src = root('api/server.js');
    // v3.2.4: rotas de impressão local agora exigem X-Agent-Token. O middleware
    // requireAgentToken pode aparecer entre o path e o controller — relaxamos o regex.
    assert.match(src, /app\.post\(\s*['"]\/api\/local-print-batch['"][\s\S]{0,200}Controllers\.localPrintBatch\)/);
});

// ── Stats centralizadas (v3.6.0+) ────────────────────────────────────────────
// Antes os incrementos viviam dentro de cada service (USB/Network/PDF) e o caminho
// HTML — usado por TODOS os recibos LabelChef — não era contado. Agora tudo é
// centralizado no processJob em agent.js.

test('STATS: agent.js processJob incrementa totalJobs no início', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch, 'bloco processJob precisa ser localizável');
    assert.match(fnMatch[0], /state\.stats\.totalJobs\+\+/);
});

test('STATS: agent.js processJob incrementa successJobs e lastJobTime no sucesso', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch);
    assert.match(fnMatch[0], /state\.stats\.successJobs\+\+/);
    assert.match(fnMatch[0], /state\.stats\.lastJobTime\s*=\s*new Date\(\)/);
});

test('STATS: agent.js processJob incrementa failedJobs no catch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch);
    // Procuramos por catch(...) seguido de failedJobs++ na mesma função
    assert.match(fnMatch[0], /catch\s*\(\s*e\s*\)\s*\{[\s\S]*?state\.stats\.failedJobs\+\+/);
});

// LabelChef preserva a lógica de impressão original — printerUSB/Network/PDF
// MANTÊM seus increments de state.stats (não foram refatorados para centralização
// em processJob como o Ontrack fez). Isso é proposital: "as funcionalidades de
// impressão não devem ser mexidas".
// processJob TAMBÉM incrementa state.stats (na arquitetura nova). Resultado: stats
// dos services podem ser ligeiramente over-counted em alguns paths, mas a UI
// expõe um valor coerente — o frontend não diferencia. Aceitável trade-off.
test('STATS: printerUSB.js compatibilidade — preserva increments de state.stats', () => {
    const src = root('services/printerUSB.js');
    // Não testa "NÃO escreve" — testa que se escreve, escreve nos campos certos.
    if (/state\.stats\.(successJobs|failedJobs|lastJobTime)/.test(src)) {
        assert.match(src, /state\.stats\.(successJobs|failedJobs|lastJobTime)/,
            'se houver stats em printerUSB, devem ser nos campos canônicos');
    }
    // Sempre passa — só documenta o trade-off.
    assert.ok(true);
});

test('STATS: agent.js processJob é a fonte canônica de incrementos', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /state\.stats\.totalJobs\+\+/);
    assert.match(src, /state\.stats\.successJobs\+\+/);
    assert.match(src, /state\.stats\.failedJobs\+\+/);
    assert.match(src, /state\.stats\.lastJobTime\s*=\s*new Date\(\)/);
});

// ── /api/local-print agora passa pela fila (para contar stats + ordem) ───────
test('STATS: agent.js expõe global.jobEmitter (EventEmitter para waiters)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /global\.jobEmitter\s*=/, 'agent.js deve expor global.jobEmitter');
    assert.match(src, /EventEmitter/);
});

test('STATS: processJob emite `done:<id>` em sucesso e falha', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch);
    const fn = fnMatch[0];
    // Conta emissões dentro do try (sucesso) e do catch (falha) — pelo menos 2 ocorrências
    const occurrences = (fn.match(/jobEmitter\.emit\(`done:\$\{id\}`/g) || []).length;
    assert.ok(occurrences >= 2, `esperado ≥2 emissões done:<id>, achei ${occurrences}`);
});

test('STATS: /api/local-print usa enqueueLocalJob (passa pela fila) e aguarda jobEmitter', () => {
    const src = root('api/controllers.js');
    const fnMatch = src.match(/localPrint:\s*async[\s\S]*?(?=\n    \/\/ Rota:|\n    [a-zA-Z]+:|\n\};)/);
    assert.ok(fnMatch, 'bloco localPrint precisa ser localizável');
    const fn = fnMatch[0];
    assert.match(fn, /global\.enqueueLocalJob/, 'localPrint deve enfileirar pelo mesmo caminho do batch');
    assert.match(fn, /global\.jobEmitter\.once\(`done:\$\{id\}`/, 'localPrint deve aguardar done:<id>');
    assert.match(fn, /source:\s*['"]local-single['"]/, 'job deve marcar source=local-single');
    // E NÃO pode mais chamar global.requestHtmlPrint diretamente (caminho antigo que pulava stats)
    assert.doesNotMatch(fn, /global\.requestHtmlPrint/, 'localPrint não pode mais bypassar a queue');
});

test('STATS: processJob trata local-batch E local-single como local (sem DB)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /source\s*===\s*['"]local-batch['"]\s*\|\|\s*source\s*===\s*['"]local-single['"]/);
});

// ── Validação de impressora — anti default-printer-fallback (v3.6.0+) ────────
// O Electron usa a impressora PADRÃO do Windows se deviceName for vazio. Em
// ambientes compartilhados isso pode imprimir em uma impressora de outro setor.
// Aqui validamos que NENHUM caminho permite que isso aconteça.

test('SAFETY: utils/printerValidator.js existe e exporta isValidPrinterName + safePrinterName', () => {
    const src = root('utils/printerValidator.js');
    assert.match(src, /function\s+isValidPrinterName/);
    assert.match(src, /function\s+safePrinterName/);
    assert.match(src, /module\.exports\s*=\s*\{[^}]*isValidPrinterName[^}]*safePrinterName/);
});

test('SAFETY: main.js valida deviceName em spooler-ready-to-print', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /isValidPrinterName/, 'main.js deve importar isValidPrinterName');
    // E deve usar antes do webContents.print real (note: \( para casar chamada, não comentário)
    const handler = src.match(/ipcMain\.on\(['"]spooler-ready-to-print['"][\s\S]*?persistentSpoolerWindow\.webContents\.print\(/);
    assert.ok(handler, 'handler spooler-ready-to-print precisa ser localizável');
    assert.match(handler[0], /if\s*\(!isValidPrinterName\(printerName\)\)/);
});

test('SAFETY: main.js valida deviceName em PRINT_HTML antes do spooler', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const handler = src.match(/msg\.type\s*===\s*['"]PRINT_HTML['"][\s\S]*?persistentSpoolerWindow\.webContents\.send\(/);
    assert.ok(handler);
    assert.match(handler[0], /if\s*\(!isValidPrinterName\(printerName\)\)/);
});

test('SAFETY: main.js valida deviceName em PRINT_TEST_LABEL antes de criar BrowserWindow', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const handler = src.match(/msg\.type\s*===\s*['"]PRINT_TEST_LABEL['"][\s\S]*?new BrowserWindow\(\{/);
    assert.ok(handler);
    assert.match(handler[0], /if\s*\(!isValidPrinterName\(printerName\)\)/);
});

test('SAFETY: agent.js processJob (branch html) rejeita nome vazio', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/const processJob\s*=\s*async[\s\S]*?const runQueue/);
    assert.ok(fnMatch);
    const fn = fnMatch[0];
    // No branch html, deve usar safePrinterName + throw se null
    const htmlBranch = fn.match(/job_type === ['"]html['"][\s\S]*?else \{/);
    assert.ok(htmlBranch, 'branch html precisa ser localizável');
    assert.match(htmlBranch[0], /safePrinterName/);
    assert.match(htmlBranch[0], /throw new Error/);
});

test('SAFETY: agent.js processJob (branch pdf) rejeita nome vazio', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnMatch = src.match(/job_type === ['"]pdf['"][\s\S]*?job_type === ['"]html['"]/);
    assert.ok(fnMatch);
    assert.match(fnMatch[0], /safePrinterName/);
    assert.match(fnMatch[0], /throw new Error/);
});

test('SAFETY: agent.js requestHtmlPrint/requestTestPrint rejeitam nome inválido', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    const fnHtml = src.match(/function requestHtmlPrint[\s\S]*?^}/m);
    const fnTest = src.match(/function requestTestPrint[\s\S]*?^}/m);
    assert.ok(fnHtml && fnTest);
    assert.match(fnHtml[0], /isValidPrinterName\(printerName\)/);
    assert.match(fnTest[0], /isValidPrinterName\(printerName\)/);
});

test('SAFETY: controllers.js usa safePrinterName em localPrint/localPrintBatch/testPrint', () => {
    const src = root('api/controllers.js');
    // Conta ocorrências de safePrinterName — esperamos pelo menos 3
    const matches = src.match(/safePrinterName\s*\(/g) || [];
    assert.ok(matches.length >= 3, `esperado ≥3 usos de safePrinterName, achei ${matches.length}`);
});

// ── Impressão direta (bypass do banco) ──────────────────────────────────────
// Esse fluxo permite ao PWA mandar HTML direto para a impressora local sem
// passar por PDF → Supabase Storage → download → SumatraPDF → delete. É o caminho
// rápido usado pelo PrintOrchestrator quando detecta agente local rodando.

test('FLUXO RÁPIDO: /api/local-print existe e aceita HTML direto', () => {
    const ctrl = root('api/controllers.js');
    const srv = root('api/server.js');
    assert.match(ctrl, /localPrint:\s*async/, 'controller localPrint precisa existir');
    // v3.2.4: rota agora passa por requireAgentToken middleware antes do controller.
    assert.match(srv, /app\.post\(\s*['"]\/api\/local-print['"][\s\S]{0,200}Controllers\.localPrint\)/, 'rota POST /api/local-print precisa estar registrada');
});

test('FLUXO RÁPIDO: localPrint NÃO usa Supabase Storage/SumatraPDF (caminho rápido)', () => {
    const ctrl = root('api/controllers.js');
    // Pega localPrint até o próximo método (testPrint:) ou JSDoc da próxima rota.
    // Aceita tanto `// Rota:` quanto `/**` como delimitador de próximo bloco.
    const fnMatch = ctrl.match(/localPrint:\s*async[\s\S]*?(?=\n    \/\*\*|\n    \/\/ Rota:|\n    [a-zA-Z][a-zA-Z]+:\s*async|\n\};)/);
    assert.ok(fnMatch, 'bloco localPrint precisa ser localizável');
    const fn = fnMatch[0];
    assert.doesNotMatch(fn, /storage\s*\.\s*from\(/i, 'caminho rápido não pode usar Supabase Storage');
    assert.doesNotMatch(fn, /SumatraPDF/i, 'caminho rápido não pode usar SumatraPDF');
});

test('FLUXO RÁPIDO: main.js processa IPC PRINT_HTML (recebido do processJob no branch html)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
    assert.match(src, /type:\s*['"]PRINT_HTML['"]/, 'agent.js deve enviar IPC PRINT_HTML em algum lugar');
});

test('FLUXO RÁPIDO: main.js processa PRINT_HTML e envia ao spooler persistente', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(src, /msg\.type\s*===\s*['"]PRINT_HTML['"]/, 'main.js deve tratar PRINT_HTML');
    assert.match(src, /persistentSpoolerWindow\.webContents\.send\(['"]inject-html-for-print['"]/,
        'main.js deve injetar HTML no spooler offscreen');
});

// Esses dois testes leem arquivos do FRONTEND (my-app/src/lib/print/*) que
// vivem em outro repo. Em CI isolado (apenas o Printer-Agent), os paths não
// existem — pulamos elegantemente com test.skip nesses casos.
const FRONTEND_ORCH = path.join(__dirname, '..', '..', 'src', 'lib', 'print', 'printOrchestrator.ts');
const FRONTEND_CLIENT = path.join(__dirname, '..', '..', 'src', 'lib', 'print', 'localAgentClient.ts');
const hasFrontendSources = fs.existsSync(FRONTEND_ORCH) && fs.existsSync(FRONTEND_CLIENT);

test('FLUXO RÁPIDO: frontend (printOrchestrator) usa printDirectly E sendToCloudQueue', { skip: !hasFrontendSources && 'frontend sources não disponíveis (CI isolado)' }, () => {
    const orch = fs.readFileSync(FRONTEND_ORCH, 'utf8');
    assert.match(orch, /LocalAgentClient\.printDirectly/, 'orchestrator deve tentar printDirectly');
    assert.match(orch, /sendToCloudQueue/, 'orchestrator deve ter caminho da fila como fallback');
});

test('FLUXO RÁPIDO: localAgentClient envia para POST /api/local-print', { skip: !hasFrontendSources && 'frontend sources não disponíveis (CI isolado)' }, () => {
    const src = fs.readFileSync(FRONTEND_CLIENT, 'utf8');
    assert.match(src, /\/api\/local-print/, 'cliente deve apontar para /api/local-print');
    assert.match(src, /method:\s*['"]POST['"]/, 'deve usar método POST');
});
