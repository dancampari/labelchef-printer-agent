class State {
    constructor() {
        if (State.instance) {
            return State.instance;
        }
        State.instance = this;

        this.reset();
    }

    reset() {
        this.session = null;         // Supabase Session Object (contains access_token)
        this.companyId = null;       // UUID da Empresa (Fonte da Verdade)
        this.userProfile = null;     // Dados completos do perfil logado
        this.explicitLogout = false; // Flag: impede auto-login após logout intencional

        this.currentConfig = {
            printerType: null,       // 'usb', 'network', 'generic_pdf'
            printerIdentifier: null, // Printer Name (USB) ou IP (Rede)
            printerName: null        // Nome fantasia/apelido no banco
        };

        this.connStatus = "DISCONNECTED"; // DISCONNECTED, CONNECTING, ONLINE, ERROR

        this.stats = {
            startTime: new Date(),
            totalJobs: 0,
            successJobs: 0,
            failedJobs: 0,
            lastJobTime: null,
            lastJobTime: null,
            uptime: 0
        };

        this.printerStatus = {
            isOnline: false,
            message: 'Aguardando diagnóstico...',
            lastCheck: new Date(),
            lastCheck: new Date(),
            pendingJobs: 0,
            isBusy: false
        };

        // Estado do auto-updater, espelhado do main.js via IPC. Exposto pelo /api/health.
        this.updateStatus = { status: 'idle' };
    }

    setSession(session, profile, companyId) {
        this.session = session;
        this.userProfile = profile;
        this.companyId = companyId;
        this.companyName = profile ? profile.company_name : null;
    }

    setConfig(config) {
        // Mapeamento seguro do banco para o estado interno
        if (!config) return;
        this.currentConfig.printerType = config.printer_type;
        this.currentConfig.printerIdentifier = config.printer_identifier;
        this.currentConfig.printerName = config.name;
    }

    isAuthenticated() {
        return !!(this.session && this.session.access_token && this.companyId);
    }
}

module.exports = new State();
