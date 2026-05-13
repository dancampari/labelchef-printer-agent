const child_process = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');

/**
 * PSHost — PowerShell persistente (REPL via script .ps1).
 *
 * Por que script .ps1 e não `-Command -`?
 *  powershell -Command - bufferiza a stdin em modo batch (só processa quando a
 *  stdin fecha). Em testes ele engoliu 5s de input sem produzir 1 byte. Para um
 *  REPL real, precisamos de um loop explícito lendo [Console]::In.ReadLine(), o
 *  que só funciona quando o script é carregado via -File.
 *
 * Protocolo do REPL (gerado em runtime e salvo num .ps1 temp):
 *   1. Sobe UTF-8 no [Console]/$OutputEncoding.
 *   2. Imprime PS_HOST_READY_V1 e entra em loop.
 *   3. A cada iteração: acumula linhas até receber "###END_OF_BLOCK###",
 *      passa o bloco inteiro para Invoke-Expression.
 *
 * Cada requisição do Node injeta:
 *   [Console]::WriteLine('PS_BEGIN::<id>')
 *   <comando user>
 *   [Console]::WriteLine('PS_END::<id>')
 *   ###END_OF_BLOCK###
 *
 * Idle: ~50-80 MB constante. Latência: ~20-50 ms por comando.
 */

const REQUEST_TIMEOUT_MS = 8000;
const RESTART_BACKOFF_MS = 2000;
const MAX_BUFFER_CHARS = 1_000_000;
const READY_TIMEOUT_MS = 15_000;

const READY_MARKER = 'PS_HOST_READY_V1';
const BLOCK_TERMINATOR = '###END_OF_BLOCK###';

const REPL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# Carrega o preamble inicial (RawPrinterHelper etc) — substituído em runtime.
{{USER_PREAMBLE}}

[Console]::WriteLine('${READY_MARKER}')

