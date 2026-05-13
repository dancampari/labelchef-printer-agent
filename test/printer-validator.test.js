/**
 * printerValidator — testes unitários (puros, sem PowerShell/Electron).
 *
 * Esses testes garantem que nenhum nome inválido escape para o
 * `webContents.print` (que cairia na impressora padrão do Windows).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidPrinterName, safePrinterName, MAX_PRINTER_NAME_LENGTH } = require('../src/utils/printerValidator');

test('isValidPrinterName: nomes comuns aceitos', () => {
    assert.equal(isValidPrinterName('CAIXA'), true);
    assert.equal(isValidPrinterName('Brother HL-5350DN series Printer'), true);
    assert.equal(isValidPrinterName('ZDesigner ZD220-203dpi ZPL'), true);
    assert.equal(isValidPrinterName('Epson TM-T20 (USB)'), true);
    assert.equal(isValidPrinterName('Impressora Térmica 80mm'), true); // unicode OK
});

test('isValidPrinterName: rejeita undefined/null/não-string', () => {
    assert.equal(isValidPrinterName(undefined), false);
    assert.equal(isValidPrinterName(null), false);
    assert.equal(isValidPrinterName(42), false);
    assert.equal(isValidPrinterName({}), false);
    assert.equal(isValidPrinterName([]), false);
    assert.equal(isValidPrinterName(false), false);
});

test('isValidPrinterName: rejeita string vazia / só espaços', () => {
    assert.equal(isValidPrinterName(''), false);
    assert.equal(isValidPrinterName('   '), false);
    assert.equal(isValidPrinterName('\t\n  '), false);
});

test('isValidPrinterName: rejeita caracteres de controle (NUL etc)', () => {
    assert.equal(isValidPrinterName('CAIXA\x00'), false);
    assert.equal(isValidPrinterName('CAIXA\x01'), false);
    assert.equal(isValidPrinterName('FOO\x7fBAR'), false);
});

test('isValidPrinterName: rejeita nomes absurdamente longos', () => {
    const huge = 'A'.repeat(MAX_PRINTER_NAME_LENGTH + 1);
    assert.equal(isValidPrinterName(huge), false);
    const ok = 'A'.repeat(MAX_PRINTER_NAME_LENGTH);
    assert.equal(isValidPrinterName(ok), true);
});

test('safePrinterName: retorna primeiro candidato válido com trim', () => {
    assert.equal(safePrinterName('  CAIXA  '), 'CAIXA');
    assert.equal(safePrinterName(null, undefined, 'PRINTER'), 'PRINTER');
    assert.equal(safePrinterName('', '  ', 'X'), 'X');
});

test('safePrinterName: retorna null se TODOS inválidos (não cai na default)', () => {
    assert.equal(safePrinterName(), null);
    assert.equal(safePrinterName(null), null);
    assert.equal(safePrinterName('', null, undefined), null);
    assert.equal(safePrinterName('\x00', '   ', 42), null);
});

test('safePrinterName: pula candidato inválido e usa o próximo válido', () => {
    // simulação: req.body.printerName ausente, state.currentConfig.printerName ok
    assert.equal(
        safePrinterName(undefined, 'CAIXA', 'fallback'),
        'CAIXA',
    );
    // primeiro tem caractere de controle, vai pro segundo
    assert.equal(
        safePrinterName('BAD\x00NAME', 'GoodName'),
        'GoodName',
    );
});
