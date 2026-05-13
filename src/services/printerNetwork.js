const net = require('net');
const logger = require('../utils/logger');
const state = require('../config/state');

class PrinterNetwork {
    async print(jobId, zplContent) {
        let ip = state.currentConfig.printerIdentifier;
        let port = 9100;

        if (ip && ip.includes(':')) {
            const parts = ip.split(':');
            ip = parts[0];
            port = parseInt(parts[1], 10) || 9100;
        }

        if (!ip) throw new Error('IP da impressora não configurado');

        if (!ip) throw new Error('IP da impressora não configurado');

        // ANTI-COLISÃO (Network): Se o Windows Spooler estiver usando a impressora, pausamos o acesso direto
        if (state.printerStatus && state.printerStatus.isBusy) {
            logger.warn('PRINTER:NET', '⚠️ Impressora reportou "Jobs na Fila" via WMI. Pausando envio TCP para evitar colisão.');
            // Opcional: throw new Error('Impressora ocupada. Tentando novamente em breve...');
            // Mas para não falhar o Job, apenas logamos e tentamos (TCP pode ter sorte) ou esperamos.
            // Melhor prática: Esperar um pouco
            await new Promise(r => setTimeout(r, 2000));
        }

        logger.info('PRINTER:NET', `Enviando para ${ip}:${port}...`);

        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            client.setTimeout(15000);

            client.connect(port, ip, () => {
                client.write(zplContent);
                client.end();
            });

            client.on('error', (err) => {
                state.stats.failedJobs++;
                client.destroy();
                logger.error('PRINTER:NET', `Erro Socket: ${err.message}`);
                reject(err);
            });

            client.on('timeout', () => {
                state.stats.failedJobs++;
                client.destroy();
                logger.error('PRINTER:NET', 'Timeout de conexão');
                reject(new Error('Timeout'));
            });

            client.on('close', (hadError) => {
                if (!hadError) {
                    state.stats.successJobs++;
                    state.stats.lastJobTime = new Date();
                    logger.info('PRINTER:NET', 'Job enviado com sucesso.');
                    resolve();
                }
            });
        });
    }
}

module.exports = new PrinterNetwork();
