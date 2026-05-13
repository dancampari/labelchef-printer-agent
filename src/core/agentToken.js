/**
 * Agent Token — segredo compartilhado entre o agent local e a empresa no
 * Supabase para autenticar requisições aos endpoints sensíveis
 * (`/api/local-print` e `/api/local-print-batch`).
 *
 * Threat model (v3.2.4):
 *   - CSRF cross-site já é mitigado pelo CORS regex em v3.2.3.
 *   - Resta o caminho "processo local malicioso": malware, extensão de browser
 *     com permissão de host, app spyware. Esses não passam pelo CORS porque
 *     não rodam num browser com Origin. Token resolve.
 *
 * Onde fica:
 *   - Disco local: `data/agent.token` (criptografado via Electron safeStorage /
 *     DPAPI no Windows). Só o user-account do Windows que instalou descriptografa.
 *   - Supabase: coluna `printer_settings.agent_token` (RLS company-scoped).
 *     Frontend autenticado lê e envia em `X-Agent-Token` header.
 *
 * Lifecycle:
 *   - Primeira vez: gera 32 bytes hex (256 bits entropia).
 *   - Carrega do disco em runs subsequentes.
 *   - Após login, publica em printer_settings (database.syncAgentToken).
 *   - Validação: comparação constant-time (timingSafeEqual) no middleware.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// safeEncrypt/safeDecrypt expostos via auth.js (IPC bridge p/ Electron main).
const { safeEncrypt, safeDecrypt } = require('./auth');

const TOKEN_FILE = path.join(logger.getLogPath(), '..', 'agent.token');
const TOKEN_BYTES = 32; // 256 bits — overkill mas barato.

let cachedToken = null;

function generate() {
    return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Garante que um token existe. Carrega do disco se houver; senão cria e persiste.
 * Idempotente — chamadas subsequentes retornam o token cacheado.
 */
async function ensureToken() {
    if (cachedToken) return cachedToken;

    if (fs.existsSync(TOKEN_FILE)) {
        try {
            const encrypted = fs.readFileSync(TOKEN_FILE, 'utf8');
            const decrypted = await safeDecrypt(encrypted);
            if (decrypted && /^[a-f0-9]{64}$/.test(decrypted)) {
                cachedToken = decrypted;
                logger.info('AGENT_TOKEN', 'Token carregado do disco.');
                return cachedToken;
            }
            logger.warn('AGENT_TOKEN', 'Token em disco inválido — regerando.');
        } catch (e) {
            logger.warn('AGENT_TOKEN', 'Falha ao decriptar token — regerando.', e.message);
        }
    }

    // Gera novo
    const token = generate();
    try {
        const encrypted = await safeEncrypt(token);
        fs.writeFileSync(TOKEN_FILE, encrypted, { mode: 0o600 });
        cachedToken = token;
        logger.info('AGENT_TOKEN', 'Novo token gerado e persistido.');
        return token;
    } catch (e) {
        logger.error('AGENT_TOKEN', 'Falha ao persistir token — usando in-memory only.', e.message);
        cachedToken = token; // continua funcionando mas perde no restart
        return token;
    }
}

/**
 * Comparação constant-time para evitar timing attacks (irrelevante na prática
 * para 64-char tokens, mas é o padrão de segurança e custa nada).
 */
function validateToken(provided) {
    if (!cachedToken || !provided) return false;
    if (typeof provided !== 'string') return false;
    if (provided.length !== cachedToken.length) return false;
    try {
        return crypto.timingSafeEqual(
            Buffer.from(provided, 'utf8'),
            Buffer.from(cachedToken, 'utf8'),
        );
    } catch {
        return false;
    }
}

function getToken() {
    return cachedToken;
}

module.exports = { ensureToken, validateToken, getToken };
