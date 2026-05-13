/* ==================================================================================
   LABELCHEF PRINTER AGENT - DASHBOARD FRONTEND LOGIC
   v3.0.4 - Refatorado com melhorias de UX e segurança
   ================================================================================== */

// Estado global
let isRestaurantIdLocked = true;
let lastDiagTime = 0;
let isLogAutoScroll = true;
let lastTriggerLogTime = ''; // Controle para não atualizar repetidamente pelo mesmo log

// Estado do auto-update (alimentado por pollUpdateStatus a cada 5s)
let lastUpdateState = null;

// ==================================================================================
// TOAST NOTIFICATIONS
// ==================================================================================

function showToast(title, message, type = 'success') {
    const container = document.getElementById('toastContainer');


    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const iconName = {
        success: 'check_circle',
        error: 'cancel',
        warning: 'warning',
        info: 'info'
    };

    toast.innerHTML = `
        <div class="toast-icon ${type}">
            <span class="material-symbols-outlined">${iconName[type]}</span>
        </div>
        <div class="toast-content">
            <div class="toast-title">${escapeHtml(title)}</div>
            <div class="toast-message">${escapeHtml(message)}</div>
        </div>
    `;

    container.appendChild(toast);

    // Auto remove após 4 segundos
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ==================================================================================
// UTILITY FUNCTIONS
// ==================================================================================

function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatUptime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

// ==================================================================================
// CUSTOM CONFIRMATION MODAL
// ==================================================================================

let confirmModalResolve = null;

/**
 * Mostra um modal de confirmação customizado
 * @param {string} message - Mensagem a exibir
 * @param {string} title - Título do modal (opcional)
 * @param {string} icon - Ícone do Material Symbols (opcional)
 * @returns {Promise<boolean>} - true se confirmado, false se cancelado
 */
function showConfirmModal(message, title = 'Confirmação', icon = 'help') {
    return new Promise((resolve) => {
        confirmModalResolve = resolve;

        document.getElementById('confirmModalTitle').textContent = title;
        document.getElementById('confirmModalMessage').textContent = message;
        document.getElementById('confirmModalIcon').textContent = icon;

        const modal = document.getElementById('confirmModal');
        modal.style.display = 'flex';
        // Pequeno delay para permitir que o navegador renderize o display:flex antes de adicionar a classe (transição)
        setTimeout(() => modal.classList.add('active'), 10);

        // Fechar com ESC
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closeConfirmModal(false);
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        // Fechar ao clicar fora
        modal.onclick = (e) => {
            if (e.target === modal) {
                closeConfirmModal(false);
            }
        };
    });
}

function closeConfirmModal(confirmed) {
    const modal = document.getElementById('confirmModal');
    modal.classList.remove('active');

    // Aguarda a transição CSS (0.2s) terminar antes de esconder
    setTimeout(() => {
        modal.style.display = 'none';
    }, 200);

    if (confirmModalResolve) {
        confirmModalResolve(confirmed);
        confirmModalResolve = null;
    }
}

// ==================================================================================
// LOCK/UNLOCK RESTAURANT ID
// ==================================================================================

// ==================================================================================
// LOCK/UNLOCK RESTAURANT ID & SECURITY
// ==================================================================================

let currentAdminPin = "admin"; // Valor padrão, será atualizado pelo config do backend

// Lock/Visibility logic removed per user request


// ==================================================================================
// MODAL DE ACESSO (LOGIN)
// ==================================================================================

let pendingPasswordCallback = null;
let isProcessingPassword = false; // Flag de controle

function promptPassword(callback) {
    const modal = document.getElementById('passwordModal');
    const input = document.getElementById('modalPasswordInput');

    pendingPasswordCallback = callback;
    isProcessingPassword = false; // Reset da flag

    input.value = '';
    modal.style.display = 'flex';
    modal.classList.add('active');

    // Focus imediato usando requestAnimationFrame
    requestAnimationFrame(() => input.focus());
}

function closePasswordModal() {
    const modal = document.getElementById('passwordModal');
    modal.classList.remove('active');
    setTimeout(() => {
        modal.style.display = 'none';
        pendingPasswordCallback = null;
        isProcessingPassword = false; // Reset da flag
    }, 200);
}

function confirmPasswordModal() {
    // Previne dupla execução com flag
    if (isProcessingPassword) {
        return;
    }

    const input = document.getElementById('modalPasswordInput');
    const pwd = input.value;

    if (pendingPasswordCallback) {
        isProcessingPassword = true; // Marca como processando

        const callback = pendingPasswordCallback;
        pendingPasswordCallback = null; // Limpa imediatamente

        callback(pwd); // Executa
    }

    closePasswordModal();
}

// ==================================================================================
// MODAL DE TROCA DE SENHA
// ==================================================================================

function openChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    document.getElementById('newPasswordInput').value = '';
    document.getElementById('confirmPasswordInput').value = '';

    modal.style.display = 'flex';
    setTimeout(() => {
        modal.classList.add('active');
        document.getElementById('newPasswordInput').focus();
    }, 10);
}

function closeChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    modal.classList.remove('active');
    setTimeout(() => modal.style.display = 'none', 200);
}

async function saveNewPassword() {
    const p1 = document.getElementById('newPasswordInput').value;
    const p2 = document.getElementById('confirmPasswordInput').value;

    if (!p1 || p1.length < 4) {
        showToast('Senha Inválida', 'A senha deve ter pelo menos 4 caracteres.', 'error');
        return;
    }

    if (p1 !== p2) {
        showToast('Erro', 'As senhas não coincidem.', 'error');
        return;
    }

    // Salvar nova senha via endpoint config existente
    // Precisamos recriar o objeto config completo ou o endpoint faz merge?
    // O endpoint /config atual salva o corpo como config, então precisamos enviar tudo.
    // Melhor abordagem: Ler dados atuais do form, adicionar password e enviar.

    const configData = {
        printerType: document.getElementById('printerType').value,
        printerName: document.getElementById('printerName').value,
        printerIp: document.getElementById('printerIp').value,
        printerPort: document.getElementById('printerPort').value,
        printerNickname: document.getElementById('printerNickname').value,
        adminPassword: p1 // ADICIONA A NOVA SENHA
    };

    try {
        const response = await fetch('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(configData)
        });

        if (response.ok) {
            currentAdminPin = p1; // Atualiza localmente
            showToast('Sucesso', 'Nova senha de administrador salva!', 'success');
            closeChangePasswordModal();
        } else {
            showToast('Erro', 'Falha ao salvar nova senha.', 'error');
        }
    } catch (e) {
        showToast('Erro', 'Erro de conexão.', 'error');
    }
}

