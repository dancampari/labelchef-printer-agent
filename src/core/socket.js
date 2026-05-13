const state = require('../config/state');
const logger = require('../utils/logger');
const auth = require('./auth');

/**
 * Socket — Realtime + polling adaptativo.
 *
 * Antes: polling rodava a cada 15s SEMPRE, mesmo com Realtime SUBSCRIBED.
 * Antes (v3.9.5 e anteriores): watchdog SUBSCRIBED só verificava status, NÃO
 * drenava pending. Problema: quando o canal do Supabase ficava "stuck
 * SUBSCRIBED" (mostra conectado mas não entrega eventos — comum em redes
 * flaky / wake-from-sleep / NAT rebind), jobs vindos de mobile/outro client
 * sentavam até o heartbeat do client Supabase derrubar o canal (30-60s).
 *
 * Agora (v3.9.6+):
 *  - Quando SUBSCRIBED: watchdog a cada 20s, verifica status E drena pending
 *    como rede de segurança. Cobre o "stuck SUBSCRIBED" do Realtime.
 *    Custo: 1 SELECT a cada 20s por agent (negligenciável).
 *  - Quando NÃO SUBSCRIBED: polling de 15s reconecta e busca jobs pendentes.
 *  - Realtime continua sendo o caminho rápido (push instantâneo); o drain
 *    do watchdog é só safety net pra latência máxima ficar ~20s no pior caso.
 */

const RECONNECT_POLL_MS = 15_000;
const WATCHDOG_MS = 20_000;

class Socket {
    constructor() {
        this.subscription = null;
        this.handler = null;
        this.timer = null;
        this.timerKind = null; // 'reconnect' | 'watchdog'
    }

    setHandler(fn) {
        this.handler = fn;
    }

    connect() {
        if (!state.isAuthenticated()) {
            logger.warn('SOCKET', 'Não conectado: falta autenticação.');
            return;
        }
        if (this.subscription) this.disconnect();

        logger.info('SOCKET', `Iniciando Realtime para company_id: ${state.companyId}`);

        this.subscription = auth.client.channel('agent_queue')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'print_queue',
                    filter: `company_id=eq.${state.companyId}`
                },
                (payload) => {
                    logger.info('SOCKET', 'Novo job via Realtime', { id: payload.new.id });
                    if (this.handler) this.handler(payload.new);
                }
            )
            .subscribe((status, err) => {
                state.connStatus = status;
                logger.info('SOCKET', `Status: ${status}`);

                if (status === 'SUBSCRIBED') {
                    logger.info('SOCKET', 'Realtime ativo. Watchdog em modo leve.');
                    this._switchTimer('watchdog');
                    // Drena qualquer job que ficou pendente enquanto estávamos desconectados
                    this._drainPending().catch((e) => logger.warn('SOCKET', 'drain inicial falhou', e.message));
                } else if (err) {
                    logger.error('SOCKET', 'Erro na subscrição', err.message);
                    this._switchTimer('reconnect');
                }
            });

        // Enquanto não chega SUBSCRIBED, ficamos em modo reconnect
        this._switchTimer('reconnect');
    }

    /**
     * Compatibilidade com a API anterior. Apenas garante que o timer está
     * configurado conforme o status atual (watchdog se SUBSCRIBED, reconnect caso contrário).
     */
    startPolling() {
        if (state.connStatus === 'SUBSCRIBED') {
            this._switchTimer('watchdog');
        } else {
            this._switchTimer('reconnect');
        }
    }

    disconnect() {
        this._clearTimer();
        if (this.subscription) {
            try { auth.client.removeChannel(this.subscription); } catch { /* ignore */ }
            this.subscription = null;
            state.connStatus = 'DISCONNECTED';
            logger.info('SOCKET', 'Desconectado.');
        }
    }

    // ── Internos ───────────────────────────────────────────────────────────
    _switchTimer(kind) {
        if (this.timerKind === kind && this.timer) return;
        this._clearTimer();
        this.timerKind = kind;
        const interval = kind === 'watchdog' ? WATCHDOG_MS : RECONNECT_POLL_MS;

        this.timer = setInterval(async () => {
            if (!state.isAuthenticated()) return;

            if (kind === 'watchdog') {
                // Caminho feliz: Realtime ativo. Verifica status...
                if (state.connStatus !== 'SUBSCRIBED') {
                    logger.warn('WATCHDOG', `Status caiu para ${state.connStatus}. Reconectando...`);
                    this.connect(); // já recria timer, e drena ao reconectar
                    return;
                }
                // ...E drena pending como safety net contra "stuck SUBSCRIBED"
                // (Realtime mostra conectado mas não entrega eventos). Sem isso,
                // jobs inseridos por outros clientes (ex.: mobile na nuvem) podiam
                // sentar até o cliente Supabase derrubar o canal (30-60s).
                await this._drainPending().catch((e) => logger.error('SOCKET', 'erro no drain watchdog', e.message));
                return;
            }

            // kind === 'reconnect': polling completo enquanto Realtime não sobe
            try {
                if (state.connStatus !== 'SUBSCRIBED') {
                    logger.warn('WATCHDOG', `Reconectando (status=${state.connStatus || 'null'})`);
                    this.connect();
                    return; // connect() já fará drain ao receber SUBSCRIBED
                }
            } catch (e) {
                logger.error('SOCKET', 'erro no reconnect', e.message);
            }

            // Fallback de jobs pendentes (caso Realtime esteja flaky)
            await this._drainPending().catch((e) => logger.error('SOCKET', 'erro no polling', e.message));
        }, interval);
    }

    _clearTimer() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.timerKind = null;
    }

    async _drainPending() {
        const { data, error } = await auth.client
            .from('print_queue')
            .select('*')
            .eq('company_id', state.companyId)
            .in('status', ['pending', 'processing']);
        if (error) throw error;
        if (data && data.length && this.handler) {
            logger.info('SOCKET', `Drenando ${data.length} job(s) pendente(s)`);
            for (const job of data) this.handler(job);
        }
    }
}

module.exports = new Socket();
