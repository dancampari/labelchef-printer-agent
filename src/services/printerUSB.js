const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger'); 
const iconv = require('iconv-lite');
const state = require('../config/state');

class PrinterUSB {
    async print(jobId, zplContent) {
        const printerName = state.currentConfig.printerName;
        if (!printerName) throw new Error('Nome da impressora USB não configurado');

        // 🛡️ Sanitização
        if (!/^[a-zA-Z0-9\s\-_\(\)\[\]\.]+$/.test(printerName)) {
            throw new Error(`Nome de impressora suspeito ou inválido: "${printerName}"`);
        }

        logger.info('PRINTER:USB', `Preparando impressão para: ${printerName}`);

        const tempFileName = `labelchef_${jobId.substring(0, 8)}_${crypto.randomBytes(4).toString('hex')}.zpl`;
        const tempFilePath = path.join(os.tmpdir(), tempFileName);

        let ps = null;
        let timeoutTimer = null;

        try {
            // Encode CP850 para suportar acentos em impressoras raw
            const zplBuffer = iconv.encode(zplContent, 'cp850');
            fs.writeFileSync(tempFilePath, zplBuffer);

            const psScript = `
    $printerName = "${printerName}"
    $filePath = "${tempFilePath.replace(/\\/g, '\\\\')}"

    if (-not (Test-Path $filePath)) {
        Write-Output "ERROR: Arquivo temporario nao encontrado"
        exit 1
    }

    if (-not ("RawPrinterHelper" -as [type])) {
        $code = @'
        using System;
        using System.IO;
        using System.Runtime.InteropServices;

        public class RawPrinterHelper {
            [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
            public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

            [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
            public static extern bool ClosePrinter(IntPtr hPrinter);

            [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
            public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

            [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
            public static extern bool EndDocPrinter(IntPtr hPrinter);

            [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
            public static extern bool StartPagePrinter(IntPtr hPrinter);

            [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
            public static extern bool EndPagePrinter(IntPtr hPrinter);

            [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
            public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
            public class DOCINFOA {
                [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
                [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
                [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
            }

            public static bool SendFile(string printerName, string path) {
                if (!File.Exists(path)) return false;
                IntPtr hPrinter = new IntPtr(0);
                DOCINFOA di = new DOCINFOA { pDocName = "LabelChef Job", pDataType = "RAW" };
                bool success = false;
                if (OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
                    try {
                        if (StartDocPrinter(hPrinter, 1, di)) {
                            try {
                                if (StartPagePrinter(hPrinter)) {
                                    byte[] bytes = File.ReadAllBytes(path);
                                    IntPtr pBytes = Marshal.AllocHGlobal(bytes.Length);
                                    try {
                                        Marshal.Copy(bytes, 0, pBytes, bytes.Length);
                                        Int32 dwWritten = 0;
                                        success = WritePrinter(hPrinter, pBytes, bytes.Length, out dwWritten);
                                    } finally {
                                        Marshal.FreeHGlobal(pBytes);
                                    }
                                    EndPagePrinter(hPrinter);
                                }
                            } finally {
                                EndDocPrinter(hPrinter);
                            }
                        }
                    } finally {
                        ClosePrinter(hPrinter);
                    }
                }
                return success;
            }
        }
'@
        Add-Type -TypeDefinition $code
    }

    $result = [RawPrinterHelper]::SendFile($printerName, $filePath)
    if ($result) { Write-Output "SUCCESS" } else { Write-Output "ERROR_SPOOLER" }
            `;

            return await new Promise((resolve, reject) => {
                ps = child_process.spawn('powershell', ['-Command', psScript]);
                let output = '';
                let errorOutput = '';

                ps.on('error', (err) => {
                    clearTimeout(timeoutTimer);
                    reject(new Error(`Falha ao iniciar PowerShell: ${err.message}`));
                });

                ps.stdout.on('data', (data) => output += data.toString());
                ps.stderr.on('data', (data) => errorOutput += data.toString());

                timeoutTimer = setTimeout(() => {
                    if (ps) {
                        try { ps.kill(); } catch (e) { }
                        reject(new Error('Timeout: Impressão USB demorou > 15s.'));
                    }
                }, 15000);

                ps.on('close', (code) => {
                    clearTimeout(timeoutTimer);
                    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) { }

                    if (output.includes('SUCCESS')) {
                        logger.info('PRINTER:USB', `Job ${jobId} enviado ao Spooler.`);
                        state.stats.successJobs++;
                        state.stats.lastJobTime = new Date();
                        resolve();
                    } else {
                        const rawMsg = errorOutput || output || 'Falha desconhecida';
                        const cleanMsg = rawMsg.replace(/[^\x20-\x7E]/g, '').trim();
                        logger.error('PRINTER:USB', 'Erro PowerShell', cleanMsg);
                        reject(new Error(cleanMsg));
                    }
                });
            });

        } catch (error) {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) { }
            state.stats.failedJobs++;
            throw error;
        }
    }
    async fixQueue(printerName) {
        if (!printerName) throw new Error("Nenhuma impressora configurada.");

        logger.info('PRINTER:USB', `Tentando corrigir fila de: ${printerName}`);

        return new Promise((resolve, reject) => {
            const safeName = printerName.replace(/"/g, ''); // Basic sanitization

            // Script PowerShell (identico ao anterior)
            const psScript = `
                $p = "${safeName}"
                $jobsCount = (Get-PrintJob -PrinterName $p -ErrorAction SilentlyContinue | Measure-Object).Count
                Get-PrintJob -PrinterName $p -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue
                Resume-Printer -Name $p -ErrorAction SilentlyContinue
                Write-Output "FIXED:$jobsCount"
            `;

            const ps = child_process.spawn('powershell', ['-Command', psScript]);
            let output = '';
            let errorOutput = '';

            ps.stdout.on('data', (data) => output += data.toString());
            ps.stderr.on('data', (data) => errorOutput += data.toString());

            ps.on('close', (code) => {
                const out = output.trim();

                if (out.includes("FIXED:")) {
                    const count = out.split(":")[1].trim();
                    // Fix logger: Combine Tag + Message
                    logger.info('PRINTER:USB', `Fila corrigida. Jobs removidos: ${count}`);
                    resolve(parseInt(count) || 0);
                } else {
                    const cleanErr = (errorOutput || out || "Erro desconhecido/Vazio").trim();
                    // Fix logger: Combine Message + Error Details
                    logger.error('PRINTER:USB', `Falha Script Limpeza: ${cleanErr}`);
                    reject(new Error(`Falha ao limpar fila: ${cleanErr}`));
                }
            });

            ps.on('error', (err) => {
                logger.error('PRINTER:USB', `Erro ao iniciar PowerShell: ${err.message}`);
                reject(err);
            });
        });
    }
}

module.exports = new PrinterUSB();
