const state = require('../config/state');
const logger = require('../utils/logger');
const auth = require('./auth'); // Para acessar o client supabase

class Database {
    get supabase() {
        return auth.client;
    }

    /**
     * Sincroniza a configuração da impressora do Cloud para o Local.
     */
    async syncConfig() {
        if (!state.isAuthenticated()) {
            logger.error('DB', 'Tentativa de sync sem autenticação.');
            return false;
        }

        try {
            logger.info('DB', `Buscando configurações para empresa: ${state.companyId}...`);

            const { data, error } = await this.supabase
                .from('printer_settings')
                .select('*')
                .eq('company_id', state.companyId)
                .maybeSingle();

            if (error) {
                logger.error('DB', 'Erro ao buscar printer_settings', error.message);
                return false; // Falha de rede/banco
            }

            if (data) {
                // Configuração existe no banco
                state.setConfig(data);
                logger.info('DB', 'Configurações sincronizadas com sucesso.');
                return true;
            } else {
                // Configuração não existe
                logger.warn('DB', 'Nenhuma configuração encontrada no servidor.');
                return true; // Sucesso (simplesmente não tem config)
            }
        } catch (e) {
            logger.error('DB', 'Exceção no Sync', e.message);
            return false;
        }
    }

    /**
     * Salva a configuração local no Cloud (UPSERT manual).
     */
    async saveConfig(newConfig) {
        if (!state.isAuthenticated()) throw new Error("Não autenticado");

        const payload = {
            company_id: state.companyId,
            name: newConfig.printerName || state.currentConfig.printerName,
            printer_type: newConfig.printerType,
            printer_identifier: newConfig.printerIdentifier, // IP ou Nome USB
            updated_at: new Date()
        };

        try {
            // Estratégia Safe Upsert (Check -> Insert/Update)
            // para evitar erro se não houver UNIQUE CONSTRAINT no company_id

            const { data: existing } = await this.supabase
                .from('printer_settings')
                .select('id')
                .eq('company_id', state.companyId)
                .maybeSingle();

            let error;
            if (existing) {
                // Update
                const res = await this.supabase
                    .from('printer_settings')
                    .update(payload)
                    .eq('id', existing.id);
                error = res.error;
            } else {
                // Insert
                const res = await this.supabase
                    .from('printer_settings')
                    .insert([payload]);
                error = res.error;
            }

            if (error) throw error;

            // Atualiza estado local imediatamente
            state.setConfig(payload);
            logger.info('DB', 'Configurações salvas no servidor.');
            return true;
        } catch (e) {
            logger.error('DB', 'Erro ao salvar config', e.message);
            throw e;
        }
    }
    async sendHeartbeat() {
        if (!state.isAuthenticated()) return;

        try {
            // Como o supabase-js não aceita 'now()' facilmente em .update(),
            // usamos o ISO atual, mas vamos aumentar a tolerância no frontend.
            await this.supabase
                .from('printer_settings')
                .update({ last_seen: new Date().toISOString() })
                .eq('company_id', state.companyId);
        } catch (e) {
            // Silent error
        }
    }

    /**
     * SECURITY (v3.2.4) — publica o agent_token em printer_settings para que
     * o frontend autenticado da empresa consiga ler e enviá-lo nos headers de
     * impressão direta. RLS na tabela garante isolamento por company_id.
     *
     * Cria a linha se não existir (caso o user nunca tenha configurado
     * impressora antes — sem isso, frontend não tem onde ler o token).
     */
    async syncAgentToken(token) {
        if (!state.isAuthenticated()) return false;
        try {
            const { data: existing, error: readErr } = await this.supabase
                .from('printer_settings')
                .select('id, agent_token')
                .eq('company_id', state.companyId)
                .maybeSingle();
            if (readErr) {
                logger.warn('DB', 'syncAgentToken: falha ao ler printer_settings', readErr.message);
                return false;
            }

            if (existing) {
                if (existing.agent_token === token) return true; // já sincronizado
                const { error } = await this.supabase
                    .from('printer_settings')
                    .update({ agent_token: token, updated_at: new Date().toISOString() })
                    .eq('id', existing.id);
                if (error) {
                    logger.warn('DB', 'syncAgentToken: update falhou', error.message);
                    return false;
                }
                logger.info('DB', 'agent_token atualizado em printer_settings.');
            } else {
                const { error } = await this.supabase
                    .from('printer_settings')
                    .insert([{
                        company_id: state.companyId,
                        agent_token: token,
                        updated_at: new Date().toISOString(),
                    }]);
                if (error) {
                    logger.warn('DB', 'syncAgentToken: insert falhou', error.message);
                    return false;
                }
                logger.info('DB', 'agent_token criado em printer_settings.');
            }
            return true;
        } catch (e) {
            logger.warn('DB', 'syncAgentToken: exceção', e.message);
            return false;
        }
    }

    async updateJobStatus(id, status, errorMsg = null) {
        if (!state.isAuthenticated()) return;
        try {
            await this.supabase
                .from('print_queue')
                .update({
                    status,
                    error_message: errorMsg,
                    updated_at: new Date()
                })
                .eq('id', id);
        } catch (e) {
            logger.error('DB', 'Erro ao atualizar status do job ' + id, e.message);
        }
    }
}

module.exports = new Database();
