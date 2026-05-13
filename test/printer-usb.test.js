const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// LabelChef mantém o pipeline Win32 RAW inline em printerUSB.print()
// (não refatorado para pshost — preservar funcionalidades de impressão).
// Estes testes verificam que o pipeline INLINE permanece consistente:
//   - PowerShell helper class RawPrinterHelper presente no script inline
//   - sanitização do nome de impressora antes de injetar no script
//   - CP850 encoding usado (para acentos em ZPL raw)
//   - SUCCESS/ERROR_SPOOLER usados como marcadores Write-Output

const PRINTER_USB_PATH = path.join(__dirname, '..', 'src', 'services', 'printerUSB.js');
const SOURCE = fs.readFileSync(PRINTER_USB_PATH, 'utf8');

test('PrinterUSB: script PowerShell inline define RawPrinterHelper', () => {
    assert.ok(
        SOURCE.includes('class RawPrinterHelper'),
        'classe RawPrinterHelper deveria estar definida no script inline'
    );
    assert.ok(
        SOURCE.includes('OpenPrinterA') && SOURCE.includes('WritePrinter') && SOURCE.includes('EndDocPrinter'),
        'P/Invoke do winspool.drv (OpenPrinter / WritePrinter / EndDocPrinter) deve estar presente'
    );
});

test('PrinterUSB: documento usa DataType RAW (envio direto pra Zebra ZPL)', () => {
    assert.ok(
        SOURCE.includes('pDataType = "RAW"'),
        'DOCINFOA.pDataType deve ser "RAW" para evitar conversão GDI'
    );
});

test('PrinterUSB: encoding CP850 aplicado ao ZPL antes de gravar arquivo temp', () => {
    assert.ok(
        SOURCE.includes('iconv') && SOURCE.includes('cp850'),
        'iconv-lite encode(..., cp850) deve estar no pipeline (suporte a acentos)'
    );
});

test('PrinterUSB: sanitização do nome — regex de allowlist no printerName', () => {
    const regexMatch = SOURCE.match(/!\s*\/\^[^/]+\/\.test\(printerName\)/);
    assert.ok(regexMatch, 'deveria haver uma validação regex do printerName antes de usar no script');
});

test('PrinterUSB: marcadores de retorno SUCCESS / ERROR_SPOOLER presentes', () => {
    assert.ok(
        SOURCE.includes('Write-Output "SUCCESS"'),
        'script deve escrever "SUCCESS" no caminho feliz'
    );
    assert.ok(
        SOURCE.includes('ERROR_SPOOLER'),
        'script deve escrever "ERROR_SPOOLER" no caminho de falha do spooler'
    );
});

test('PrinterUSB.fixQueue: usa Get-PrintJob | Remove-PrintJob', () => {
    assert.ok(
        SOURCE.includes('Get-PrintJob') && SOURCE.includes('Remove-PrintJob'),
        'fixQueue deveria limpar a fila via Get-PrintJob | Remove-PrintJob'
    );
});

test('PrinterUSB.fixQueue: marcador FIXED:<count> presente no output do script', () => {
    assert.ok(
        SOURCE.includes('FIXED:'),
        'script de fixQueue deveria escrever "FIXED:<count>" para reportar quantidade limpa'
    );
});

test('PrinterUSB: arquivo temp limpo no finally (sem deixar lixo em os.tmpdir)', () => {
    assert.ok(
        SOURCE.includes('fs.unlinkSync(tempFilePath)') || SOURCE.includes('unlinkSync(tempFilePath)'),
        'arquivo temp .zpl deve ser apagado após impressão (no finally)'
    );
});