while ($true) {
    $block = New-Object System.Text.StringBuilder
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { exit 0 }
        if ($line -eq '${BLOCK_TERMINATOR}') { break }
        [void]$block.AppendLine($line)
    }
    try {
        Invoke-Expression ($block.ToString())
    } catch {
        [Console]::WriteLine('PS_HOST_FATAL::' + $_.Exception.Message)
    }
}
`;

class PSHost {
    constructor() {
        this.proc = null;
        this.buffer = '';
        this.queue = []; // [{ id, resolve, reject, timer }]
        this.starting = false;
        this.ready = false;
        this.readyWaiters = [];
        this.userPreamble = '';
        this.scriptPath = null;
        // Distingue stop() explícito (sem auto-restart) de crash do PowerShell (com restart).
        this.intentionallyStopped = false;
    }

    setPreamble(code) {
        this.userPreamble = code || '';
    }

    start() {
        if (this.proc || this.starting) return;
        this.starting = true;
        this.ready = false;
        this.intentionallyStopped = false;

        try {
            // Materializa o script com o preamble injetado e salva em disco
            const filled = REPL_SCRIPT.replace('{{USER_PREAMBLE}}', this.userPreamble || '# (no preamble)');
            this.scriptPath = path.join(os.tmpdir(), `labelchef_pshost_${process.pid}.ps1`);
            fs.writeFileSync(this.scriptPath, filled, 'utf8');

            this.proc = child_process.spawn(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NoLogo',
                    '-NonInteractive',
                    '-ExecutionPolicy', 'Bypass',
                    '-File', this.scriptPath,
                ],
                { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
            );

            // Lemos stdout como Buffer e decodificamos manualmente para tolerar
            // qualquer BOM/lixo pré-encoding. Após o preamble setar UTF-8, tudo
            // já chega em UTF-8 limpo.
            this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
            this.proc.stderr.on('data', (chunk) => {
                const trimmed = chunk.toString('utf8').replace(/\0/g, '').trim();
                if (trimmed) logger.warn('PSHOST', 'stderr', trimmed.slice(0, 300));
            });

            this.proc.on('exit', (code, signal) => {
                const wasIntentional = this.intentionallyStopped;
                logger.warn('PSHOST', `encerrado (code=${code}, signal=${signal})${wasIntentional ? ' [intentional]' : ''}`);
                this._teardown(new Error(`PowerShell encerrou (code=${code})`));
                // Só auto-restart se foi crash real (não stop() chamado pelo app)
                if (!wasIntentional) {
                    setTimeout(() => this.start(), RESTART_BACKOFF_MS);
                }
            });

            this.proc.on('error', (err) => {
                logger.error('PSHOST', 'erro no processo', err.message);
                this._teardown(err);
            });

            this.starting = false;
            logger.info('PSHOST', `PowerShell iniciado via REPL .ps1 (${this.scriptPath}). Aguardando READY...`);
        } catch (e) {
            this.starting = false;
            logger.error('PSHOST', 'falha ao iniciar', e.message);
            setTimeout(() => this.start(), RESTART_BACKOFF_MS);
        }
    }

    stop() {
        this.intentionallyStopped = true;
        const proc = this.proc;
        const scriptPath = this.scriptPath;
        this._teardown(new Error('PSHost.stop()'));
        if (proc) {
            try { proc.stdin.end(); } catch { /* ignore */ }
            try { proc.kill(); } catch { /* ignore */ }
        }
        if (scriptPath) {
            try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
            this.scriptPath = null;
        }
    }

    async waitReady() {
        if (this.ready) return;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.readyWaiters = this.readyWaiters.filter((w) => w._t !== timer);
                reject(new Error('PSHost: timeout aguardando READY'));
            }, READY_TIMEOUT_MS);
            this.readyWaiters.push({
                _t: timer,
                resolve: () => { clearTimeout(timer); resolve(); },
                reject:  (e) => { clearTimeout(timer); reject(e); },
            });
        });
    }

    /**
     * Executa um snippet PowerShell. Por padrão converte o resultado para JSON.
     * Use { raw: true } para snippets que controlam o próprio output.
     */
    async run(command, { raw = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        if (!this.proc) this.start();
        if (!this.ready) await this.waitReady();

        return new Promise((resolve, reject) => {
            const id = crypto.randomBytes(6).toString('hex');

            // O comando é envolvido num scriptblock `& { ... }` para que múltiplos
            // statements (ex.: `$p = ...; if (...) { ... }`) sejam tratados como uma
            // única unidade — sem o `&{}`, só o primeiro statement era capturado em
            // $r e o restante vazava no pipeline (causando JSON corrompido).
            const inner = raw
                ? `try { & { ${command} } } catch { [Console]::WriteLine('PS_ERR::' + $_.Exception.Message) }`
                : `try { $r = & { ${command} } ; if ($null -ne $r) { [Console]::WriteLine(($r | ConvertTo-Json -Compress -Depth 4)) } } catch { [Console]::WriteLine('PS_ERR::' + $_.Exception.Message) }`;

            const payload =
                `[Console]::WriteLine('PS_BEGIN::${id}')\n` +
                `${inner}\n` +
                `[Console]::WriteLine('PS_END::${id}')\n` +
                `${BLOCK_TERMINATOR}\n`;

            const timer = setTimeout(() => {
                const idx = this.queue.findIndex((r) => r.id === id);
                if (idx >= 0) this.queue.splice(idx, 1);
                reject(new Error(`PSHost timeout (${timeoutMs}ms) cmd=${command.slice(0, 80)}`));
            }, timeoutMs);

            this.queue.push({ id, resolve, reject, timer });

            try {
                this.proc.stdin.write(payload);
            } catch (e) {
                clearTimeout(timer);
                this.queue = this.queue.filter((r) => r.id !== id);
                reject(e);
            }
        });
    }

    async runJson(command, opts) {
        const out = (await this.run(command, opts)).trim();
        if (!out) return null;
        if (out.startsWith('PS_ERR::')) {
            throw new Error(out.slice('PS_ERR::'.length) || '(erro PowerShell sem mensagem)');
        }
        try {
            return JSON.parse(out);
        } catch (e) {
            throw new Error(`PSHost: JSON inválido: ${out.slice(0, 200)}`);
        }
    }

    _onStdout(chunk) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const clean = text.replace(/\0/g, '');
        this.buffer += clean;

        if (this.buffer.length > MAX_BUFFER_CHARS) {
            logger.warn('PSHOST', 'buffer excedeu limite — descartando');
            this.buffer = '';
            return;
        }

        if (!this.ready) {
            const idx = this.buffer.indexOf(READY_MARKER);
            if (idx < 0) {
                if (this.buffer.length > 8192) this.buffer = this.buffer.slice(-2048);
                return;
            }
            this.buffer = this.buffer.slice(idx + READY_MARKER.length);
            this.ready = true;
            logger.info('PSHOST', 'PowerShell pronto (UTF-8 + preamble carregados).');
            for (const w of this.readyWaiters) w.resolve();
            this.readyWaiters = [];
        }

        // Fatais do REPL (Invoke-Expression deu erro fora do try do user)
        const fatalIdx = this.buffer.indexOf('PS_HOST_FATAL::');
        if (fatalIdx >= 0) {
            const nl = this.buffer.indexOf('\n', fatalIdx);
            const msg = this.buffer.slice(fatalIdx + 'PS_HOST_FATAL::'.length, nl >= 0 ? nl : undefined).trim();
            logger.error('PSHOST', 'REPL fatal', msg);
            this.buffer = nl >= 0 ? this.buffer.slice(nl + 1) : '';
        }

        while (true) {
            const beginIdx = this.buffer.indexOf('PS_BEGIN::');
            if (beginIdx < 0) {
                if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-1024);
                return;
            }
            const idStart = beginIdx + 'PS_BEGIN::'.length;
            const idEnd = this.buffer.indexOf('\n', idStart);
            if (idEnd < 0) return;
            const id = this.buffer.slice(idStart, idEnd).trim();

            const endMarker = `PS_END::${id}`;
            const endIdx = this.buffer.indexOf(endMarker, idEnd);
            if (endIdx < 0) return;

            const body = this.buffer.slice(idEnd + 1, endIdx).trim();
            this.buffer = this.buffer.slice(endIdx + endMarker.length);

            const reqIdx = this.queue.findIndex((r) => r.id === id);
            if (reqIdx >= 0) {
                const [req] = this.queue.splice(reqIdx, 1);
                clearTimeout(req.timer);
                if (body.startsWith('PS_ERR::')) {
                    req.reject(new Error(body.slice('PS_ERR::'.length) || '(erro PowerShell sem mensagem)'));
                } else {
                    req.resolve(body);
                }
            }
        }
    }

    _teardown(err) {
        for (const req of this.queue) {
            clearTimeout(req.timer);
            req.reject(err);
        }
        for (const w of this.readyWaiters) w.reject(err);
        this.queue = [];
        this.readyWaiters = [];
        this.buffer = '';
        this.ready = false;
        this.proc = null;
    }
}

module.exports = new PSHost();
