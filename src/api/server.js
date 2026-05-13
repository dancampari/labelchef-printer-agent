const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const CONSTANTS = require('../config/constants');
const Controllers = require('./controllers');
const logger = require('../utils/logger');
const wsBroadcast = require('../core/wsBroadcast');
const pkg = require('../../package.json');

class Server {
    start() {
        const app = express();
        app.disable('x-powered-by');

        // SECURITY (v3.2.3): CORS estrito. Antes, qualquer origem era aceita
        // (callback(null, true) em todos os branches) — site malicioso podia
        // mandar ZPL para a impressora local via drive-by attack no browser.
        // Agora só *.cheflabel.com.br e localhost dev passam.
        //
        // Origin vazio (mesma origem, file://, electron interno) continua
        // permitido para a UI local do agent acessar /login etc.
        const isAllowedOrigin = (origin) => {
            if (!origin) return true;
            if (/^https:\/\/([a-z0-9-]+\.)*cheflabel\.com\.br$/.test(origin)) return true;
            if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
            return false;
        };

        app.use(cors({
            origin: function (origin, callback) {
                if (isAllowedOrigin(origin)) return callback(null, true);
                // Rejeição silenciosa (sem header Allow-Origin) — browser bloqueia.
                logger.warn('SERVER', `CORS: origem rejeitada → ${origin}`);
                return callback(null, false);
            },
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));

        app.use(bodyParser.json({ limit: '2mb' }));
        app.use(bodyParser.urlencoded({ extended: true, limit: '2mb' }));

        const staticPath = path.join(__dirname, '..', '..', 'public');
        app.use(express.static(staticPath));

        // Public Routes
        app.post('/login', Controllers.login);
        // SECURITY (v3.2.3): /api/saved-credentials removido — expunha senha em
        // cleartext via HTTP local. Auto-login agora é exclusivo via token.
        app.post('/api/auto-login', Controllers.tryAutoLogin);
        app.post('/api/logout', Controllers.logout);

        // Health + Local Print (públicas)
        app.get('/api/health', Controllers.health);
        app.post('/api/local-print', Controllers.localPrint);
        app.post('/api/local-print-batch', Controllers.localPrintBatch);

        // Auto-update (controle manual: usuário decide quando baixar / instalar / pular)
        app.get('/api/update', Controllers.updateStatus);
        app.post('/api/update/check', Controllers.updateCheck);
        app.post('/api/update/download', Controllers.updateDownload);
        app.post('/api/update/install', Controllers.updateInstall);
        app.post('/api/update/skip', Controllers.updateSkip);

        // Protected Routes
        app.get('/api/status', Controllers.requireAuth, Controllers.getStatus);
        app.post('/config', Controllers.requireAuth, Controllers.saveConfig);
        app.get('/api/printers', Controllers.getPrinters);

        // Doctor Routes
        app.get('/api/doctor/diagnose', Controllers.requireAuth, Controllers.diagnose);
        app.post('/api/doctor/fix', Controllers.requireAuth, Controllers.fix);
        app.post('/api/test-print', Controllers.requireAuth, Controllers.testPrint);

        // Fallback p/ UI
        app.get('*', (req, res) => {
            res.sendFile(path.join(staticPath, 'login.html'));
        });

        // http.createServer (não app.listen) — necessário para acoplar o WS server
        // na mesma porta. Mesma origem, mesmo socket TCP, sem CORS extra.
        const httpServer = http.createServer(app);
        wsBroadcast.attach(httpServer, { version: pkg.version });

        httpServer.listen(CONSTANTS.HTTP_PORT, '127.0.0.1', () => {
            logger.info('SERVER', `Interface Local + API REST + WS rodando em 127.0.0.1:${CONSTANTS.HTTP_PORT}`);
        });

        httpServer.on('error', (e) => {
            logger.error('SERVER', 'Erro fatal ao iniciar servidor HTTP', e.message);
            if (e.code === 'EADDRINUSE') {
                logger.error('SERVER', `Porta ${CONSTANTS.HTTP_PORT} está em uso. Provável instância zumbi.`);
            }
        });
    }
}

module.exports = new Server();
