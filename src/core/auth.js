const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const CONSTANTS = require('../config/constants');
const state = require('../config/state');
const logger = require('../utils/logger');

// Init Supabase Client
const supabase = createClient(CONSTANTS.SUPABASE_URL, CONSTANTS.SUPABASE_ANON_KEY);

// IPC Promise Manager for SafeStorage
const pendingRequests = new Map();

// Helper para gerar IDs únicos para IPC
const generateId = () => Math.random().toString(36).substring(7);

// Listener do IPC
process.on('message', (msg) => {
    if (msg.type === 'ENCRYPT_RESULT' || msg.type === 'DECRYPT_RESULT') {
        const resolver = pendingRequests.get(msg.id);
        if (resolver) {
            if (msg.success) resolver.resolve(msg.data);
            else resolver.reject(new Error(msg.error));
            pendingRequests.delete(msg.id);
        }
    }
});

/**
 * Solicita encriptação ao Processo Principal (Electron)
 */
function safeEncrypt(text) {
    return new Promise((resolve, reject) => {
        if (!process.send) return reject(new Error('IPC não disponível'));
        const id = generateId();
        pendingRequests.set(id, { resolve, reject });
        process.send({ type: 'ENCRYPT', id, data: text });

        // Timeout de segurança
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error('Timeout na encriptação'));
            }
        }, 5000);
    });
}

/**
 * Solicita decriptação ao Processo Principal (Electron)
 */
function safeDecrypt(hex) {
    return new Promise((resolve, reject) => {
        if (!process.send) return reject(new Error('IPC não disponível'));
        const id = generateId();
        pendingRequests.set(id, { resolve, reject });
        process.send({ type: 'DECRYPT', id, dataHex: hex });

        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error('Timeout na decriptação'));
            }
        }, 5000);
    });
}

const SESSION_FILE = path.join(logger.getLogPath(), '..', 'session.secure');

class Auth {
    constructor() {
        this.client = supabase;
    }

    async init() {
        logger.info('AUTH', 'Inicializando módulo de autenticação...');
        try {
            if (fs.existsSync(SESSION_FILE)) {
                const encrypted = fs.readFileSync(SESSION_FILE, 'utf8');
                logger.info('AUTH', 'Sessão encontrada em disco. Tentando decriptar...');

                let sessionJson;
                try {
                    sessionJson = await safeDecrypt(encrypted);
                } catch (e) {
                    logger.error('AUTH', 'Falha ao decriptar sessão (chave inválida ou ambiente diferente).', e.message);
                    return false;
                }

                // Parse da sessão
                let sessionData;
                try {
                    sessionData = JSON.parse(sessionJson);
                } catch (e) {
                    // Fallback: se não for JSON, assume que é só o access_token (compatibilidade)
                    sessionData = { access_token: sessionJson, refresh_token: sessionJson };
                }

                // Restaura a sessão no cliente Supabase
                const { data: restoredSession, error: sessionError } = await supabase.auth.setSession({
                    access_token: sessionData.access_token,
                    refresh_token: sessionData.refresh_token
                });

                if (sessionError || !restoredSession.user) {
                    logger.warn('AUTH', 'Token expirado ou inválido.', sessionError ? sessionError.message : '');
                    this.logout();
                    return false; // Precisa relogar
                }

                // Sessão válida! Agora busca o context (company_id)
                logger.info('AUTH', 'Sessão restaurada para usuário:', restoredSession.user.email);
                return await this.loadUserContext(restoredSession.user);
            }
        } catch (e) {
            logger.error('AUTH', 'Erro na inicialização da auth', e.message);
        }
        return false;
    }

    async login(email, password) {
        logger.info('AUTH', `Tentativa de login para: ${email}`);

        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            logger.warn('AUTH', 'Falha no login', error.message);
            throw error;
        }

        // Login Sucesso
        const success = await this.loadUserContext(data.user);
        if (success) {
            // Salva sessão completa (access + refresh tokens) para persistência longa
            await this.persistSession(data.session);
        }
        return success;
    }

    async loadUserContext(user) {
        // Busca o Perfil para pegar o company_id
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (error || !profile) {
            logger.error('AUTH', 'Usuário sem perfil vinculado.');
            return false;
        }

        if (!profile.company_id) {
            logger.error('AUTH', 'CRÍTICO: Usuário não tem empresa (company_id) vinculada. Acesso negado.');
            await supabase.auth.signOut();
            return false;
        }

        // Atualiza estado global
        // Precisamos reconstruir um objeto "session" mínimo se viemos do persistence (apenas token)
        // Se viemos do login, temos data.session completo.
        // Aqui simplificamos usando o user e company.
        state.setSession({ access_token: 'valid' }, profile, profile.company_id);

        logger.info('AUTH', `Contexto carregado. Empresa: ${profile.company_name || 'N/A'} (ID: ${profile.company_id})`);
        return true;
    }

    async persistSession(session) {
        try {
            // Salva a sessão completa como JSON
            const sessionJson = JSON.stringify({
                access_token: session.access_token,
                refresh_token: session.refresh_token
            });
            const encrypted = await safeEncrypt(sessionJson);
            fs.writeFileSync(SESSION_FILE, encrypted);
            logger.info('AUTH', 'Sessão salva em disco com segurança (SafeStorage).');
        } catch (e) {
            logger.error('AUTH', 'Falha ao salvar sessão em disco', e.message);
        }
    }

    async logout() {
        await supabase.auth.signOut();
        state.reset();
        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
        // Note: We do NOT clear saved credentials here, as "Remember Me" should persist across logouts based on user intent.
        // If we want to offer "Forget Me", that would be a separate action or unchecking the box next time.
        logger.info('AUTH', 'Logout efetuado.');
    }

    // --- Credential Persistence (Remember Me) ---

    getCredentialsPath() {
        return path.join(logger.getLogPath(), '..', 'credentials.secure');
    }

    async saveCredentials(email, password) {
        try {
            const data = JSON.stringify({ email, password });
            const encrypted = await safeEncrypt(data);
            fs.writeFileSync(this.getCredentialsPath(), encrypted);
            logger.info('AUTH', 'Credenciais salvas com segurança.');
            return true;
        } catch (e) {
            logger.error('AUTH', 'Erro ao salvar credenciais:', e.message);
            return false;
        }
    }

    async loadCredentials() {
        try {
            const filePath = this.getCredentialsPath();
            if (!fs.existsSync(filePath)) return null;

            const encrypted = fs.readFileSync(filePath, 'utf8');
            const decrypted = await safeDecrypt(encrypted);
            return JSON.parse(decrypted);
        } catch (e) {
            logger.warn('AUTH', 'Não foi possível carregar credenciais salvas (pode estar vazio ou corrompido).');
            return null;
        }
    }

    async clearCredentials() {
        try {
            const filePath = this.getCredentialsPath();
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logger.info('AUTH', 'Credenciais salvas removidas.');
            }
        } catch (e) {
            logger.error('AUTH', 'Erro ao limpar credenciais:', e.message);
        }
    }
}

// Exporta a instância como default + helpers IPC para outros módulos que
// precisam de criptografia em disco (agentToken).
const authInstance = new Auth();
module.exports = authInstance;
module.exports.safeEncrypt = safeEncrypt;
module.exports.safeDecrypt = safeDecrypt;