// Event Listeners Globais Modais
document.addEventListener('DOMContentLoaded', () => {
    // Listeners Modal Login
    const pwdInput = document.getElementById('modalPasswordInput');
    if (pwdInput) {
        pwdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // Previne dupla execução
                confirmPasswordModal();
            }
            if (e.key === 'Escape') closePasswordModal();
        });
    }
    const loginOverlay = document.getElementById('passwordModal');
    if (loginOverlay) {
        loginOverlay.addEventListener('click', (e) => { if (e.target === loginOverlay) closePasswordModal(); });
    }

    // Listeners Modal Change Password
    const newPwdInput = document.getElementById('confirmPasswordInput');
    if (newPwdInput) {
        newPwdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // Previne dupla execução
                saveNewPassword();
            }
            if (e.key === 'Escape') closeChangePasswordModal();
        });
    }
    const changeOverlay = document.getElementById('changePasswordModal');
    if (changeOverlay) {
        changeOverlay.addEventListener('click', (e) => { if (e.target === changeOverlay) closeChangePasswordModal(); });
    }
});

// ... (CÓDIGO OMITIDO) ... 

function updateStatusCard(type, title, message) {
    const icon = document.getElementById('statusIcon');
    const titleEl = document.getElementById('statusTitle');
    const messageEl = document.getElementById('statusMessage');

    icon.className = `status-icon ${type}`;
    titleEl.innerText = title;
    messageEl.innerText = message;

    // Update icon SYMBOL based on type
    if (type === 'success') {
        icon.innerHTML = `<img src="status-on.png" alt="Online" style="width:64px; height:64px; object-fit: contain;">`;
    } else if (type === 'error') {
        icon.innerHTML = `<img src="status-off.png" alt="Offline" style="width:64px; height:64px; object-fit: contain;">`;
    } else {
        icon.innerHTML = `<img src="wait-dark.png" alt="Aguarde" style="width:64px; height:64px; object-fit: contain;">`;
    }
}

// ... (CÓDIGO OMITIDO) ...

