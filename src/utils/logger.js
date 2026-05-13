const fs = require('fs');
const path = require('path');
const os = require('os');

// Determina o diretório de dados correto (Compatível com PKG e Dev)
const PROGRAM_DATA = process.env.ProgramData || 'C:\\ProgramData';
const APP_DATA_DIR = process.env.USER_DATA_PATH
    ? path.join(process.env.USER_DATA_PATH, 'data')
    : (typeof process.pkg !== 'undefined'
        ? path.join(PROGRAM_DATA, 'LabelChefAgent')
        : path.join(__dirname, '..', '..', 'data'));

// Garante que o diretório existe
if (!fs.existsSync(APP_DATA_DIR)) {
    try {
        fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    } catch (e) {
        console.error('CRITICAL: Falha ao criar diretório de logs:', e.message);
    }
}

const LOG_FILE = path.join(APP_DATA_DIR, 'agent.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// Buffer em memória para API de Status
const logBuffer = [];
const MAX_BUFFER_SIZE = 100;

function maskSensitiveData(text) {
    if (typeof text !== 'string') return text;

    // 1. Mascara URLs do Supabase (HTTPS e WSS)
    text = text.replace(/(https?:\/\/|wss:\/\/)([^.]+)(\.supabase\.co)/g, '$1********$3');

    // 2. Mascara Tokens JWT e Chaves Genéricas
    text = text.replace(/eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g, '[JWT-REDACTED]');
    text = text.replace(/sk-[a-zA-Z0-9]{20,}/g, '[KEY-REDACTED]');

    // 3. Mascara Query Params Sensíveis
    text = text.replace(/([?&](apikey|token|key|authorization|password)=)([^&\s]+)/gi, '$1[REDACTED]');

    // 4. Mascara UUIDs (parcialmente) para privacidade
    text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (match) => {
        return `${match.substring(0, 4)}****-****`;
    });

    return text;
}

function log(type, message, details = '') {
    const now = new Date();
    // Ajuste de fuso manual para garantir log no horário local do usuário
    const offset = now.getTimezoneOffset() * 60000;
    const localTime = new Date(now.getTime() - offset).toISOString().replace('T', ' ').replace('Z', '');

    const cleanDetails = details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : '';

    const safeMessage = maskSensitiveData(message);
    const safeDetails = maskSensitiveData(cleanDetails);

    const logLine = `[${localTime}] [${type}] ${safeMessage} ${safeDetails}\n`;

    // Console Output (std)
    console.log(logLine.trim());

    // Memory Buffer
    logBuffer.push({
        timestamp: localTime,
        type,
        message: safeMessage,
        details: safeDetails
    });

    if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer.shift();
    }

    // Disk Write
    logStream.write(logLine, (err) => {
        if (err) console.error('Erro de escrita no log:', err.message);
    });
}

module.exports = {
    init: () => { }, // Silencioso - não loga mais a inicialização
    info: (msg, det) => log('INFO', msg, det),
    warn: (msg, det) => log('WARN', msg, det),
    error: (msg, det) => log('ERROR', msg, det),
    debug: (msg, det) => log('DEBUG', msg, det),
    getBuffer: () => logBuffer,
    getLogPath: () => LOG_FILE
};
