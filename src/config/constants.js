const CONSTANTS = {
    SUPABASE_URL: "https://bzwpyewettlykgydmhyj.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6d3B5ZXdldHRseWtneWRtaHlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1NjAxMzYsImV4cCI6MjA4MzEzNjEzNn0.auXkhFtQUjHgTZ5k_g41JxVRR4X1-haktqEG4UzEi1Q",

    // Configurações Padrão
    /** Porta dedicada ao LabelChef Agent (evita conflito com outros agentes locais na 9876) */
    HTTP_PORT: 19876,
    RECONNECT_INTERVAL: 15000,
    MAX_RETRIES: 5
};

module.exports = CONSTANTS;