async function runFix() {
    // Ação direta sem confirm nativo, feedback via Toasts
    showToast('Iniciando Correção', 'Analisando fila de impressão e status...', 'info');

    const btn = document.getElementById('btnFix');
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined spin">refresh</span> Limpando...`;

    try {
        const res = await fetch('/api/doctor/fix', { method: 'POST' });
        const result = await res.json();
        if (result.ok) {
            showToast('Fila Corrigida', `${result.cleanedCount} tarefas removidas. Impressora reativada!`, 'success');
            lastDiagTime = 0; // força diagnóstico imediato
            update();
        } else {
            showToast('Erro na Correção', result.error, 'error');
        }
    } catch (e) {
        showToast('Erro de Conexão', 'Falha ao comunicar com o agente', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span class="material-symbols-outlined">build_circle</span> Tentar Corrigir Fila`;
    }
}

// ==================================================================================
// FORM HANDLING
// ==================================================================================

function togglePrinterFields(autoRefresh) {
    const type = document.getElementById('printerType').value;
    const net = document.getElementById('networkFields');
    const usb = document.getElementById('usbFields');

    if (type === 'usb') {
        net.style.display = 'none';
        usb.style.display = 'block';
        if (autoRefresh) refreshPrinters();
        document.getElementById('printerIp').removeAttribute('required');
        document.getElementById('printerPort').removeAttribute('required');
        document.getElementById('printerNickname').removeAttribute('required');
        document.getElementById('printerName').setAttribute('required', 'true');
    } else {
        net.style.display = 'block';
        usb.style.display = 'none';
        document.getElementById('printerIp').setAttribute('required', 'true');
        document.getElementById('printerPort').setAttribute('required', 'true');
        document.getElementById('printerName').removeAttribute('required');
    }
}

async function refreshPrinters() {
    const sel = document.getElementById('printerName');
    sel.innerHTML = '<option>Carregando...</option>';
    try {
        const res = await fetch('/api/printers');
        const list = await res.json();
        if (list.length === 0) {
            sel.innerHTML = '<option value="">Nenhuma impressora encontrada</option>';
            showToast('Nenhuma Impressora', 'Não foram encontradas impressoras USB no sistema', 'warning');
        } else {
            sel.innerHTML = list.map(p => `<option value="${p.Name}">${p.Name}</option>`).join('');
            showToast('Impressoras Carregadas', `${list.length} impressora(s) encontrada(s)`, 'success');
        }
    } catch (e) {
        sel.innerHTML = '<option>Erro ao carregar</option>';
        showToast('Erro', 'Falha ao carregar lista de impressoras', 'error');
    }
}

async function loadPrintersAndSelect(currentName) {
    const sel = document.getElementById('printerName');
    try {
        const res = await fetch('/api/printers');
        const list = await res.json();
        if (list.length === 0) {
            sel.innerHTML = '<option value="">Nenhuma impressora encontrada</option>';
        } else {
            sel.innerHTML = list.map(p => `<option value="${p.Name}" ${p.Name === currentName ? 'selected' : ''}>${p.Name}</option>`).join('');
        }
    } catch (e) {
        sel.innerHTML = `<option value="${currentName}" selected>${currentName}</option>`;
    }
}

async function handleConfigSubmit(event) {
    event.preventDefault();

    const formData = new FormData(event.target);
    const data = Object.fromEntries(formData);

    try {
        const response = await fetch('/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(data)
        });

        if (response.ok) {
            showToast('Configuração Salva', 'As configurações foram salvas com sucesso!', 'success');

            // Configurações salvas
            setTimeout(() => update(), 500);
        } else {
            showToast('Erro ao Salvar', 'Não foi possível salvar as configurações', 'error');
        }
    } catch (error) {
        showToast('Erro de Conexão', 'Falha ao comunicar com o servidor', 'error');
    }
}

// ==================================================================================
// STATUS UPDATE
// ==================================================================================

async function update() {
    try {
        const res = await fetch('/api/status');
        if (res.status === 401) {
            window.location.href = '/login.html';
            return;
        }
        const data = await res.json();

        // Sincroniza senha de admin
        if (data.config && data.config.adminPassword) {
            currentAdminPin = data.config.adminPassword;
        }

        // Update connection status
        const badge = document.getElementById('statusBadge');
        const statusText = badge.querySelector('.status-text');

        if (data.status === 'SUBSCRIBED' || data.status === 'ONLINE') {
            badge.className = 'connection-status online';
            statusText.innerText = 'ONLINE';

            // CHECK HARDWARE STATUS (Prioridade sobre conexão Cloud)
            if (data.printerStatus && data.printerStatus.isOnline === false && data.config.printerName) {
                // Agente Online, mas Impressora Offline
                updateStatusCard('error', 'Impressora Offline', data.printerStatus.message || 'Verifique cabos ou energia.');
            } else {
                // Tudo Online
                updateStatusCard('success', 'Online e Pronta', 'Tudo pronto. Impressora conectada e aguardando pedidos.');
            }

        } else if (data.status === 'CONNECTING') {
            badge.className = 'connection-status connecting';
            statusText.innerText = 'CONECTANDO';
            updateStatusCard('warning', 'Conectando...', 'Estabelecendo conexão com o servidor.');
        } else {
            badge.className = 'connection-status offline';
            statusText.innerText = 'OFFLINE';
            updateStatusCard('error', 'Aguardando Conexão', 'Configure o ID da empresa para conectar.');
        }

        // Update stats
        document.getElementById('statUptime').innerText = formatUptime(data.stats.uptime);
        document.getElementById('statSuccess').innerText = data.stats.successJobs;
        document.getElementById('statFail').innerText = data.stats.failedJobs;

        // Update printer info
        updatePrinterInfo(data.config);

        // DETECÇÃO INTELIGENTE DE MUDANÇA DE STATUS (SYNC DOCTOR)
        // Se o último log indica mudança física, força atualização imediata do Doctor
        if (data.logs && data.logs.length > 0) {
            const latestLog = data.logs[data.logs.length - 1];
            // Palavras-chave que indicam mudança de hardware
            const triggers = ['FICOU ONLINE', 'FICOU OFFLINE', 'NOVA IMPRESSORA', 'REMOVIDA', 'CONECTADA', 'DESCONECTADA'];
            const isTrigger = triggers.some(t => latestLog.message.toUpperCase().includes(t));

            if (isTrigger && latestLog.timestamp !== lastTriggerLogTime) {
                lastDiagTime = 0; // Zera o contador para forçar atualização imediata
                lastTriggerLogTime = latestLog.timestamp; // Marca como processado
            }
        }

        // Doctor logic
        checkDoctor(data.config);

        // Config Logic (Populate inputs if not focused)
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
            const cfg = data.config || {};

            // 1. Nome da Empresa
            document.getElementById('restaurantNameText').innerText = data.companyName || 'Desconhecido';

            // 2. Printer Type
            const pType = cfg.printerType || 'network'; // Default to network
            document.getElementById('printerType').value = pType;

            // 3. Parse Identifier (IP / Name) & Nickname
            let pIp = '';
            let pPort = '9100';
            let pName = '';
            let pNick = '';

            if (pType === 'network') {
                if (cfg.printerIdentifier) {
                    if (cfg.printerIdentifier.includes(':')) {
                        const parts = cfg.printerIdentifier.split(':');
                        pIp = parts[0];
                        pPort = parts[1];
                    } else {
                        pIp = cfg.printerIdentifier;
                    }
                }
                pNick = cfg.printerName || ''; // No banco, name guarda o nickname para rede
            } else {
                // USB
                pName = cfg.printerIdentifier || '';
                // Se for USB, 'printerName' no banco é redundante com identifier, mas ok
            }

            document.getElementById('printerIp').value = pIp;
            document.getElementById('printerPort').value = pPort;
            document.getElementById('printerNickname').value = pNick;

            // Toggle logic handles showing/hiding fields
            togglePrinterFields(false);

            // Special case for USB Select population
            if (pType === 'usb' && pName && document.getElementById('printerName').options.length <= 1) {
                loadPrintersAndSelect(pName);
            }
        }

        // Update logs
        updateLogs(data.logs, data.config, data.printerStatus);

    } catch (e) {
        console.error('Erro ao atualizar status:', e);
    }
}

function updateStatusCard(type, title, message) {
    const icon = document.getElementById('statusIcon');
    const titleEl = document.getElementById('statusTitle');
    const messageEl = document.getElementById('statusMessage');

    icon.className = `status-icon ${type}`;
    titleEl.innerText = title;
    messageEl.innerText = message;

    // Update icon SYMBOL based on type
    if (type === 'success') {
        icon.className = 'status-icon success';
        icon.innerHTML = `<span class="material-symbols-outlined" style="font-size: 64px;">check_circle</span>`;
    } else if (type === 'error') {
        icon.className = 'status-icon error';
        icon.innerHTML = `<span class="material-symbols-outlined" style="font-size: 64px;">cancel</span>`;
    } else {
        // Connecting / Warning
        icon.className = 'status-icon warning';
        icon.innerHTML = `<span class="material-symbols-outlined" style="font-size: 64px;">cloud_sync</span>`;
    }
}

function updatePrinterInfo(config) {
    const nameEl = document.getElementById('printerInfoName');
    const statusEl = document.getElementById('printerInfoStatus');

    if (config.printerType === 'network') {
        const nickname = config.printerName || 'Sem apelido'; // 'name' mapped to printerName in State
        let ip = config.printerIdentifier || 'Não configurado';
        let port = '9100';

        if (ip.includes(':')) {
            const parts = ip.split(':');
            ip = parts[0];
            port = parts[1];
        }

        nameEl.innerText = `${nickname} (Rede)`;
        statusEl.innerText = `IP: ${ip} | Porta: ${port}`;
    } else if (config.printerType === 'usb') {
        const printerName = config.printerIdentifier || 'Não configurada';
        nameEl.innerText = printerName;
        statusEl.innerText = 'Conexão: USB/Local';
    } else {
        nameEl.innerText = 'Detectando...';
        statusEl.innerText = 'Aguardando configuração';
    }
}

let lastLogsJson = '';

function updateLogs(logs, config, printerStatus) { // UPDATED SIGNATURE
    const logBox = document.getElementById('logBox');
    const btnResume = document.getElementById('btnResumeScroll');

    if (!logs || logs.length === 0) {
        logBox.innerHTML = '<div class="log-placeholder">Aguardando logs...</div>';
        lastLogsJson = '';
        if (btnResume) btnResume.style.display = 'none';
        return;
    }

    // Força re-render se o status da impressora mudar (para atualizar o Doctor)
    const currentStatusJson = JSON.stringify(printerStatus || {});
    const currentLogsJson = JSON.stringify(logs) + currentStatusJson; // Combine logs + status for cache key

    if (currentLogsJson === lastLogsJson) {
        return;
    }
    lastLogsJson = currentLogsJson;

    // Cria header fixo com configuração da impressora
    let printerConfigHeader = '';
    // ... (Network logic remains same) ...

    if (config.printerType === 'network') {
        const nickname = config.printerName || 'Sem apelido'; // Name from State/DB is nickname
        let displayIp = config.printerIdentifier || 'N/A';
        let displayPort = '9100';

        if (displayIp.includes(':')) {
            const parts = displayIp.split(':');
            displayIp = parts[0];
            displayPort = parts[1];
        }

        printerConfigHeader = `
            <div class="log-config-header">
                <div class="log-config-label">CONFIGURAÇÃO ATUAL</div>
                <div class="log-config-content">
                    <span class="material-symbols-outlined log-config-icon">lan</span>
                    <span class="log-config-text">Impressora de Rede: <strong>${escapeHtml(nickname)}</strong> | IP: ${escapeHtml(displayIp)}:${displayPort}</span>
                </div>
            </div>
        `;
    } else if (config.printerType === 'usb') {
        const pName = config.printerIdentifier || 'Não configurada'; // Identifier stores the Windows Printer Name for USB

        let doctorStatusHtml = '';
        if (printerStatus && config.printerName) {
            const isOnline = printerStatus.isOnline;
            const jobs = printerStatus.pendingJobs || 0;
            const icon = isOnline ? 'check_circle' : 'wifi_off';
            const msg = isOnline ? 'ONLINE' : 'OFFLINE';
            const statusClass = isOnline ? 'doctor-online' : 'doctor-offline';
            const warnIcon = isOnline ? '' : '<span class="material-symbols-outlined" style="font-size:16px">warning</span>';

            doctorStatusHtml = `
                <div id="doctorStatus" class="doctor-status ${statusClass}">
                    <div class="doctor-name">${escapeHtml(pName)}</div>
                    <div class="doctor-queue">Fila: <strong>${jobs}</strong> tarefas pendentes</div>
                    <div class="doctor-status-row">
                        <span class="material-symbols-outlined" style="font-size:18px">${icon}</span> ${msg}
                    </div>
                    ${!isOnline ? `<hr class="doctor-divider">
                    <div class="doctor-warn">${warnIcon} Impressora OFFLINE/PAUSADA!</div>` : ''}
                </div>
            `;
        }

        printerConfigHeader = `
            <div class="log-config-header">
                <div class="log-config-label">CONFIGURAÇÃO ATUAL</div>
                <div class="log-config-content">
                    <span class="material-symbols-outlined log-config-icon">usb</span>
                    <span class="log-config-text">Impressora USB: <strong>${escapeHtml(pName)}</strong></span>
                </div>
                ${doctorStatusHtml}
            </div>
        `;
    }

    const logsHTML = logs.map(l => {
        let color = 'var(--muted-foreground)';
        let icon = 'info'; // Ícone padrão

        // SAFE TIMESTAMP PARSING
        let timeDisplay = '00:00:00';
        try {
            if (l.timestamp) {
                const parts = l.timestamp.includes('T') ? l.timestamp.split('T') : l.timestamp.split(' ');
                if (parts.length > 1) {
                    timeDisplay = parts[1].split('.')[0];
                } else {
                    timeDisplay = l.timestamp; // Fallback
                }
            }
        } catch (e) {
            console.error('Time parse error', e);
        }

        // Limpeza de Emojis e Texto Bruto (Regex Universal de Emojis)
        // Remove faixas principais de emojis e símbolos gráficos
        let cleanMsg = (l.message || '')
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}]/gu, '')
            .trim();

        // MASCARAMENTO DE SEGURANÇA (REDUNDÂNCIA FRONTEND)
        // Mascara URL Supabase
        cleanMsg = cleanMsg.replace(/(https?:\/\/|wss:\/\/)([^.]+)(\.supabase\.co)/g, '$1********$3');

        // Mascara UUIDs (ex: Empresa ID)
        cleanMsg = cleanMsg.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (match) => {
            return `${match.substring(0, 4)}****-****`;
        });

        // Mascara Detalhes também
        let cleanDetails = l.details || '';
        if (cleanDetails) {
            cleanDetails = cleanDetails.replace(/(https?:\/\/|wss:\/\/)([^.]+)(\.supabase\.co)/g, '$1********$3');
            cleanDetails = cleanDetails.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (match) => `${match.substring(0, 4)}****-****`);
        }

        // Lógica de Ícones e Cores (Material Symbols)
        const msgUpper = (l.message || '').toUpperCase();

        if (msgUpper.includes('ERROR') || msgUpper.includes('ERRO') || msgUpper.includes('FALHA') || msgUpper.includes('CRÍTICO')) {
            color = 'var(--log-error)';
            icon = 'error';
        }
        else if (msgUpper.includes('WARN') || msgUpper.includes('ALERTA') || msgUpper.includes('TIMEOUT')) {
            color = 'var(--log-warning)';
            icon = 'warning';
        }
        else if (msgUpper.includes('SUCCESS') || msgUpper.includes('SUCESSO') || msgUpper.includes('ONLINE') || msgUpper.includes('RESTABELECIDA')) {
            color = 'var(--success)';
            icon = 'check_circle';
        }
        else if (msgUpper.includes('POLLING') || msgUpper.includes('MONITOR')) {
            color = 'var(--log-info)';
            icon = 'radar';
        }
        else if (msgUpper.includes('WEBSOCKET') || msgUpper.includes('CONEXÃO')) {
            color = 'var(--log-network)';
            icon = 'settings_ethernet';
        }
        else if (msgUpper.includes('BAIXANDO') || msgUpper.includes('DOWNLOAD')) {
            color = 'var(--log-info)';
            icon = 'download';
        }
        else if (msgUpper.includes('ENVIANDO') || msgUpper.includes('IMPRESSORA')) {
            color = 'var(--log-print)';
            icon = 'print';
        }
        else if (msgUpper.includes('FILA') || msgUpper.includes('JOB')) {
            color = 'var(--log-queue)';
            icon = 'list_alt';
        }
        else if (msgUpper.includes('SALVO') || msgUpper.includes('CONFIG') || msgUpper.includes('ALTERADA') || msgUpper.includes('MUDANÇA')) {
            color = 'var(--log-config)';
            icon = 'edit_note';
        }
        else if (msgUpper.includes('DETECTADO') || msgUpper.includes('INICIADO')) {
            icon = 'search';
        }
        else if (msgUpper.includes('WORKER') || msgUpper.includes('SUPERVISOR')) {
            icon = 'dns';
        }

        return `<div class="log-line" style="display: flex; align-items: flex-start; gap: 10px; padding: 4px 0;">
            <span class="log-time" style="min-width: 65px; font-family: monospace; opacity: 0.6; font-size: 0.85em; margin-top: 2px;">${timeDisplay}</span>
            <span class="material-symbols-outlined" style="font-size: 16px; color: ${color}; opacity: 1; margin-top: 2px;">${icon}</span>
            <span style="color: ${color}; flex: 1; word-break: break-all;">${escapeHtml(cleanMsg)} <span style="opacity:0.7; font-size:0.9em;">${escapeHtml(cleanDetails)}</span></span>
        </div>`;
    }).join('');

    const previousScrollTop = logBox.scrollTop; // Salva posição atual
    logBox.innerHTML = printerConfigHeader + '<div class="log-content">' + logsHTML + '</div>';

    // Auto scroll INTELIGENTE com pequeno delay para garantir renderização
    setTimeout(() => {
        if (isLogAutoScroll) {
            logBox.scrollTop = logBox.scrollHeight;
            if (btnResume) btnResume.style.display = 'none';
        } else {
            // Se usuário subiu a barra, mantém onde ele estava
            logBox.scrollTop = previousScrollTop;
            if (btnResume) btnResume.style.display = 'flex';
        }
    }, 50);
}

function resumeScroll() {
    isLogAutoScroll = true;
    const logBox = document.getElementById('logBox');
    const btnResume = document.getElementById('btnResumeScroll');

    if (logBox) {
        logBox.scrollTop = logBox.scrollHeight;
    }
    if (btnResume) {
        btnResume.style.display = 'none';
    }
}

// ==================================================================================
// PRINTER DOCTOR
// ==================================================================================

// ==================================================================================
// PRINTER DOCTOR
// ==================================================================================

async function checkDoctor(config) {
    const now = Date.now();
    if (config.printerType !== 'usb' || !config.printerName) {
        const el = document.getElementById('doctorSection');
        if (el) el.style.display = 'none';
        return;
    }

    const el = document.getElementById('doctorSection');
    if (el) el.style.display = 'block';

    // Atualiza diagnóstico a cada 10 segundos
    if (now - lastDiagTime < 10000) return;
    lastDiagTime = now;

    try {
        const res = await fetch('/api/doctor/diagnose');
        const result = await res.json();
        const box = document.getElementById('doctorStatus');

        if (result.ok) {
            const d = result.data;

            // Verifica se está offline: Status === "Offline" OU WorkOffline === true
            const isOffline = (d.Status && d.Status.toString().toLowerCase().includes('offline')) || d.WorkOffline === true;

            let html = '<div style="margin-bottom:6px"><strong>' + escapeHtml(d.Name) + '</strong></div>';
            html += '<div style="font-size:0.9em; margin-bottom:4px">Fila: <strong>' + d.JobCount + '</strong> tarefas pendentes</div>';

            // Status Line — usa check_circle (online) ou cancel (offline) padronizado.
            // Antes usava wifi/wifi_off, mas a fonte material-symbols às vezes
            // demorava a carregar e o navegador caía no emoji fallback do sistema
            // (📶 que renderiza vermelho em algumas configurações do Windows).
            if (isOffline) {
                html += '<div style="display:flex; align-items:center; gap:6px; margin-top:4px; color:var(--error)"><span class="material-symbols-outlined" style="font-size:18px; color: var(--error);">cancel</span> OFFLINE</div>';
            } else {
                html += '<div style="display:flex; align-items:center; gap:6px; margin-top:4px; color:var(--success)"><span class="material-symbols-outlined" style="font-size:18px; color: var(--success);">check_circle</span> ONLINE</div>';
            }

            if (d.JobCount > 0 || isOffline) {
                html += '<hr style="margin:8px 0; border:0; border-top:1px solid rgba(255,255,255,0.1);">';
                if (isOffline) {
                    html += '<div style="display:flex; align-items:center; gap:6px; color:var(--error); font-size:12px; margin-top:2px"><span class="material-symbols-outlined" style="font-size:16px">warning</span> Impressora OFFLINE/PAUSADA!</div>';
                }
                if (d.JobCount > 0) {
                    html += '<div style="display:flex; align-items:center; gap:6px; color:var(--warning); font-size:12px; margin-top:4px"><span class="material-symbols-outlined" style="font-size:16px">layers_clear</span> Fila obstruída. Sugerimos "Corrigir".</div>';
                }
            }

            box.innerHTML = html;
            box.style.background = (d.JobCount > 0 || isOffline) ? 'var(--error-bg)' : 'var(--success-bg)';
            box.style.borderColor = (d.JobCount > 0 || isOffline)
                ? 'color-mix(in hsl, var(--error) 40%, transparent)'
                : 'color-mix(in hsl, var(--success) 40%, transparent)';
        } else {
            box.innerHTML = '<div style="display:flex; align-items:center; gap:6px; color:var(--error)"><span class="material-symbols-outlined">error</span> ' + escapeHtml(result.error) + '</div>';
            box.style.background = 'var(--error-bg)';
        }
    } catch (e) {
        console.error("Erro no diagnóstico", e);
    }
}

// ==================================================================================
// PRINTER DOCTOR: RUN FIX (MATERIAL SYMBOLS UPDATE)
// ==================================================================================

async function runFix() {
    // Ação direta sem confirm nativo, feedback via Toasts
    showToast('Iniciando Correção', 'Analisando fila de impressão e status...', 'info');

    const btn = document.getElementById('btnFix');
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined spin">refresh</span> Limpando...`;

    try {
        const res = await fetch('/api/doctor/fix', { method: 'POST' });
        const result = await res.json();
        if (result.ok) {
            showToast('Fila Corrigida', `${result.cleanedCount} tarefas removidas. Impressora reativada!`, 'success');
            lastDiagTime = 0; // força diagnóstico imediato
            update();
        } else {
            showToast('Erro na Correção', result.error, 'error');
        }
    } catch (e) {
        showToast('Erro de Conexão', 'Falha ao comunicar com o agente', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span class="material-symbols-outlined">build_circle</span> Tentar Corrigir Fila`;
    }
}

// ==================================================================================
// ADDITIONAL FUNCTIONS
// ==================================================================================



async function printTestPage() {
    showToast('Página de Teste', 'Enviando página de teste para impressão...', 'info');
    try {
        const res = await fetch('/api/test-print', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            showToast('Sucesso', 'Página de teste enviada!', 'success');
        } else {
            showToast('Erro', data.error || 'Falha ao imprimir teste', 'error');
        }
    } catch (e) {
        showToast('Erro', 'Falha na comunicação com o agente', 'error');
    }
}

// ==================================================================================
// INITIALIZATION
// ==================================================================================

setInterval(update, 1000);
update();

// Inicialização Unificada
document.addEventListener('DOMContentLoaded', () => {
    // 1. Inicializa o estado do lock e input de senha
    const input = document.getElementById('restaurantId');
    if (input) {
        input.setAttribute('readonly', 'true');
        input.setAttribute('type', 'password'); // Garante estado inicial seguro
        updateVisibilityIcon(false);
    }

    const lockBtn = document.getElementById('lockBtn');
    if (lockBtn) {
        lockBtn.classList.remove('unlocked');
        lockBtn.innerHTML = '<span class="material-symbols-outlined">lock</span>';
    }

    // 2. Event Listeners do Modal
    const pwdInput = document.getElementById('modalPasswordInput');
    if (pwdInput) {
        pwdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmPasswordModal();
            if (e.key === 'Escape') closePasswordModal();
        });
    }

    const modalOverlay = document.getElementById('passwordModal');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closePasswordModal();
        });
    }

    // 3. Smart Scroll Logic para Logs
    const logBox = document.getElementById('logBox');
    const btnResume = document.getElementById('btnResumeScroll');
    if (logBox) {
        logBox.addEventListener('scroll', () => {
            const { scrollTop, scrollHeight, clientHeight } = logBox;
            isLogAutoScroll = (scrollHeight - scrollTop - clientHeight) < 50;

            if (btnResume) {
                btnResume.style.display = isLogAutoScroll ? 'none' : 'flex';
            }
        });
    }
});

// ==================================================================================
// LOGOUT
// ==================================================================================

async function handleLogout() {
    const confirmed = await showConfirmModal(
        'Você precisará fazer login novamente na próxima vez que abrir o agente.',
        'Tem certeza que deseja sair?',
        'logout'
    );

    if (!confirmed) {
        return;
    }

    try {
        const res = await fetch('/api/logout', { method: 'POST' });
        const data = await res.json();

        if (data.ok) {
            showToast('Logout', 'Sessão encerrada com sucesso. Recarregando...', 'success');
            setTimeout(() => {
                window.location.href = '/login.html?logout=1';
            }, 1000);
        } else {
            showToast('Erro', data.error || 'Falha ao fazer logout', 'error');
        }
    } catch (e) {
        showToast('Erro', 'Falha na comunicação com o servidor', 'error');
    }
}

// ==================================================================================
// AUTO-UPDATE — MODAL
// Mostra modal apenas quando há ação a tomar (available / ready / error).
// "Verificar atualizações" é exclusivo do tray. UI principal fica limpa.
// Modal pode ser fechado e tem "Não exibir mais este aviso" (pula versão).
// ==================================================================================

const DISMISSED_KEY = 'labelchef-agent-update-dismissed';
const DISMISS_TTL_MS = 60 * 60 * 1000; // "Lembrar depois" = silencia por 1h

// Formato em storage: { [version]: dismissedAt(ms) }
// TTL de 1h evita que um clique acidental em "Lembrar depois" deixe o modal
// permanentemente escondido (badge no header mantém visibilidade contínua).
function getDismissedMap() {
    try {
        const raw = sessionStorage.getItem(DISMISSED_KEY) || '{}';
        const obj = JSON.parse(raw);
        // Compatibilidade: formato antigo (array de versões) — limpa e adota o novo
        if (Array.isArray(obj)) {
            sessionStorage.removeItem(DISMISSED_KEY);
            return {};
        }
        return (obj && typeof obj === 'object') ? obj : {};
    } catch { return {}; }
}
function isDismissed(version) {
    const map = getDismissedMap();
    const at = map[version];
    if (!at) return false;
    if (Date.now() - at > DISMISS_TTL_MS) {
        // Expirou — limpa do storage e libera modal de novo
        delete map[version];
        try { sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(map)); } catch {}
        return false;
    }
    return true;
}
function setDismissedSession(version) {
    const map = getDismissedMap();
    map[version] = Date.now();
    try { sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(map)); } catch {}
}

async function pollUpdateStatus() {
    try {
        const res = await fetch('/api/update');
        if (!res.ok) return;
        const data = await res.json();
        lastUpdateState = data;
        renderUpdateBadge(data);
        maybeShowUpdateModal(data);
    } catch (e) {
        // silencioso — agent pode estar reiniciando
    }
}

// Badge persistente no header — reflete o estado do auto-updater 100% do tempo.
// Texto SEMPRE curto pra não quebrar baseline do h1. Detalhes vão no title (tooltip).
function renderUpdateBadge(state) {
    const badge = document.getElementById('updateBadge');
    const label = document.getElementById('updateBadgeLabel');
    if (!badge || !label) return;

    const status = (state && state.status) || 'idle';
    const v = state && state.version;
    const cur = (state && state.currentVersion) || '—';
    const hasNew = v && cur && v !== cur;
    const lastChecked = state && state.lastCheckedAt;

    badge.classList.remove(
        'state-idle', 'state-checking', 'state-available',
        'state-downloading', 'state-ready', 'state-error', 'state-skipped'
    );

    let cls = 'state-idle';
    let text = `v${cur}`;
    let title = `Você está usando a versão ${cur}. Clique para verificar atualizações.`;

    if (status === 'checking') {
        cls = 'state-checking';
        text = `v${cur}`;
        title = 'Verificando atualizações…';
    } else if (status === 'available' && hasNew) {
        cls = 'state-available';
        text = `v${v} disponível`;
        title = `Nova versão ${v} disponível (atual: ${cur}). Clique para abrir o aviso de atualização.`;
    } else if (status === 'downloading' && v) {
        cls = 'state-downloading';
        const pct = Math.max(0, Math.min(100, state.progress || 0));
        text = `Baixando ${pct}%`;
        title = `Baixando ${v} (${pct}%). Clique para acompanhar o progresso.`;
    } else if (status === 'ready' && v) {
        cls = 'state-ready';
        text = `v${v} pronta`;
        title = `Versão ${v} baixada. Clique para reiniciar e instalar agora.`;
    } else if (status === 'error') {
        cls = 'state-error';
        text = `v${cur}`;
        title = (state && state.error)
            ? `Falha ao verificar atualizações: ${state.error}. Clique para tentar de novo.`
            : 'Falha ao verificar atualizações. Clique para tentar de novo.';
    } else if (status === 'skipped' && v) {
        cls = 'state-skipped';
        text = `v${cur}`;
        title = `Você optou por não ser avisado da versão ${v}. Clique para verificar atualizações.`;
    } else {
        cls = 'state-idle';
        text = `v${cur}`;
        const when = lastChecked ? formatRelativeTime(lastChecked) : 'ainda nesta sessão';
        title = `Versão ${cur} — última verificação ${when}. Clique para checar agora.`;
    }

    badge.classList.add(cls);
    label.textContent = text;
    badge.setAttribute('title', title);
}

// Click no badge — comportamento depende do estado atual.
// Shift+Click em qualquer estado = modo teste: abre o modal com dados
// fictícios pra você ver o fluxo sem precisar de um release real novo.
async function onUpdateBadgeClick(event) {
    // ─── Modo teste: shift+click ───
    if (event && event.shiftKey) {
        const cur = (lastUpdateState && lastUpdateState.currentVersion) || '—';
        const fake = {
            status: 'available',
            version: cur === '—' ? '9.9.9' : `${cur}-teste`,
            currentVersion: cur,
            releaseNotes: 'ESTE É UM TESTE — nenhum download real será iniciado.\n\nEsse modal está sendo exibido para você verificar visualmente que o aviso de atualização aparece dentro do dashboard quando há uma nova versão. Em produção, o conteúdo mostra as notas reais da release.',
            releaseName: 'Release de teste',
        };
        // Liga o modo teste ANTES de abrir — sem isso, o polling de 5s fecharia o modal
        // ao ver que o estado real é idle (e a flag impede maybeShowUpdateModal de fechar).
        testModeActive = true;
        renderUpdateModal(fake);
        openUpdateModal();
        showToast('Modo teste', 'Modal exibido em modo de teste. Os botões NÃO disparam download real (a versão é fictícia).', 'info');
        return;
    }

    const state = lastUpdateState || {};
    const status = state.status;

    // Estados com ação pendente: abre o modal direto
    if (status === 'available' || status === 'downloading' || status === 'ready') {
        renderUpdateModal(state);
        openUpdateModal();
        return;
    }

    // Demais estados (idle/error/skipped): checagem manual
    // Toast IMEDIATO pra confirmar que o click foi registrado (antes do await).
    showToast('Verificando atualizações', 'Consultando Releases…', 'info');
    renderUpdateBadge({ ...state, status: 'checking' });

    try {
        const res = await fetch('/api/update/check', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
            showToast('Verificação falhou', data.error || 'Não foi possível consultar atualizações.', 'error');
        } else if (data.hasUpdate) {
            // Há update novo — polling em 400ms vai trazer status=available e abrir o modal
            showToast('Atualização encontrada', `Nova versão ${data.latest || ''} disponível. Abrindo aviso…`, 'success');
        } else {
            // CONFIRMAÇÃO de "tudo certo" — fallback crítico, sem isso o usuário não sabe se algo aconteceu
            showToast('Tudo certo', `Você já está na versão mais recente (${data.current || data.latest || ''}).`, 'success');
        }
        setTimeout(pollUpdateStatus, 400);
    } catch (e) {
        showToast('Erro', 'Falha na comunicação com o agent.', 'error');
        pollUpdateStatus();
    }
}

// Helpers para abrir/fechar o update modal — replicam o padrão dos OUTROS
// modais do dashboard. CRÍTICO: a .modal-overlay vem com `opacity: 0;
// visibility: hidden` por padrão; só fica visível com a classe `.active`.
// Por isso `display=flex` SOZINHO não mostra o modal — bug que explicava
// porque o usuário só via o toast e nunca o modal.
function openUpdateModal() {
    const modal = document.getElementById('updateModal');
    if (!modal) return;
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
}
function closeUpdateModal() {
    const modal = document.getElementById('updateModal');
    if (!modal) return;
    modal.classList.remove('active');
    // Aguarda a transição (0.2s) terminar antes de remover display
    setTimeout(() => { modal.style.display = 'none'; }, 200);
}
function isUpdateModalOpen() {
    const modal = document.getElementById('updateModal');
    return !!(modal && modal.classList.contains('active'));
}

// Modo teste (shift+click) — impede que o polling automático feche o modal
// porque o estado real é idle. Usuário fecha manualmente via botões/X.
let testModeActive = false;

function maybeShowUpdateModal(state) {
    const modal = document.getElementById('updateModal');
    if (!modal) return;

    // Em modo teste, NÃO mexer no modal — usuário pediu pra ver, fica até ele fechar.
    if (testModeActive) return;

    const status = state && state.status;
    const v = state && state.version;
    const cur = state && state.currentVersion;
    const hasNew = v && cur && v !== cur;

    // Estados que NÃO devem mostrar modal:
    if (!status || status === 'idle' || status === 'checking' || status === 'skipped' || status === 'error' || !hasNew) {
        if (isUpdateModalOpen() && status !== 'downloading' && status !== 'ready') {
            closeUpdateModal();
        }
        return;
    }

    // Modal já aberto e estamos em downloading/ready: atualiza progresso sem reabrir
    if (isUpdateModalOpen()) {
        renderUpdateModal(state);
        return;
    }

    // Available: só mostra se NÃO foi dispensado recentemente (TTL 1h)
    if (status === 'available' && isDismissed(v)) return;

    renderUpdateModal(state);
    openUpdateModal();
}

function renderUpdateModal(state) {
    const modal = document.getElementById('updateModal');
    if (!modal) return;

    const status = state && state.status;
    const titleEl = document.getElementById('updateModalTitle');
    const subtitleEl = document.getElementById('updateModalSubtitle');
    const iconEl = document.getElementById('updateModalIcon');
    const changelogEl = document.getElementById('updateModalChangelog');
    const notesEl = document.getElementById('updateModalNotes');
    const progressEl = document.getElementById('updateModalProgress');
    const progressFillEl = document.getElementById('updateModalProgressFill');
    const progressLabelEl = document.getElementById('updateModalProgressLabel');
    const actionsEl = document.getElementById('updateModalActions');

    const v = state && state.version;
    const cur = (state && state.currentVersion) || '—';

    // Changelog (release notes)
    if (state && state.releaseNotes && String(state.releaseNotes).trim()) {
        changelogEl.style.display = '';
        notesEl.textContent = stripHtml(String(state.releaseNotes));
    } else {
        changelogEl.style.display = 'none';
    }

    progressEl.style.display = 'none';

    if (status === 'available' && v) {
        iconEl.textContent = 'system_update';
        titleEl.textContent = `Nova versão ${v} disponível`;
        subtitleEl.textContent = `Você está usando ${cur}. Ao confirmar, o agent baixa em background e reinicia automaticamente para aplicar. Impressões pendentes na fila são preservadas.`;
        // Hierarquia: link sutil (ignorar) à esquerda, ghost (adiar), CTA (instalar) à direita
        actionsEl.innerHTML = `
            <button type="button" class="btn-link" onclick="skipUpdateVersion('${escapeAttr(v)}')" title="Não exibir mais o aviso para esta versão">Pular esta versão</button>
            <button type="button" class="btn-cancel" onclick="dismissUpdateModal()">Lembrar depois</button>
            <button type="button" class="btn-confirm" onclick="updateAction('download', { autoInstall: true })">Baixar e instalar</button>`;
    } else if (status === 'downloading' && v) {
        iconEl.textContent = 'downloading';
        titleEl.textContent = `Baixando ${v}...`;
        subtitleEl.textContent = `Quando o download terminar, o agent será reiniciado automaticamente para aplicar a atualização. Você pode minimizar este modal — o processo continua em background.`;
        progressEl.style.display = '';
        const pct = state.progress || 0;
        progressFillEl.style.width = pct + '%';
        progressLabelEl.textContent = pct + '%';
        actionsEl.innerHTML = `<button type="button" class="btn-cancel" onclick="dismissUpdateModal()">Minimizar</button>`;
    } else if (status === 'ready' && v) {
        iconEl.textContent = 'task_alt';
        titleEl.textContent = `Versão ${v} pronta para instalar`;
        subtitleEl.textContent = `Reiniciando o agent para aplicar a atualização...`;
        actionsEl.innerHTML = `
            <button type="button" class="btn-cancel" onclick="dismissUpdateModal()">Mais tarde</button>
            <button type="button" class="btn-confirm" onclick="updateAction('install')">Instalar e reiniciar agora</button>`;
    }
}

function dismissUpdateModal() {
    closeUpdateModal();
    // Sair do modo teste se estava aberto via shift+click
    testModeActive = false;
    // Marca como dispensado na sessão atual — TTL de 1h evita travar para sempre
    if (lastUpdateState && lastUpdateState.version && lastUpdateState.status === 'available') {
        setDismissedSession(lastUpdateState.version);
    }
}

async function skipUpdateVersion(version) {
    // Em modo teste, NÃO persistir a versão fictícia no update-prefs.json
    if (testModeActive) {
        showToast('Modo teste', 'Em produção esta versão seria silenciada permanentemente.', 'info');
        testModeActive = false;
        closeUpdateModal();
        return;
    }
    try {
        await fetch('/api/update/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version }),
        });
        showToast('Versão pulada', 'Você não será notificado sobre a versão ' + version + ' novamente.', 'info');
        closeUpdateModal();
        setTimeout(pollUpdateStatus, 400);
    } catch (e) {
        showToast('Erro', 'Falha ao registrar opção.', 'error');
    }
}

function formatRelativeTime(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '—';
    const diff = Math.max(0, Date.now() - t);
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `agora`;
    const min = Math.round(sec / 60);
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `há ${h}h`;
    return new Date(iso).toLocaleString('pt-BR');
}

async function updateAction(action, body) {
    // Em modo teste, todos os botões viram informativos — sem chamar backend
    if (testModeActive) {
        const msg = action === 'download'
            ? 'Em produção, o agent baixaria a versão e reiniciaria automaticamente.'
            : action === 'install'
                ? 'Em produção, o agent fecharia e reabriria já atualizado.'
                : 'Modo teste: nenhuma ação real disparada.';
        showToast('Modo teste', msg, 'info');
        testModeActive = false;
        closeUpdateModal();
        return;
    }
    const endpoint = '/api/update/' + action;
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json();
        if (data.ok) {
            if (action === 'download') {
                const autoInstall = body && body.autoInstall;
                showToast(
                    'Download iniciado',
                    autoInstall ? 'Instalação acontecerá automaticamente ao terminar.' : 'Acompanhe o progresso no modal.',
                    'info'
                );
            }
            if (action === 'install') showToast('Reiniciando', 'O agent será atualizado agora...', 'success');
            setTimeout(pollUpdateStatus, 400);
        } else {
            showToast('Erro', data.error || `Falha na ação: ${action}`, 'error');
        }
    } catch (e) {
        showToast('Erro', 'Falha na comunicação com o agent.', 'error');
    }
}

function stripHtml(s) {
    const tmp = document.createElement('div');
    tmp.innerHTML = s;
    return tmp.textContent || tmp.innerText || '';
}
function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Polling adaptativo: 5s em estado calmo, 1s durante download (progresso vivo).
let updatePollIntervalMs = 5000;
let updatePollTimer = null;

function schedulePolling() {
    if (updatePollTimer) clearTimeout(updatePollTimer);
    updatePollTimer = setTimeout(async () => {
        await pollUpdateStatus();
        const status = lastUpdateState && lastUpdateState.status;
        // Acelera enquanto baixa para a barra de progresso parecer fluida
        const next = (status === 'downloading') ? 1000 : 5000;
        if (next !== updatePollIntervalMs) updatePollIntervalMs = next;
        schedulePolling();
    }, updatePollIntervalMs);
}

document.addEventListener('DOMContentLoaded', () => {
    pollUpdateStatus().then(schedulePolling);
});
