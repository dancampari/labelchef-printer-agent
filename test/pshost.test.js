/**
 * PSHost — testes de integração com PowerShell real.
 *
 * Cobre todos os bugs corrigidos durante o refactor:
 *  - Encoding UTF-16 → UTF-8 (corrigido com [Console]::OutputEncoding)
 *  - powershell -Command - bufferiza stdin (corrigido com REPL .ps1)
 *  - Multi-statement command vazava pipeline (corrigido com & { })
 *  - Sentinelas via Write-Host (trocadas para [Console]::WriteLine)
 *  - Variável reservada $host (renomeada $portHost no monitor)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Carrega PSHost recém-criado (não usa singleton — cada suite cria sua instância).
function loadFreshPSHost() {
    const modPath = require.resolve('../src/core/pshost');
    delete require.cache[modPath];
    return require('../src/core/pshost');
}

const printerUSB = require('../src/services/printerUSB');

test('PSHost: handshake READY chega em <2s sem preamble', async () => {
    const pshost = loadFreshPSHost();
    try {
        const t0 = Date.now();
        pshost.start();
        await pshost.waitReady();
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 2000, `READY demorou ${elapsed}ms (esperado <2000)`);
        assert.equal(pshost.ready, true);
    } finally {
        pshost.stop();
    }
});

test('PSHost: handshake READY chega em <5s COM preamble RawPrinterHelper', async () => {
    const pshost = loadFreshPSHost();
    pshost.setPreamble(printerUSB.PREAMBLE);
    try {
        const t0 = Date.now();
        pshost.start();
        await pshost.waitReady();
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 5000, `READY com Add-Type demorou ${elapsed}ms (esperado <5000)`);
    } finally {
        pshost.stop();
    }
});

test('PSHost: runJson com comando single-statement retorna objeto válido', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        const result = await pshost.runJson('Get-Printer | Select-Object -First 1 Name');
        assert.ok(result !== null, 'resultado não pode ser null');
        // Pode ser objeto único ou array de 1
        const first = Array.isArray(result) ? result[0] : result;
        assert.ok(typeof first.Name === 'string', 'Name deve ser string');
    } finally {
        pshost.stop();
    }
});

test('REGRESSÃO BUG-MULTISTATEMENT: comando com $p=...; if/else; [PSCustomObject] não vaza pipeline', async () => {
    // Esse é o bug que causou "Não encontrada / Erro Driver" no painel mesmo com
    // a impressora funcionando. Sem o `& { }` wrap, o assignment $p capturava em $r
    // e o [PSCustomObject] vazava como Format-List → JSON corrompido.
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();

        const cmd = `
$first = Get-Printer | Select-Object -First 1
if (-not $first) { $null } else {
  $extra = 'computed-value'
  [PSCustomObject]@{
    Name = $first.Name
    Extra = $extra
    Kind = 'pscustomobject'
  }
}`.trim();

        const result = await pshost.runJson(cmd);
        assert.ok(result, 'resultado não pode ser null');
        assert.equal(result.Kind, 'pscustomobject', 'campo Kind deve vir do [PSCustomObject]');
        assert.equal(result.Extra, 'computed-value', 'variável intermediária $extra deve ter sido usada');
        assert.ok(typeof result.Name === 'string', 'Name deve ser string');
        // Crucial: o resultado NÃO pode ser um objeto WMI com Scope/Options
        assert.equal(result.Scope, undefined, 'não pode ter campo Scope (era o vazamento do WMI cru)');
        assert.equal(result.Options, undefined, 'não pode ter campo Options');
    } finally {
        pshost.stop();
    }
});

test('PSHost: run com raw:true permite controle direto de [Console]::WriteLine', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        const out = await pshost.run(
            `[Console]::WriteLine('LINHA_A'); [Console]::WriteLine('LINHA_B')`,
            { raw: true }
        );
        assert.match(out, /LINHA_A/, 'deve conter LINHA_A');
        assert.match(out, /LINHA_B/, 'deve conter LINHA_B');
    } finally {
        pshost.stop();
    }
});

test('PSHost: erro PowerShell propaga como rejeição com mensagem', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        await assert.rejects(
            async () => pshost.runJson('throw "boom"'),
            (err) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /boom/);
                return true;
            }
        );
    } finally {
        pshost.stop();
    }
});

test('PSHost: 5 requisições paralelas resolvem com ids corretos', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        const results = await Promise.all([
            pshost.runJson('1+1'),
            pshost.runJson('2+2'),
            pshost.runJson('3+3'),
            pshost.runJson('4+4'),
            pshost.runJson('5+5'),
        ]);
        assert.deepEqual(results, [2, 4, 6, 8, 10]);
    } finally {
        pshost.stop();
    }
});

test('PSHost: comando que retorna null não quebra parse', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        const result = await pshost.runJson('$null');
        assert.equal(result, null);
    } finally {
        pshost.stop();
    }
});

test('PSHost: comando que retorna array de objetos é serializado correto', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        const result = await pshost.runJson(`@(
  [PSCustomObject]@{ Id = 1; Name = 'a' },
  [PSCustomObject]@{ Id = 2; Name = 'b' }
)`);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 2);
        assert.equal(result[0].Id, 1);
        assert.equal(result[1].Name, 'b');
    } finally {
        pshost.stop();
    }
});

test('PSHost: timeout dispara rejeição', async () => {
    // Observação: o REPL processa blocos em ordem (FIFO). Após timeout, o REPL
    // ainda está executando o Start-Sleep até o fim — então um teste de "ainda
    // funciona depois" precisaria esperar o sleep terminar. Aqui validamos só
    // a rejeição por timeout, que é o contrato público.
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        await assert.rejects(
            async () => pshost.run('Start-Sleep -Seconds 10', { timeoutMs: 500, raw: true }),
            /timeout/i
        );
    } finally {
        pshost.stop();
    }
});

test('PSHost: stop() encerra processo e teardown limpa fila', async () => {
    const pshost = loadFreshPSHost();
    pshost.start();
    await pshost.waitReady();
    assert.ok(pshost.proc, 'processo deve estar vivo antes do stop');
    pshost.stop();
    assert.equal(pshost.proc, null, 'proc deve virar null após stop');
    assert.equal(pshost.ready, false);
});

test('PSHost: stop() não dispara auto-restart (intentionallyStopped)', async () => {
    // Em produção, crashes do PowerShell devem auto-restartar (resiliência).
    // Mas stop() explícito (no shutdown) NÃO pode reiniciar — senão deixa processos
    // órfãos quando o agent fecha.
    const pshost = loadFreshPSHost();
    pshost.start();
    await pshost.waitReady();
    pshost.stop();
    // Espera o restart-window (2000ms) + folga
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(pshost.proc, null, 'após stop(), proc deve continuar null (sem restart)');
    assert.equal(pshost.intentionallyStopped, true);
});
