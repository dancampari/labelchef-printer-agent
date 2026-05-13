const net = require('net');
const logger = require('../utils/logger');
const state = require('../config/state');
const pshost = require('../core/pshost');

/**
 * Monitor enxuto.
 *
 * Antes: 3 spawns de powershell.exe a cada 5s (~17 mil/dia).
 * Agora:
 *  - PSHost persistente (1 powershell.exe vivo) executa todas as queries WMI.
 *  - Cache TTL: o frontend lê o printerStatus em pull; revalidar a cada 60s basta.
 *  - Pré-impressão e on-demand chamam refresh() explicitamente.
 *  - Plug/unplug global vem do WM_DEVICECHANGE do Electron via IPC ('DEVICE_CHANGE'),
 *    e dispara apenas UM refresh em vez de scan periódico.
 *
 * Rede continua TCP socket puro (já era leve, sem PowerShell).
 */

const REFRESH_INTERVAL_MS = 60_000;
const NETWORK_TIMEOUT_MS = 2_000;

class Monitor {
    constructor() {
        this.timer = null;
        this.knownPrinters = new Map();   // name → WorkOffline
        this.lastHostAddress = { name: null, ip: null }; // cache da porta da impressora USB
        this.lastNetworkState = null;
        this.refreshing = false;
        this._lastPublishedJson = null;   // snapshot publicado via WS (para diff)
    }

