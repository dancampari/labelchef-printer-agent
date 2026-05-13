const auth = require('./src/core/auth');
const database = require('./src/core/database');
const socket = require('./src/core/socket');
const server = require('./src/api/server');
const logger = require('./src/utils/logger');
const state = require('./src/config/state');
const pshost = require('./src/core/pshost');
const { safePrinterName, isValidPrinterName } = require('./src/utils/printerValidator');

// Services
const printerUSB = require('./src/services/printerUSB');
const printerNetwork = require('./src/services/printerNetwork');
const printerPDF = require('./src/services/printerPDF');
const monitor = require('./src/services/monitor');

// PowerShell persistente (substitui spawn-por-query do monitor antigo).
// PrinterUSB.print mantém seu próprio fluxo Win32 RAW — NÃO é movido pra pshost.
pshost.start();

// IPC for Desktop Integration (Tray Update)
const ipc = require('process');
const { EventEmitter } = require('events');

// Polyfill WebSocket (Crítico para Supabase em Node/Electron backend)
const WebSocket = require('ws');
global.WebSocket = WebSocket;

// Emissor interno: processJob emite `done:<id>` quando termina (sucesso/falha).
// Quem precisa aguardar o término de um job específico (ex.: controller do
// /api/local-print, que mantém o contrato HTTP síncrono) assina aqui.
const jobEmitter = new EventEmitter();
jobEmitter.setMaxListeners(100);
global.jobEmitter = jobEmitter;

// Bridge IPC para ações do autoUpdater. main.js detém o autoUpdater (Electron API).
const updateActionWaiters = new Map();

