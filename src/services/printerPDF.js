const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');
const state = require('../config/state');
const auth = require('../core/auth'); // Acesso ao supabase client

class PrinterPDF {
    async print(jobId, printerName, storagePath) {
        if (!printerName) throw new Error('Nome da impressora não definido para job PDF');

        logger.info('PRINTER:PDF', `Baixando e processando PDF: ${storagePath}`);

        const downloadPath = path.join(os.tmpdir(), `labelchef_${jobId}.pdf`);

        try {
            // Download do Supabase Storage
            const { data, error } = await auth.client.storage
                .from('print_jobs')
                .download(storagePath);

            if (error) throw error;

            const buffer = await data.arrayBuffer();
            fs.writeFileSync(downloadPath, Buffer.from(buffer));

            // Localizar SumatraPDF
            const sumatraPath = this.getSumatraPath();
            if (!sumatraPath) throw new Error('SumatraPDF não encontrado no sistema.');

            const args = [
                '-print-to', printerName,
                '-silent',
                '-exit-on-print',
                downloadPath
            ];

            await new Promise((resolve, reject) => {
                const proc = child_process.spawn(sumatraPath, args);
                let stderr = '';

                proc.on('error', err => {
                    reject(new Error(`Falha ao iniciar SumatraPDF: ${err.message}`));
                });

                proc.stderr.on('data', d => stderr += d);

                proc.on('close', code => {
                    if (code === 0) resolve();
                    else reject(new Error(`Sumatra exit code ${code}: ${stderr}`));
                });
            });

            state.stats.successJobs++;
            logger.info('PRINTER:PDF', 'Enviado com sucesso ao spooler.');

        } catch (e) {
            state.stats.failedJobs++;
            logger.error('PRINTER:PDF', `Falha ao imprimir PDF`, e.message);
            throw e;
        } finally {
            try { if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath); } catch (e) { }

            // LEGACY RESTORATION: Remove from Supabase Storage to save space
            if (storagePath) {
                try {
                    const { error: removeError } = await auth.client.storage
                        .from('print_jobs')
                        .remove([storagePath]); // storagePath comes from job.file_path

                    if (removeError) logger.warn('PRINTER:PDF', `Erro ao limpar Storage: ${removeError.message}`);
                    else logger.info('PRINTER:PDF', '🗑️ PDF removido do bucket (Legacy Policy).');
                } catch (cleanErr) {
                    logger.warn('PRINTER:PDF', `Falha na limpeza do Storage: ${cleanErr.message}`);
                }
            }
        }
    }

    getSumatraPath() {
        // 1. Detectar se estamos rodando em ambiente Electron Produção
        // Verificamos o RESOURCES_PATH injetado pelo main.js
        const resourcesPath = process.env.RESOURCES_PATH;
        const isPackaged = !!resourcesPath && !resourcesPath.includes('node_modules');

        let sumatra = '';

        if (isPackaged) {
            // Em produção (Electron Installer), assets fia em 'resources/assets'
            sumatra = path.join(resourcesPath, 'assets', 'bin', 'SumatraPDF.exe');
        } else {
            // Em desenvolvimento ou PKG (Legacy)
            const isPkg = typeof process.pkg !== 'undefined';
            const baseDir = isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
            sumatra = path.join(baseDir, 'assets', 'bin', 'SumatraPDF.exe');
        }

        if (fs.existsSync(sumatra)) return sumatra;

        // Fallback: Tenta achar no path se nada funcionar
        return null;
    }
}

module.exports = new PrinterPDF();
