/**
 * wsBroadcast — testes de integração real.
 *
 * Sobe um http.Server + wsBroadcast.attach numa porta efêmera, conecta clientes
 * com a lib `ws` e valida que mensagens broadcast chegam com timing curto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

function loadFresh() {
    const p = require.resolve('../src/core/wsBroadcast');
    delete require.cache[p];
    return require('../src/core/wsBroadcast');
}

async function withServer(fn) {
    const wsBroadcast = loadFresh();
    const server = http.createServer((_, res) => res.end('ok'));
    wsBroadcast.attach(server, { version: 'test-1.0.0' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        await fn({ wsBroadcast, port });
    } finally {
        wsBroadcast.detach();
        await new Promise((resolve) => server.close(resolve));
    }
}

/**
 * Conecta e PRÉ-bufferiza mensagens. O servidor manda 'hello' assim que aceita
 * a conexão — se o listener é registrado depois, a mensagem se perde. Aqui
 * mantemos uma fila e nextMessage() consome ela ou aguarda a próxima.
 */
function connect(port) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws._buffer = [];
        ws._waiters = [];
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                const waiter = ws._waiters.shift();
                if (waiter) {
                    clearTimeout(waiter.timer);
                    waiter.resolve(msg);
                } else {
                    ws._buffer.push(msg);
                }
            } catch (e) { /* ignore */ }
        });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function nextMessage(ws, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const buffered = ws._buffer.shift();
        if (buffered) return resolve(buffered);
        const timer = setTimeout(() => {
            const idx = ws._waiters.findIndex((w) => w.resolve === resolve);
            if (idx >= 0) ws._waiters.splice(idx, 1);
            reject(new Error('timeout aguardando mensagem'));
        }, timeoutMs);
        ws._waiters.push({ resolve, reject, timer });
    });
}

test('wsBroadcast: cliente recebe hello ao conectar', async () => {
    await withServer(async ({ port }) => {
        const ws = await connect(port);
        try {
            const hello = await nextMessage(ws);
            assert.equal(hello.type, 'hello');
            assert.equal(hello.payload.version, 'test-1.0.0');
            assert.ok(typeof hello.at === 'number');
        } finally {
            ws.close();
        }
    });
});

test('wsBroadcast: status-update chega em <100ms a todos os clientes', async () => {
    await withServer(async ({ wsBroadcast, port }) => {
        const ws1 = await connect(port);
        const ws2 = await connect(port);
        // consome hellos
        await nextMessage(ws1);
        await nextMessage(ws2);

        const t0 = Date.now();
        const p1 = nextMessage(ws1);
        const p2 = nextMessage(ws2);

        const delivered = wsBroadcast.broadcast('status-update', { isOnline: true });
        assert.equal(delivered, 2);

        const [m1, m2] = await Promise.all([p1, p2]);
        const elapsed = Date.now() - t0;

        assert.equal(m1.type, 'status-update');
        assert.equal(m2.type, 'status-update');
        assert.equal(m1.payload.isOnline, true);
        assert.ok(elapsed < 100, `latência ${elapsed}ms (esperado <100)`);

        ws1.close();
        ws2.close();
    });
});

test('wsBroadcast: getClientCount reflete conexões/desconexões', async () => {
    await withServer(async ({ wsBroadcast, port }) => {
        assert.equal(wsBroadcast.getClientCount(), 0);

        const ws1 = await connect(port);
        // Espera connect handler do server registrar o cliente
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(wsBroadcast.getClientCount(), 1);

        const ws2 = await connect(port);
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(wsBroadcast.getClientCount(), 2);

        await new Promise((r) => { ws1.once('close', r); ws1.close(); });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(wsBroadcast.getClientCount(), 1);

        ws2.close();
    });
});

test('wsBroadcast: broadcast sem clientes não quebra (retorna 0)', async () => {
    await withServer(async ({ wsBroadcast }) => {
        const n = wsBroadcast.broadcast('status-update', { isOnline: false });
        assert.equal(n, 0);
    });
});

test('wsBroadcast: config-changed entrega payload correto', async () => {
    await withServer(async ({ wsBroadcast, port }) => {
        const ws = await connect(port);
        await nextMessage(ws); // hello

        const p = nextMessage(ws);
        wsBroadcast.broadcast('config-changed', { config: { printerName: 'CAIXA', printerType: 'usb' } });
        const msg = await p;

        assert.equal(msg.type, 'config-changed');
        assert.deepEqual(msg.payload.config, { printerName: 'CAIXA', printerType: 'usb' });

        ws.close();
    });
});