    start() {
        if (this.timer) clearInterval(this.timer);
        logger.info('MONITOR', 'Iniciando monitor enxuto (PSHost + tick 60s + events).');

        // Pré-aquece o PSHost
        pshost.start();

        this.timer = setInterval(() => this.refresh().catch(() => {}), REFRESH_INTERVAL_MS);
        // Primeiro ciclo imediato
        this.refresh().catch(() => {});
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Chamado pelo agent.js antes de cada impressão e quando o Electron
     * envia DEVICE_CHANGE. Faz 1 refresh único (sem polling).
     */
    async onDeviceChange(reason = 'manual') {
        logger.info('MONITOR', `Trigger de refresh externo: ${reason}`);
        return this.refresh();
    }

    async refresh() {
        if (this.refreshing) return;
        this.refreshing = true;
        try {
            // 1) Scan USB global — só pra detectar plug/unplug e ajustar cache
            await this._scanUsbGlobal();

            // 2) Status da impressora configurada
            if (state.currentConfig.printerType === 'network') {
                await this._refreshNetwork();
            } else if (state.currentConfig.printerName) {
                await this._refreshUsb();
            }

            // 3) Push WS para o frontend se algo mudou (diff vs último broadcast)
            this._publishIfChanged();
        } catch (e) {
            logger.error('MONITOR', 'erro em refresh', e.message);
        } finally {
            this.refreshing = false;
        }
    }

    /**
     * Empurra o estado atual para os clientes WS quando ele difere do último
     * publicado. Isso transforma a UI em quase-realtime para conexão/
     * desconexão de impressora sem precisar do ciclo de 60s do frontend.
     */
    _publishIfChanged() {
        try {
            const snapshot = {
                isOnline: !!state.printerStatus.isOnline,
                message: state.printerStatus.message,
                pendingJobs: state.printerStatus.pendingJobs || 0,
                isBusy: !!state.printerStatus.isBusy,
                lastCheck: state.printerStatus.lastCheck,
                printerName: state.currentConfig.printerName || state.currentConfig.printerIdentifier || null,
                printerType: state.currentConfig.printerType || null,
            };
            const json = JSON.stringify(snapshot);
            if (json === this._lastPublishedJson) return;
            this._lastPublishedJson = json;

            // require lazy: evita ciclo Server.start() ↔ monitor
            const wsBroadcast = require('../core/wsBroadcast');
            wsBroadcast.broadcast('status-update', snapshot);
        } catch (e) {
            logger.warn('MONITOR', 'falha ao publicar status via WS', e.message);
        }
    }

    // ── USB global (plug/unplug) ────────────────────────────────────────────
    async _scanUsbGlobal() {
        try {
            const printers = await pshost.runJson(
                `Get-WmiObject -Class Win32_Printer | Where-Object { $_.PortName -like "USB*" } | Select-Object Name,WorkOffline,PrinterStatus`
            );
            const list = Array.isArray(printers) ? printers : (printers ? [printers] : []);
            const currentNames = new Set(list.map((p) => p.Name));

            for (const p of list) {
                const prev = this.knownPrinters.get(p.Name);
                if (prev === undefined) {
                    this.knownPrinters.set(p.Name, p.WorkOffline);
                    logger.info('MONITOR', `Impressora USB detectada: "${p.Name}"`);
                    if (p.WorkOffline === false) {
                        this._notify('Impressora Conectada', `"${p.Name}" identificada.`);
                    }
                } else if (prev !== p.WorkOffline) {
                    this.knownPrinters.set(p.Name, p.WorkOffline);
                    if (p.WorkOffline) {
                        logger.info('MONITOR', `USB OFFLINE: "${p.Name}"`);
                        this._notify('Impressora Desconectada', `"${p.Name}" parou de responder.`, true);
                    } else {
                        logger.info('MONITOR', `USB ONLINE: "${p.Name}"`);
                        this._notify('Impressora Reconectada', `"${p.Name}" voltou a responder.`);
                    }
                }
            }

            for (const name of this.knownPrinters.keys()) {
                if (!currentNames.has(name)) {
                    this.knownPrinters.delete(name);
                    logger.info('MONITOR', `Impressora removida: "${name}"`);
                }
            }
        } catch (e) {
            logger.warn('MONITOR', 'scan USB global falhou', e && e.message ? e.message : (e && e.stack ? e.stack : String(e)));
        }
    }

    // ── USB da impressora configurada ───────────────────────────────────────
    async _refreshUsb() {
        const name = state.currentConfig.printerName;
        try {
            const status = await this._getUsbStatus(name);
            if (!status) {
                state.printerStatus.isOnline = false;
                state.printerStatus.message = 'Não encontrada / Erro Driver';
                state.printerStatus.lastCheck = new Date();
                return;
            }

            // PrinterStatus enum: 3=Idle, 4=Printing, 5=WarmingUp
            const hardwareOk = status.PrinterStatus === 3 || status.PrinterStatus === 4 || status.PrinterStatus === 5;
            const offline = status.WorkOffline === true;

            // Override: se a impressora USB tem porta TCP (rede via Windows), faz ping
            if (status.HostAddress) {
                const reachable = await this._tcpPing(status.HostAddress, 9100);
                state.printerStatus.isOnline = reachable && !offline;
            } else {
                state.printerStatus.isOnline = hardwareOk && !offline;
            }

            state.printerStatus.pendingJobs = status.JobCount || 0;
            state.printerStatus.isBusy = (status.JobCount || 0) > 0;
            state.printerStatus.lastCheck = new Date();
            state.printerStatus.message = state.printerStatus.isOnline
                ? (status.PrinterStatus === 4 ? 'Imprimindo...' : 'Online e Pronta')
                : (offline ? 'Offline (Pausada/Cabo)' : `Status Anormal (${status.PrinterStatus})`);
        } catch (e) {
            logger.error('MONITOR', `erro USB "${name}"`, e.message);
            state.printerStatus.isOnline = false;
            state.printerStatus.message = 'Não encontrada / Erro Driver';
            state.printerStatus.lastCheck = new Date();
        }
    }

    /**
     * 1 query única que devolve status + jobs + HostAddress da porta.
     * Substitui as 3 chamadas anteriores (getPrinterStatus, getPrinterHostAddress, Get-PrintJob).
     */
    async _getUsbStatus(printerName) {
        // PowerShell escape simples — sanitização extra é feita acima
        const safe = printerName.replace(/'/g, "''");

        // Atenção: $host é variável automática read-only do PowerShell (objeto Host
        // do shell). Por isso usamos $portHost.
        const cmd = `
$p = Get-WmiObject -Class Win32_Printer -Filter "Name='${safe}'" -ErrorAction SilentlyContinue
if (-not $p) { $null } else {
  $j = @(Get-PrintJob -PrinterName '${safe}' -ErrorAction SilentlyContinue)
  $portHost = $null
  try {
    $port = Get-Printer -Name '${safe}' -ErrorAction SilentlyContinue | Get-PrinterPort -ErrorAction SilentlyContinue
    if ($port -and $port.PrinterHostAddress -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$') { $portHost = $port.PrinterHostAddress }
  } catch {}
  [PSCustomObject]@{
    Name = $p.Name
    PrinterStatus = $p.PrinterStatus
    WorkOffline = $p.WorkOffline
    JobCount = $j.Count
    HostAddress = $portHost
  }
}`.trim();

        return pshost.runJson(cmd);
    }

    // ── Rede (TCP puro, sem PowerShell) ─────────────────────────────────────
    async _refreshNetwork() {
        const id = state.currentConfig.printerIdentifier || state.currentConfig.printerIp;
        if (!id) return;

        let ip = id, port = 9100;
        if (id.includes(':')) {
            const [a, b] = id.split(':');
            ip = a;
            port = parseInt(b, 10) || 9100;
        }

        const online = await this._tcpPing(ip, port);
        if (this.lastNetworkState !== online) {
            logger.info('MONITOR', `Impressora rede ${ip}:${port} ${online ? 'ONLINE' : 'OFFLINE'}`);
            this.lastNetworkState = online;
        }

        state.printerStatus.isOnline = online;
        state.printerStatus.pendingJobs = 0;
        state.printerStatus.lastCheck = new Date();
        state.printerStatus.message = online ? 'Online e Pronta' : 'Offline ou Inacessível';
        state.printerStatus.isBusy = false;
    }

    _tcpPing(ip, port = 9100, timeout = NETWORK_TIMEOUT_MS) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(timeout);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
            socket.connect(port, ip);
        });
    }

    _notify(title, body, critical = false) {
        if (process.send) {
            process.send({
                type: 'NOTIFICATION',
                title, body,
                urgency: critical ? 'critical' : 'normal'
            });
        }
    }
}

module.exports = new Monitor();
