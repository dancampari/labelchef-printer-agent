/**
 * printerValidator — defesa central contra "default printer fallback" do SO.
 *
 * Documentação Electron: webContents.print({ deviceName }) — se deviceName for
 * blank/inválido, o Electron usa a IMPRESSORA PADRÃO do Windows. Em ambientes
 * compartilhados isso pode imprimir recibo OnTrack na impressora de outro setor.
 *
 * Centralizamos aqui a validação para que:
 *  - `agent.js` (processJob, requestHtmlPrint, requestTestPrint) rejeite o job
 *    ANTES de enviar IPC com nome vazio.
 *  - `main.js` (handlers PRINT_HTML, PRINT_TEST_LABEL, spooler-ready) valide
 *    UMA segunda vez antes de tocar em `webContents.print`.
 *  - `controllers.js` (localPrint, localPrintBatch, testPrint) consolide o
 *    fallback de candidatos (req.body → state.currentConfig).
 *
 * É defesa em profundidade: cada camada valida porque um bug em uma não pode
 * vazar para a default do SO.
 */

const MAX_PRINTER_NAME_LENGTH = 256;

/**
 * Valida nome de impressora. Retorna true só se for string não-vazia, dentro
 * de tamanho razoável, sem caracteres de controle (NUL, etc).
 *
 * NÃO restringe charset (impressoras podem ter espaços, hífens, parênteses,
 * caracteres unicode, etc). A defesa contra injeção PowerShell é responsabilidade
 * de quem monta o script (já feita em printerUSB.js via replace de aspas).
 */
function isValidPrinterName(name) {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (trimmed.length > MAX_PRINTER_NAME_LENGTH) return false;
    // Sem caracteres de controle ASCII (0x00–0x1F + 0x7F)
    if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
    return true;
}

/**
 * Devolve o primeiro candidato válido, já com trim aplicado. Retorna null se
 * NENHUM for válido — chamador DEVE rejeitar o job (não cair para default).
 *
 * Uso típico: safePrinterName(req.body.printerName, state.currentConfig.printerName)
 */
function safePrinterName(...candidates) {
    for (const c of candidates) {
        if (isValidPrinterName(c)) return c.trim();
    }
    return null;
}

module.exports = {
    isValidPrinterName,
    safePrinterName,
    MAX_PRINTER_NAME_LENGTH,
};