function requestUpdateAction(action, params = {}, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        if (!ipc.send) return reject(new Error('IPC não disponível (modo standalone)'));
        const requestId = `upd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
            updateActionWaiters.delete(requestId);
            reject(new Error(`Timeout aguardando ação de update: ${action}`));
        }, timeoutMs);
        updateActionWaiters.set(requestId, { resolve, reject, timer });
        ipc.send({ type: 'UPDATE_ACTION', requestId, action, ...params });
    });
}
global.requestUpdateAction = requestUpdateAction;

// Mapa de promises pendentes para impressão via IPC (HTML / test-label)
const pendingPdfRequests = new Map();

/**
 * Solicita ao Electron (main.js) que imprima a etiqueta de teste diretamente via webContents.print().
 */
function requestTestPrint(company, printerName) {
    return new Promise((resolve, reject) => {
        if (!ipc.send) return reject(new Error('IPC não disponível (modo standalone)'));
        if (!isValidPrinterName(printerName)) {
            return reject(new Error('Nome da impressora inválido para teste — rejeitado para não usar default printer do sistema.'));
        }
        const id = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
        pendingPdfRequests.set(id, { resolve, reject });
        ipc.send({ type: 'PRINT_TEST_LABEL', id, company, printerName });

        setTimeout(() => {
            if (pendingPdfRequests.has(id)) {
                pendingPdfRequests.delete(id);
                reject(new Error('Timeout ao imprimir etiqueta de teste'));
            }
        }, 15000);
    });
}

/**
 * Impressão HTML direto via spooler persistente (caso futuro). Não usado no
 * fluxo principal do LabelChef (que é ZPL/Network/PDF), mas mantido pra paridade.
 */
function requestHtmlPrint(id, htmlContent, printerName) {
    return new Promise((resolve, reject) => {
        if (!ipc.send) return reject(new Error('IPC não disponível'));
        if (!isValidPrinterName(printerName)) {
            return reject(new Error('Nome da impressora inválido — rejeitado para não usar default printer do sistema.'));
        }
        pendingPdfRequests.set(id, { resolve, reject });
        ipc.send({ type: 'PRINT_HTML', id, htmlContent, printerName });

        setTimeout(() => {
            if (pendingPdfRequests.has(id)) {
                pendingPdfRequests.delete(id);
                reject(new Error('Timeout ao imprimir HTML local'));
            }
        }, 20000);
    });
}

global.requestTestPrint = requestTestPrint;
global.requestHtmlPrint = requestHtmlPrint;

async function bootstrap() {
    logger.init();
    logger.info('MAIN', '=== LABELCHEF AGENT v3.2.0 (Auto-update + Shadcn UI + WS push + PSHost) ===');

    // 1. Inicializa Autenticação (Tenta carregar sessão do disco)
    const isAuthenticated = await auth.init();

    // 2. Anti-Collision: fila local sequencial com mutex + dedup
    const jobQueue = [];
    const processedJobIds = new Set();
    let isProcessingQueue = false;

    const processJob = async (job) => {
        const { id, zpl_content, job_type, file_path, printer_name, source } = job;
        // Jobs locais (single ou batch) NÃO existem na tabela print_queue do banco.
        const isLocalJob = source === 'local-batch' || source === 'local-single';
        logger.info('JOB', `Processando Job ${id} (${job_type}${isLocalJob ? ', ' + source : ''})...`);

        // Stats CENTRALIZADAS aqui — qualquer job conta, independente do branch.
        state.stats.totalJobs++;

        try {
            if (!isLocalJob) {
                await database.updateJobStatus(id, 'processing');
            }
            // Revalida status da impressora antes de imprimir
            monitor.onDeviceChange('pre-print').catch(() => {});

            if (job_type === 'pdf') {
                const pName = safePrinterName(state.currentConfig.printerName, printer_name);
                if (!pName) throw new Error('Impressora não configurada — job PDF rejeitado para não usar default printer.');
                await printerPDF.print(id, pName, file_path);
            } else if (job_type === 'html') {
                // Caminho adicional (paridade com Ontrack): imprime HTML via spooler persistente.
                // Fluxo principal do LabelChef é ZPL (else branch), mas se vier um job HTML
                // explícito, ele passa por aqui sem quebrar.
                const pName = safePrinterName(state.currentConfig.printerName, printer_name);
                if (!pName) throw new Error('Impressora não configurada — job HTML rejeitado para não usar default printer.');
                await new Promise((resolve, reject) => {
                    if (!ipc.send) return reject(new Error('IPC não disponível'));
                    pendingPdfRequests.set(id, { resolve, reject });
                    ipc.send({ type: 'PRINT_HTML', id, htmlContent: zpl_content, printerName: pName });
                    setTimeout(() => {
                        if (pendingPdfRequests.has(id)) {
                            pendingPdfRequests.delete(id);
                            reject(new Error('Timeout ao imprimir HTML'));
                        }
                    }, 20000);
                });
            } else {
                // CAMINHO PRINCIPAL: ZPL — USB (Win32 RAW) ou Network (TCP 9100).
                // Esses serviços NÃO foram modificados e mantêm exatamente o
                // comportamento original do LabelChef.
                if (state.currentConfig.printerType === 'usb') {
                    await printerUSB.print(id, zpl_content);
                } else {
                    await printerNetwork.print(id, zpl_content);
                }
            }

            state.stats.successJobs++;
            state.stats.lastJobTime = new Date();

            if (!isLocalJob) {
                await database.updateJobStatus(id, 'printed');
            }
            logger.info('JOB', `Job ${id} concluído com sucesso. (total=${state.stats.totalJobs}, ok=${state.stats.successJobs})`);
            // Push WS para o frontend
            try {
                const wsBroadcast = require('./src/core/wsBroadcast');
                wsBroadcast.broadcast('job-progress', { id, status: 'printed', source: source || 'queue' });
            } catch { /* ignore */ }
            jobEmitter.emit(`done:${id}`, { ok: true });
        } catch (e) {
            state.stats.failedJobs++;
            state.stats.lastJobTime = new Date();

            logger.error('JOB', `Falha no Job ${id}`, e.message);
            if (!isLocalJob) {
                await database.updateJobStatus(id, 'error', e.message);
            }
            try {
                const wsBroadcast = require('./src/core/wsBroadcast');
                wsBroadcast.broadcast('job-progress', { id, status: 'error', error: e.message, source: source || 'queue' });
            } catch { /* ignore */ }
            jobEmitter.emit(`done:${id}`, { ok: false, error: e.message });
        } finally {
            setTimeout(() => processedJobIds.delete(id), 60000);
        }
    };

    const runQueue = async () => {
        if (isProcessingQueue) return;
        isProcessingQueue = true;

        try {
            while (jobQueue.length > 0) {
                const nextJob = jobQueue.shift();
                try {
                    await processJob(nextJob);
                } catch (e) {
                    logger.error('QUEUE', 'Erro no processamento de um job individual', e.message);
                }
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (e) {
            logger.error('QUEUE', 'Erro fatal na execução da fila', e.stack);
        } finally {
            isProcessingQueue = false;
            if (jobQueue.length === 0) {
                logger.info('QUEUE', 'Fila de processamento concluída.');
            }
        }
    };

    // Exposto para o controller (POST /api/local-print[-batch])
    global.enqueueLocalJob = (job) => {
        if (!job || !job.id) return false;
        if (processedJobIds.has(job.id)) {
            logger.warn('QUEUE', `Job ${job.id} duplicado ignorado (enqueueLocalJob)`);
            return false;
        }
        processedJobIds.add(job.id);
        jobQueue.push(job);
        runQueue();
        return true;
    };
    global.getQueueLength = () => jobQueue.length;

    // Handler do Realtime + Polling drain
    socket.setHandler((job) => {
        if (processedJobIds.has(job.id)) {
            logger.warn('QUEUE', `Job ${job.id} duplicado recebido. Ignorando.`);
            return;
        }

        logger.info('QUEUE', `Adicionando Job ${job.id} à fila de anti-colisão.`);
        processedJobIds.add(job.id);
        jobQueue.push(job);
        runQueue();
    });

    // 3. Se autenticado, conecta aos serviços Cloud
    if (isAuthenticated) {
        const hasConfig = await database.syncConfig();
        if (hasConfig) {
            socket.connect();
            socket.startPolling();
            monitor.start();
        }
    } else {
        logger.warn('MAIN', 'Agente não autenticado. Aguardando login via Dashboard.');
    }

    // Heartbeat 60s (frontend tolera 2min)
    setInterval(() => database.sendHeartbeat(), 60000);
    if (state.isAuthenticated()) database.sendHeartbeat();

    // 4. Inicia Servidor Local (UI + API REST + WS server)
    server.start();

    // 5. IPC Loop do Tray — com diff: só envia se algo mudou.
    if (ipc.send) {
        let lastPayloadJson = '';
        setInterval(() => {
            const payload = {
                status: state.connStatus,
                printerName: state.currentConfig.printerName || state.currentConfig.printerIdentifier || 'Não Config.',
                printerStatus: state.printerStatus && state.printerStatus.isOnline
                    ? (state.printerStatus.message || 'Online')
                    : (state.connStatus === 'SUBSCRIBED' ? 'Aguardando' : 'Inativo')
            };
            const json = JSON.stringify(payload);
            if (json !== lastPayloadJson) {
                lastPayloadJson = json;
                ipc.send({ type: 'UPDATE_DATA', payload });
            }
        }, 5000);
    }
}

// Global Error Handlers
process.on('uncaughtException', (err) => logger.error('FATAL', 'Uncaught Exception', err.stack || err.message));
process.on('unhandledRejection', (reason) => logger.error('FATAL', 'Unhandled Rejection', reason instanceof Error ? reason.stack : reason));

// Graceful Shutdown
const shutdown = () => {
    logger.info('MAIN', 'Desligando agente...');
    monitor.stop();
    socket.disconnect();
    try { pshost.stop(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 500);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', () => {
    logger.info('MAIN', 'Processo pai desconectado (Electron fechou). Encerrando...');
    shutdown();
});

// IPC Listener for Tray Actions & PDF Results
process.on('message', async (msg) => {
    // Plug/unplug detectado pelo Electron via WM_DEVICECHANGE
    if (msg.type === 'DEVICE_CHANGE') {
        monitor.onDeviceChange('WM_DEVICECHANGE').catch(() => {});
        return;
    }
    // Snapshot do autoUpdater
    if (msg.type === 'UPDATE_STATUS') {
        state.updateStatus = msg.payload || null;
        return;
    }
    // Resposta de uma ação de update solicitada via REST
    if (msg.type === 'UPDATE_ACTION_RESULT') {
        const waiter = updateActionWaiters.get(msg.requestId);
        if (waiter) {
            clearTimeout(waiter.timer);
            updateActionWaiters.delete(msg.requestId);
            const { type, requestId, ...result } = msg;
            waiter.resolve(result);
        }
        return;
    }
    // Resultado da impressão direta de etiqueta de teste / HTML
    if (msg.type === 'PRINT_TEST_LABEL_RESULT' || msg.type === 'PRINT_HTML_RESULT') {
        const resolver = pendingPdfRequests.get(msg.id);
        if (resolver) {
            if (msg.success) resolver.resolve();
            else resolver.reject(new Error(msg.error || 'Falha na impressão'));
            pendingPdfRequests.delete(msg.id);
        }

    } else if (msg.type === 'RUN_TEST_PRINT') {
        logger.info('MAIN', 'Solicitação de Teste de Impressão via Tray');
        const printerName = state.currentConfig.printerName || state.currentConfig.printerIdentifier;
        if (!printerName) {
            logger.warn('MAIN', 'Teste via Tray: impressora não configurada.');
            return;
        }
        try {
            // O test-print do controller é mais completo (Labelary ZPL→PDF→Sumatra),
            // mas o atalho do Tray usa o caminho rápido via IPC + test-label.html.
            await requestTestPrint(state.companyName, printerName);
            logger.info('MAIN', 'Teste de impressão (Tray) enviado.');
        } catch (e) {
            logger.error('MAIN', 'Erro no teste de impressão (Tray)', e.message);
        }

    } else if (msg.type === 'FORCE_CLEAR_QUEUE') {
        logger.info('MAIN', 'Solicitação de Limpeza de Fila via Tray');
        if (state.currentConfig.printerName) {
            try {
                await printerUSB.fixQueue(state.currentConfig.printerName);
                if (ipc.send) ipc.send({ type: 'NOTIFICATION', title: 'Fila Limpa', body: 'A fila de impressão foi reiniciada.' });
            } catch (e) {
                logger.error('MAIN', 'Erro ao limpar fila', e.message);
            }
        }

    } else if (msg.type === 'ENCRYPT_RESULT' || msg.type === 'DECRYPT_RESULT') {
        // Tratado no módulo auth.js
    }
});

// Start
bootstrap();
