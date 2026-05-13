const state = require('../config/state');
const auth = require('../core/auth');
const agentToken = require('../core/agentToken');
const database = require('../core/database');
const printerUSB = require('../services/printerUSB');
const printerPDF = require('../services/printerPDF');
const socket = require('../core/socket');
const logger = require('../utils/logger');
const pshost = require('../core/pshost');
const wsBroadcast = require('../core/wsBroadcast');
const { safePrinterName, isValidPrinterName } = require('../utils/printerValidator');
const pkg = require('../../package.json');

// Cache leve para /api/printers — evita PowerShell em cada poll do frontend.
const PRINTERS_CACHE_TTL_MS = 30_000;
let printersCache = { at: 0, list: null };

const Controllers = {
    // Middleware de Autenticação
    requireAuth: (req, res, next) => {
        if (!state.isAuthenticated()) {
            return res.status(401).json({ error: 'Não autenticado' });
        }
        next();
    },

    // Rota: POST /login
    login: async (req, res) => {
        const { email, password, remember } = req.body;
        try {
            const success = await auth.login(email, password);
            if (success) {
                state.explicitLogout = false;

                if (remember) {
                    await auth.saveCredentials(email, password);
                } else {
                    await auth.clearCredentials();
                }

                const hasConfig = await database.syncConfig();
                if (hasConfig) {
                    socket.connect();
                    socket.startPolling();
                    const monitor = require('../services/monitor');
                    monitor.start();
                }
                // SECURITY (v3.2.4): publica o agent_token p/ o frontend autenticado
                // pegar via printer_settings e mandar em X-Agent-Token.
                try {
                    const token = await agentToken.ensureToken();
                    await database.syncAgentToken(token);
                } catch (e) {
                    logger.warn('AUTH', 'Falha ao sincronizar agent_token (login):', e.message);
                }
                res.json({ ok: true, companyId: state.companyId });
            } else {
                res.status(401).json({ ok: false, error: 'Credenciais inválidas ou usuário sem empresa.' });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // REMOVIDO em v3.2.3 (security audit): expunha senha em cleartext via HTTP
    // local. Qualquer processo na máquina conseguia fazer GET no endpoint e
    // capturar email+senha. Auto-login agora usa exclusivamente o session.secure
    // criptografado via safeStorage/DPAPI (tryAutoLogin abaixo).
    //
    // getSavedCredentials: <removed — DO NOT REINTRODUCE>,

    tryAutoLogin: async (req, res) => {
        try {
            if (state.explicitLogout) {
                logger.info('AUTH', 'Auto-login bloqueado: logout explícito ativo.');
                return res.json({ ok: false, reason: 'explicit_logout' });
            }

            const creds = await auth.loadCredentials();
            if (!creds || !creds.email || !creds.password) {
                return res.json({ ok: false, reason: 'no_credentials' });
            }

            logger.info('AUTH', `Tentando auto-login para: ${creds.email}`);

            const success = await auth.login(creds.email, creds.password);
            if (success) {
                const hasConfig = await database.syncConfig();
                if (hasConfig) {
                    socket.connect();
                    socket.startPolling();
                    const monitor = require('../services/monitor');
                    monitor.start();
                }
                // SECURITY (v3.2.4): mesma sync de token no path de auto-login.
                try {
                    const token = await agentToken.ensureToken();
                    await database.syncAgentToken(token);
                } catch (e) {
                    logger.warn('AUTH', 'Falha ao sincronizar agent_token (auto-login):', e.message);
                }
                logger.info('AUTH', 'Auto-login bem-sucedido.');
                res.json({ ok: true, companyId: state.companyId });
            } else {
                logger.warn('AUTH', 'Auto-login falhou - credenciais inválidas.');
                res.json({ ok: false, reason: 'invalid_credentials' });
            }
        } catch (e) {
            logger.error('AUTH', 'Erro no auto-login:', e.message);
            res.json({ ok: false, reason: 'error', error: e.message });
        }
    },

    logout: async (req, res) => {
        try {
            await auth.logout();
            state.explicitLogout = true;
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: GET /api/health (público) — probe leve para detecção do agent.
    health: (req, res) => {
        res.json({
            status: 'ok',
            version: pkg.version,
            authenticated: state.isAuthenticated(),
            printerConfigured: !!(state.currentConfig.printerName || state.currentConfig.printerIdentifier),
            defaultPrinter: state.currentConfig.printerName || state.currentConfig.printerIdentifier || null,
            printerOnline: state.printerStatus ? !!state.printerStatus.isOnline : false,
            connStatus: state.connStatus,
            update: state.updateStatus || { status: 'idle' },
        });
    },

    // Rota: GET /api/status
    getStatus: (req, res) => {
        const safeConfig = { ...state.currentConfig };

        const now = new Date();
        const start = state.stats.startTime ? new Date(state.stats.startTime) : now;
        state.stats.uptime = Math.floor((now - start) / 1000);

        res.json({
            status: state.connStatus,
            config: safeConfig,
            company: state.companyId,
            companyName: state.companyName,
            printerStatus: state.printerStatus,
            stats: state.stats,
            logs: logger.getBuffer()
        });
    },

    // Rota: POST /config
    saveConfig: async (req, res) => {
        const { printerType, printerName, printerIp, printerPort, printerNickname } = req.body;

        if (printerType !== 'usb' && printerType !== 'network') {
            return res.status(400).json({ ok: false, error: 'printerType inválido (esperado: usb | network)' });
        }

        if (printerType === 'usb' && !isValidPrinterName(printerName)) {
            logger.warn('CONFIG', `printerName USB rejeitado pelo validator: "${printerName}"`);
            return res.status(400).json({ ok: false, error: 'Nome de impressora inválido' });
        }

        if (printerType === 'network') {
            const ipOk = typeof printerIp === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(printerIp);
            if (!ipOk) {
                return res.status(400).json({ ok: false, error: 'IP da impressora inválido' });
            }
        }

        const newConfig = {
            printerType,
            printerName: printerType === 'usb' ? printerName : (printerNickname || 'Impressora de Rede')
        };

        if (printerType === 'network') {
            if (printerPort && printerPort !== '9100') {
                newConfig.printerIdentifier = `${printerIp}:${printerPort}`;
            } else {
                newConfig.printerIdentifier = printerIp;
            }
        } else {
            newConfig.printerIdentifier = printerName;
        }

        try {
            await database.saveConfig(newConfig);
            socket.connect();

            // Notifica clientes WS imediatamente — frontend atualiza badge em <200ms.
            wsBroadcast.broadcast('config-changed', { config: state.currentConfig });

            // Dispara refresh real do monitor sem esperar tick de 60s
            const monitor = require('../services/monitor');
            monitor.onDeviceChange('config-changed').catch(() => {});

            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // Rota: GET /api/printers — usa PSHost + cache 30s (sem spawn de PowerShell).
    getPrinters: async (req, res) => {
        const now = Date.now();
        if (printersCache.list && (now - printersCache.at) < PRINTERS_CACHE_TTL_MS) {
            return res.json(printersCache.list);
        }
        try {
            const result = await pshost.runJson(`Get-Printer | Select-Object Name`);
            const list = Array.isArray(result) ? result : (result ? [result] : []);
            printersCache = { at: now, list };
            res.json(list);
        } catch (e) {
            logger.warn('API', '/api/printers falhou', e.message);
            res.json([]);
        }
    },

    // Rota: GET /api/doctor/diagnose
    diagnose: async (req, res) => {
        const printerStatus = state.printerStatus || { isOnline: false, pendingJobs: 0 };
        const realStatus = {
            Name: state.currentConfig.printerName || 'Impressora',
            Status: printerStatus.isOnline ? 'Online' : 'Offline',
            WorkOffline: !printerStatus.isOnline,
            JobCount: printerStatus.pendingJobs || 0,
            LastCheck: printerStatus.lastCheck
        };
        res.json({ ok: true, data: realStatus });
    },

    // Rota: POST /api/doctor/fix
    fix: async (req, res) => {
        logger.info('DOCTOR', 'Solicitação de correção recebida (Fix Spooler).');
        try {
            const { printerType, printerName } = state.currentConfig;
            let count = 0;

            if (printerType === 'usb' && printerName) {
                count = await printerUSB.fixQueue(printerName);
            } else {
                logger.warn('DOCTOR', 'Limpeza profunda disponível apenas para USB no momento. Resetando contadores.');
            }

            state.stats.failedJobs = 0;
            res.json({ ok: true, cleanedCount: count });
        } catch (e) {
            logger.error('DOCTOR', 'Falha ao corrigir fila', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    // ── Auto-update endpoints ────────────────────────────────────────────
    updateStatus: async (req, res) => {
        try {
            if (typeof global.requestUpdateAction !== 'function') {
                return res.json({ status: 'idle', currentVersion: state.updateStatus?.currentVersion || pkg.version });
            }
            const r = await global.requestUpdateAction('status', {}, 5_000);
            if (r.ok && r.state) return res.json(r.state);
            return res.json(state.updateStatus || { status: 'idle', currentVersion: pkg.version });
        } catch (e) {
            res.json(state.updateStatus || { status: 'idle', currentVersion: pkg.version });
        }
    },

    updateCheck: async (req, res) => {
        try {
            if (typeof global.requestUpdateAction !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent não pronto.' });
            }
            const r = await global.requestUpdateAction('check', {}, 30_000);
            res.json(r);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    updateDownload: async (req, res) => {
        try {
            if (typeof global.requestUpdateAction !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent não pronto.' });
            }
            const autoInstall = !!(req.body && req.body.autoInstall);
            const r = await global.requestUpdateAction('download', { autoInstall }, 10_000);
            res.json(r);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    updateInstall: async (req, res) => {
        try {
            if (typeof global.requestUpdateAction !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent não pronto.' });
            }
            const r = await global.requestUpdateAction('install', {}, 5_000);
            res.json(r);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    updateSkip: async (req, res) => {
        try {
            const version = (req.body && req.body.version) || null;
            if (!version) return res.status(400).json({ ok: false, error: 'Body deve conter { version }.' });
            if (typeof global.requestUpdateAction !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent não pronto.' });
            }
            const r = await global.requestUpdateAction('skip', { version }, 5_000);
            res.json(r);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    /**
     * Rota: POST /api/local-print-batch
     *
     * Recebe um lote de jobs ZPL e os empilha na MESMA fila sequencial que o
     * Realtime/Polling usa. Garante ordem + mutex + delay entre jobs.
     *
     * Body: { jobs: [{ id?, zpl, html? }, ...], printerName? }
     *   - Aceita `zpl` (LabelChef nativo) OU `html` (alias compatibilidade Ontrack).
     *   - Se vier `zpl`, vai roteado pelo printerUSB/Network conforme currentConfig.
     *   - Se vier `html`, vai pelo spooler persistente (Electron webContents.print).
     *
     * Resp: { ok, acceptedIds: [...], total, queueLength }
     */
    localPrintBatch: async (req, res) => {
        logger.info('API', 'Recebido lote de impressão local.');
        try {
            const { jobs, printerName } = req.body || {};
            if (!Array.isArray(jobs) || jobs.length === 0) {
                return res.status(400).json({ ok: false, error: 'Campo "jobs" deve ser array não-vazio.' });
            }
            if (typeof global.enqueueLocalJob !== 'function') {
                return res.status(503).json({ ok: false, error: 'Agent ainda não pronto para enfileirar.' });
            }
            const targetPrinter = safePrinterName(
                printerName,
                state.currentConfig.printerName,
                state.currentConfig.printerIdentifier,
            );
            if (!targetPrinter) {
                return res.status(400).json({ ok: false, error: 'Nenhuma impressora configurada ou nome inválido.' });
            }

            const acceptedIds = [];
            for (const j of jobs) {
                if (!j) continue;
                const isZpl = typeof j.zpl === 'string' && j.zpl.trim();
                const isHtml = typeof j.html === 'string' && j.html.trim();
                if (!isZpl && !isHtml) continue;

                const id = (typeof j.id === 'string' && j.id)
                    ? j.id
                    : `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

                const enqueued = global.enqueueLocalJob({
                    id,
                    source: 'local-batch',
                    job_type: isZpl ? 'zpl' : 'html',
                    zpl_content: isZpl ? j.zpl : j.html,
                    printer_name: targetPrinter,
                });
                if (enqueued) acceptedIds.push(id);
            }

            const queueLength = typeof global.getQueueLength === 'function' ? global.getQueueLength() : null;
            logger.info('API', `Lote enfileirado: ${acceptedIds.length}/${jobs.length} aceitos (fila atual=${queueLength}).`);
            res.json({ ok: true, acceptedIds, total: acceptedIds.length, queueLength });
        } catch (e) {
            logger.error('API', 'Falha no lote local', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    /**
     * Rota: POST /api/local-print
     *
     * Body: { zpl?, html?, content?, printerName? }
     *   - Aceita `zpl`, `html` ou `content` (alias). LabelChef padrão = ZPL.
     *   - Síncrono: aguarda evento `done:<id>` do jobEmitter.
     */
    localPrint: async (req, res) => {
        logger.info('API', 'Recebida solicitação de impressão local direta.');
        try {
            const body = req.body || {};
            const zpl = (typeof body.zpl === 'string' && body.zpl.trim()) ? body.zpl : null;
            const html = (typeof body.html === 'string' && body.html.trim()) ? body.html : null;
            const fallback = (typeof body.content === 'string' && body.content.trim()) ? body.content : null;
            const content = zpl || html || fallback;
            const jobType = zpl ? 'zpl' : (html ? 'html' : 'zpl'); // default ZPL para LabelChef

            if (!content) {
                return res.status(400).json({ ok: false, error: 'Conteúdo (zpl|html|content) obrigatório.' });
            }
            const targetPrinter = safePrinterName(
                body.printerName,
                state.currentConfig.printerName,
                state.currentConfig.printerIdentifier,
            );
            if (!targetPrinter) {
                return res.status(400).json({ ok: false, error: 'Nenhuma impressora configurada ou nome inválido.' });
            }
            if (typeof global.enqueueLocalJob !== 'function' || !global.jobEmitter) {
                return res.status(503).json({ ok: false, error: 'Agent ainda não pronto para enfileirar.' });
            }

            const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            const result = await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    global.jobEmitter.off(`done:${id}`, handler);
                    resolve({ ok: false, error: 'Timeout aguardando impressão (30s).' });
                }, 30_000);
                const handler = (r) => {
                    clearTimeout(timer);
                    resolve(r);
                };
                global.jobEmitter.once(`done:${id}`, handler);

                const enqueued = global.enqueueLocalJob({
                    id,
                    source: 'local-single',
                    job_type: jobType,
                    zpl_content: content,
                    printer_name: targetPrinter,
                });
                if (!enqueued) {
                    clearTimeout(timer);
                    global.jobEmitter.off(`done:${id}`, handler);
                    resolve({ ok: false, error: 'Falha ao enfileirar job.' });
                }
            });

            if (result.ok) {
                return res.json({ ok: true, jobId: id, message: 'Impresso com sucesso.' });
            }
            return res.status(500).json({ ok: false, jobId: id, error: result.error || 'Falha na impressão.' });
        } catch (e) {
            logger.error('API', 'Falha na impressão local', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    },

    /**
     * Rota: POST /api/test-print
     *
     * LabelChef: gera ZPL fictício (etiqueta 60×60mm para alimentos) →
     * envia para Labelary (HTTP) → recebe PDF → imprime via SumatraPDF.
     * Funciona para qualquer impressora Windows (Zebra ZPL ou Genéricas PDF).
     */
    testPrint: async (req, res) => {
        logger.info('API', 'Recebida solicitação de teste de impressão.');

        const printerName = safePrinterName(
            state.currentConfig.printerName,
            state.currentConfig.printerIdentifier,
        );
        const printerType = state.currentConfig.printerType;
        if (!printerName) {
            logger.warn('API', 'Test print abortado: nenhum printerName válido em currentConfig.');
            return res.status(400).json({ ok: false, error: 'Nenhuma impressora configurada ou nome inválido.' });
        }

        // --- Gerar ZPL com dados fictícios (mesmo formato do zplGenerator.ts) ---
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const exp = new Date(now); exp.setDate(exp.getDate() + 7);

        const companyName = state.companyName ? state.companyName.toUpperCase().replace(/[^\x20-\x7E]/g, '') : 'LABELCHEF RESTAURANTE';

        const mfgDate = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
        const mfgTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const expDate = `${pad(exp.getDate())}/${pad(exp.getMonth() + 1)}/${exp.getFullYear()}`;
        const batchCode = `TEST-${Date.now().toString().slice(-6)}`;
        const originalLot = `LT-${Date.now().toString().slice(-4)}`;

        const zpl = [
            '^XA',
            '^PW480', '^LL480', '^CI28', '^LH0,0',
            '^FX --- CABECALHO ---',
            '^FO14,18^A0N,42,32^FDTESTE IMPRESSAO^FS',
            '^FX --- SUBTITULO E QUANTIDADE ---',
            '^FO14,68^A0N,20,18^FDRESFRIADO / DESCONGELANDO^FS',
            '^FO14,68^A0N,20,18^FB452,1,0,R^FD1 UN^FS',
            '^FX --- LINHA DIVISORA 1 ---',
            '^FO14,98^GB452,2,2^FS',
            '^FX --- CORPO DE DADOS ---',
            `^FO14,116^A0N,22,18^FDVAL. ORIGINAL:^FS`,
            `^FO14,116^A0N,22,18^FB452,1,0,R^FD${mfgDate}^FS`,
            `^FO14,146^A0N,22,18^FDMANIPULACAO:^FS`,
            `^FO14,146^A0N,22,18^FB452,1,0,R^FD${mfgDate} - ${mfgTime}^FS`,
            `^FO14,176^A0N,22,18^FDVALIDADE:^FS`,
            `^FO14,176^A0N,22,18^FB452,1,0,R^FD${expDate} - ${mfgTime}^FS`,
            '^FO14,206^A0N,22,18^FDMARCA / FORN:^FS',
            '^FO14,206^A0N,22,18^FB452,1,0,R^FDGENERICA^FS',
            '^FO14,236^A0N,22,18^FDSIF:^FS',
            '^FO14,236^A0N,22,18^FB452,1,0,R^FD---^FS',
            `^FO14,266^A0N,22,18^FDLOTE:^FS`,
            `^FO14,266^A0N,22,18^FB452,1,0,R^FD${originalLot}^FS`,
            '^FX --- LINHA DIVISORA 2 ---',
            '^FO14,302^GB452,2,2^FS',
            '^FX --- RODAPE ---',
            '^FO14,320^A0N,24,20^FDRESP.: LABELCHEF AGENT^FS',
            `^FO14,348^A0N,18,16^FD${companyName.substring(0, 24)}^FS`,
            '^FO14,368^A0N,14,13^FDCNPJ: 00.000.000/0001-00   CEP: 00000-000^FS',
            '^FO14,384^A0N,14,11^FDRUA DA IMPRESSAO, 123^FS',
            '^FO14,400^A0N,14,13^FDSAO PAULO - SP^FS',
            `^FO14,430^A0N,30,24^FD#${batchCode}^FS`,
            '^FX QR CODE',
            '^FO330,315^BQN,2,4',
            `^FDQA,https://www.cheflabel.com.br/#/verify/${batchCode}^FS`,
            '^XZ'
        ].join('\n');

        try {
            logger.info('API', `Teste: printerType="${printerType}", impressora="${printerName}"`);

            // LabelChef: ZPL → Labelary → PDF → SumatraPDF (funciona em qualquer impressora Windows)
            const https = require('https');
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            const cp = require('child_process');

            const density = '8dpmm'; // 203 DPI
            const widthInch = (60 / 25.4).toFixed(2);
            const heightInch = (60 / 25.4).toFixed(2);
            const labelaryUrl = `https://api.labelary.com/v1/printers/${density}/labels/${widthInch}x${heightInch}/`;

            logger.info('API', `Convertendo ZPL via Labelary: ${labelaryUrl}`);

            const pdfBuffer = await new Promise((resolve, reject) => {
                const postData = zpl;
                const urlObj = new URL(labelaryUrl);
                const options = {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname,
                    method: 'POST',
                    headers: {
                        'Accept': 'application/pdf',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                };

                const reqHttp = https.request(options, (resp) => {
                    if (resp.statusCode !== 200) {
                        return reject(new Error(`Labelary erro HTTP ${resp.statusCode}`));
                    }
                    const chunks = [];
                    resp.on('data', (d) => chunks.push(d));
                    resp.on('end', () => resolve(Buffer.concat(chunks)));
                });
                reqHttp.on('error', reject);
                reqHttp.write(postData);
                reqHttp.end();
            });

            const pdfPath = path.join(os.tmpdir(), `labelchef_test_${Date.now()}.pdf`);
            fs.writeFileSync(pdfPath, pdfBuffer);
            logger.info('API', `PDF de teste salvo em: ${pdfPath}`);

            const sumatraPath = printerPDF.getSumatraPath();
            if (!sumatraPath) throw new Error('SumatraPDF não encontrado. Verifique a instalação do agente.');

            logger.info('API', `Imprimindo com SumatraPDF: ${sumatraPath}`);

            await new Promise((resolve, reject) => {
                const proc = cp.spawn(sumatraPath, [
                    '-print-to', printerName,
                    '-silent',
                    '-exit-on-print',
                    pdfPath
                ]);
                proc.on('close', (code) => {
                    try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch (e) { }
                    if (code === 0) resolve();
                    else reject(new Error(`SumatraPDF encerrou com código ${code}`));
                });
                proc.on('error', reject);
            });

            logger.info('API', 'Teste de impressão enviado com sucesso.');
            res.json({ ok: true });

        } catch (e) {
            logger.error('API', 'Falha no teste de impressão', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    }
};

module.exports = Controllers;
