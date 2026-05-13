const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');

/**
 * WebSocket broadcast — empurra eventos do agent para o frontend em tempo real.
 *
 * Endpoint: ws://127.0.0.1:9876/ws
 *
 * Mensagens enviadas (servidor → cliente):
 *   { type: 'hello',          payload: { version }, at }
 *   { type: 'status-update',  payload: <printerStatus snapshot>,     at }
 *   { type: 'config-changed', payload: { config: <currentConfig> },  at }
 *
 * Cliente não precisa enviar nada — ping/pong nativos do protocolo mantêm vivo.
 * Heartbeat custom de 30s detecta clientes mortos.
 */

const HEARTBEAT_MS = 30_000;

let wss = null;
const clients = new Set();
let heartbeatTimer = null;

function attach(httpServer, { version } = {}) {
    if (wss) return;
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws) => {
        clients.add(ws);
        ws.isAlive = true;
        logger.info('WS', `Cliente conectado (${clients.size} ativo(s))`);

        // Hello inicial — útil pro frontend confirmar versão do protocolo
        try {
            ws.send(JSON.stringify({
                type: 'hello',
                payload: { version: version || 'unknown' },
                at: Date.now(),
            }));
        } catch { /* ignore */ }

        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('close', () => {
            clients.delete(ws);
            logger.info('WS', `Cliente desconectado (${clients.size} restante(s))`);
        });
        ws.on('error', (err) => {
            logger.warn('WS', 'erro no cliente', err.message);
        });
    });

    // Heartbeat: a cada 30s manda ping; se não respondeu desde o último, mata.
    heartbeatTimer = setInterval(() => {
        for (const ws of clients) {
            if (ws.isAlive === false) {
                try { ws.terminate(); } catch { /* ignore */ }
                clients.delete(ws);
                continue;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch { /* ignore */ }
        }
    }, HEARTBEAT_MS);

    logger.info('WS', 'WebSocket server pronto em /ws');
}

function detach() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    // Termina todas as conexões ativas — `wss.close()` para de aceitar novas
    // mas não fecha as existentes; o event loop fica pendurado nelas.
    for (const ws of clients) {
        try { ws.terminate(); } catch { /* ignore */ }
    }
    clients.clear();
    if (wss) {
        try { wss.close(); } catch { /* ignore */ }
        wss = null;
    }
}

function broadcast(type, payload) {
    if (!wss || clients.size === 0) return 0;
    const msg = JSON.stringify({ type, payload, at: Date.now() });
    let delivered = 0;
    for (const ws of clients) {
        if (ws.readyState === 1) {
            try {
                ws.send(msg);
                delivered++;
            } catch { /* ignore */ }
        }
    }
    return delivered;
}

function getClientCount() {
    return clients.size;
}

module.exports = { attach, detach, broadcast, getClientCount };
