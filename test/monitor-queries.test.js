/**
 * Monitor — testes das queries WMI/PowerShell reais.
 *
 * Não monta o monitor inteiro (que precisa de Supabase). Em vez disso, replica
 * os comandos PowerShell que o monitor envia, garantindo que:
 *  - O formato do output é o esperado
 *  - $portHost (não $host reservado) funciona
 *  - Get-WmiObject -Filter com aspas escapadas funciona
 *  - Scan global devolve array (Array.isArray-safe)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function loadFreshPSHost() {
    const modPath = require.resolve('../src/core/pshost');
    delete require.cache[modPath];
    return require('../src/core/pshost');
}

// Picka uma impressora real existente nesta máquina para os testes de filtro WMI.
async function pickAnyPrinter(pshost) {
    const list = await pshost.runJson('Get-Printer | Select-Object -First 1 Name');
    if (!list) throw new Error('Nenhuma impressora encontrada para o teste');
    return Array.isArray(list) ? list[0].Name : list.Name;
}

test('Monitor: scan USB global devolve array (mesmo com 0/1/N impressoras)', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        const result = await pshost.runJson(
            `Get-WmiObject -Class Win32_Printer | Where-Object { $_.PortName -like 'USB*' } | Select-Object Name,WorkOffline,PrinterStatus`
        );
        // PowerShell pode retornar null (0 itens), objeto único (1 item) ou array (N).
        // O monitor normaliza com `Array.isArray(result) ? result : (result ? [result] : [])`.
        const list = Array.isArray(result) ? result : (result ? [result] : []);
        for (const p of list) {
            assert.ok(typeof p.Name === 'string', `cada item precisa ter Name string; got ${typeof p.Name}`);
            assert.ok(typeof p.WorkOffline === 'boolean', `WorkOffline precisa ser boolean; got ${typeof p.WorkOffline}`);
            assert.ok(typeof p.PrinterStatus === 'number', `PrinterStatus precisa ser number; got ${typeof p.PrinterStatus}`);
        }
    } finally {
        pshost.stop();
    }
});

test('Monitor: _getUsbStatus retorna objeto com 5 campos quando impressora existe', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();

        const name = await pickAnyPrinter(pshost);
        const safe = name.replace(/'/g, "''");
        const cmd = `
$p = Get-WmiObject -Class Win32_Printer -Filter "Name='${safe}'" -ErrorAction SilentlyContinue
if (-not $p) { $null } else {
  $j = @(Get-PrintJob -PrinterName '${safe}' -ErrorAction SilentlyContinue)
  $portHost = $null
  try {
    $port = Get-Printer -Name '${safe}' -ErrorAction SilentlyContinue | Get-PrinterPort -ErrorAction SilentlyContinue
    if ($port -and $port.PrinterHostAddress -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$') { $portHost = $port.PrinterHostAddress }
  } catch {}
  [PSCustomObject]@{
    Name = $p.Name
    PrinterStatus = $p.PrinterStatus
    WorkOffline = $p.WorkOffline
    JobCount = $j.Count
    HostAddress = $portHost
  }
}`.trim();

        const result = await pshost.runJson(cmd);
        assert.ok(result, `_getUsbStatus(${name}) não pode retornar null se a impressora existe`);
        assert.equal(result.Name, name, 'Name deve bater com o pedido');
        assert.ok(typeof result.PrinterStatus === 'number', 'PrinterStatus number');
        assert.ok(typeof result.WorkOffline === 'boolean', 'WorkOffline boolean');
        assert.ok(typeof result.JobCount === 'number', 'JobCount number');
        // HostAddress pode ser string (rede) ou null (USB) — só não pode estar ausente do schema
        assert.ok(Object.prototype.hasOwnProperty.call(result, 'HostAddress'), 'HostAddress deve existir no objeto');
        // Crucial — não pode ter vazamento do WMI cru (bug do `& {}`)
        assert.equal(result.Scope, undefined, 'não pode ter Scope (vazamento WMI)');
        assert.equal(result.__SUPERCLASS, undefined, 'não pode ter properties WMI internas');
    } finally {
        pshost.stop();
    }
});

test('Monitor: _getUsbStatus retorna null para nome inexistente', async () => {
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        const cmd = `
$p = Get-WmiObject -Class Win32_Printer -Filter "Name='__NAO_EXISTE_NUNCA_${Date.now()}__'" -ErrorAction SilentlyContinue
if (-not $p) { $null } else {
  [PSCustomObject]@{ Name = $p.Name }
}`.trim();
        const result = await pshost.runJson(cmd);
        assert.equal(result, null);
    } finally {
        pshost.stop();
    }
});

test('REGRESSÃO BUG-$HOST-RESERVADO: $portHost (não $host) funciona como variável', async () => {
    // $host é variável automática read-only do PowerShell. O monitor original usava
    // $host = $null que lançava "Cannot overwrite variable Host because it is read-only".
    // Garantimos aqui que $portHost (nome usado agora) funciona como variável normal.
    // A verificação de que monitor.js NÃO contém "$host =" está em regression.test.js.
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();

        const result = await pshost.run(`
$portHost = $null
$portHost = 'ok-string'
[Console]::WriteLine($portHost)
`, { raw: true });
        assert.match(result, /ok-string/, '$portHost deve ser assignável e legível');
    } finally {
        pshost.stop();
    }
});

test('Monitor: filter WMI escapa aspas simples corretamente', async () => {
    // Se um nome de impressora tiver aspa simples, o escape deve duplicar.
    // Testamos com Get-Printer (que aceita -Name diretamente sem WQL).
    const pshost = loadFreshPSHost();
    try {
        pshost.start();
        await pshost.waitReady();
        const name = await pickAnyPrinter(pshost);
        const safe = name.replace(/'/g, "''");
        const result = await pshost.runJson(`Get-Printer -Name '${safe}' -ErrorAction SilentlyContinue | Select-Object Name`);
        const got = Array.isArray(result) ? result[0] : result;
        assert.equal(got.Name, name);
    } finally {
        pshost.stop();
    }
});
