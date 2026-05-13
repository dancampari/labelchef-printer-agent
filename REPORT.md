# LabelChef Printer Agent — Relatório Técnico Completo

> **Versão coberta:** v3.2.0 (gerado 2026-05-13)
> **Propósito:** documento de referência. Espelho técnico do agent OnTrack v3.9.6, adaptado para o domínio LabelChef.

## 0. Diferenças propositais vs. OnTrack (preserva ZPL / Genéricas)

O agent LabelChef foi portado a partir do OnTrack v3.9.6 com **uma restrição crítica**: as funcionalidades de impressão **não foram modificadas**. Tudo o mais (UI shadcn light/dark, auto-update, WS push, PSHost, WM_DEVICECHANGE, tests, release pipeline) foi adotado.

| Aspecto | OnTrack v3.9.6 | LabelChef v3.2.0 | Por que diferente |
|---|---|---|---|
| Domínio de impressão | Recibos térmicos HTML (Epson i9, MP-4200) | **Etiquetas ZPL Zebra + Genéricas (PDF via SumatraPDF)** | Mercado diferente — restaurantes/cozinhas com Zebra para etiquetas de alimento ANVISA |
| `printerUSB.js` | Refatorado para usar `pshost` + exporta `PREAMBLE` | **Mantido inline**: script PowerShell + `Add-Type RawPrinterHelper` por job + CP850 | Preservar comportamento Win32 RAW testado em produção |
| `printerNetwork.js` | TCP 9100 puro | **Mantido**: TCP 9100 puro | Sem mudança |
| `printerPDF.js` | SumatraPDF para PDFs | **Mantido**: SumatraPDF para Genéricas | Fluxo PDF intacto |
| `processJob` branch `else` | Routea HTML/HTML → spooler | **Routea ZPL** → `printerUSB.print` ou `printerNetwork.print` (Win32 RAW ou TCP) | Pipeline ZPL preservado |
| Teste de impressão | HTML recibo → SumatraPDF | **ZPL fictício → Labelary → PDF → SumatraPDF** | Mesmo pipeline ZPL→PDF que o app usa em prod |
| Porta HTTP | 9876 | **19876** | Evita colisão com agent OnTrack na mesma máquina (caso usuário tenha ambos) |
| `state.stats` em printers | Centralizado em processJob (refatorado) | Tanto processJob **quanto** services incrementam (over-counting tolerável) | Não mexer nos services preservados |
| Spooler persistente HTML | Caminho principal (recibos) | **Presente mas opcional** — fluxo principal não passa por aqui | Compatibilidade futura |

Todo o resto (UI shadcn, auto-update, WebSocket, tray nativo, IPC, validator, pshost para monitor) é **idêntico ao OnTrack**.

---

## 1. Sumário Executivo

O **LabelChef Printer Agent** é uma aplicação desktop Electron que roda em máquinas Windows com impressoras térmicas Zebra (ZPL) ou genéricas (PDF) e oferece:

1. **Impressão direta local** via `http://127.0.0.1:19876/api/local-print` — qualquer dispositivo na mesma máquina (PWA, mobile na mesma WiFi via tunnel, navegador desktop) consegue imprimir sem passar pela cloud.
2. **Impressão remota via fila** — clientes mobile/web em outras máquinas enfileiram jobs em `print_queue` (Supabase) e o agent local consome via Realtime + safety-net polling.
3. **Auto-update transparente** via GitHub Releases + electron-updater — usuário aprova um clique e o agent baixa+reinicia sozinho.
4. **UI local própria** em `http://127.0.0.1:19876` — login, configuração de impressora, logs, teste de impressão, badge de status.
5. **Tray nativo do Windows** (padrão Docker Desktop) com status em tempo real, atalhos para abrir painel, corrigir fila, testar impressão.
6. **WebSocket bidirecional** entre agent e frontend (web/PWA) para push de mudanças de estado da impressora e progresso de jobs em batch.

**Sistema externo que consome o agent:** LabelChef web app (Next.js + Supabase). Sidebar do dashboard mostra badge de status do agent, oferece download quando ausente e detecta versões legadas pedindo atualização manual.

---

## 2. Stack Tecnológico

### 2.1 Agent (Desktop)

| Camada | Tecnologia | Versão | Motivo |
|---|---|---|---|
| Runtime | Electron | ^34.5.8 | UI HTML + Node.js + acesso nativo Windows (Tray, Notification, printers) |
| Node bundled | Node.js | 20+ (via Electron 34) | engines.node>=20 no package.json |
| Auto-update | electron-updater | ^6.3.9 | Delta updates via blockmap + assinatura por hash |
| HTTP server local | express | ^4.21.2 | API REST em 127.0.0.1:19876 |
| WebSocket | ws | ^8.18.0 | Push de status pro frontend (ws://127.0.0.1:19876/ws) |
| Body parsing | body-parser | ^1.20.3 | JSON + urlencoded (limit 2MB) |
| CORS | cors | ^2.8.6 | Liberação para `localhost:3000`, `labelchef-sable.vercel.app`, `sys-labelchef.com` |
| Supabase client | @supabase/supabase-js | ^2.47.10 | Auth + Realtime (print_queue inserts) + Storage (PDF jobs) |
| Encoding | iconv-lite | ^0.6.3 | Conversão UTF-8 ↔ CP850/CP1252 para ESC-POS |
| Bundler | electron-builder | ^25.1.8 | NSIS installer + auto-publish GitHub Releases |
| PDF viewer | SumatraPDF (binário) | embedded em `assets/bin/` | Imprime PDFs com `-silent -print-to "<printer>"` |

### 2.2 Frontend LabelChef (Next.js)

- **Next.js** 15.x (App Router) — `my-app/`
- **Tailwind + shadcn/ui** — design system
- **Supabase SSR** — auth via cookies (`@supabase/ssr`)
- **react-hot-toast** — notificações no sidebar
- **Vitest** — 58 testes no módulo `src/lib/print/*`
- **TanStack Query** — caching de heartbeat / status (não obrigatório para o agent, mas usado em outras partes)

### 2.3 Banco de Dados (Supabase / PostgreSQL)

Tabelas que o agent usa:

| Tabela | Uso |
|---|---|
| `users` | Identidade do usuário logado (tenant_id) |
| `printer_settings` | Configuração por empresa: `printer_type`, `printer_identifier`, `name`, `last_seen` (heartbeat) |
| `print_queue` | Fila de jobs: `id`, `company_id`, `job_type` ('html'\|'pdf'\|'zpl'), `zpl_content`, `file_path`, `printer_name`, `status` ('pending'\|'processing'\|'printed'\|'error') |

**Storage bucket:** `print_jobs/` para PDFs (jobs `job_type='pdf'` referenciam por `file_path`).

**Realtime:** o agent assina `postgres_changes` em `print_queue` com filtro `company_id=eq.<id>` — recebe INSERTs em tempo real.

---

## 3. Topologia de Processos

```
┌─────────────────────────────────────────────────────────┐
│                      ELECTRON                            │
│                                                          │
│  ┌─────────────────────┐    fork()    ┌──────────────┐  │
│  │   main.js (Main)    │─────────────▶│  agent.js    │  │
│  │                     │   IPC bridge │  (Forked)    │  │
│  │  • Tray (Windows)   │◀─────────────│              │  │
│  │  • BrowserWindow    │              │ • Express    │  │
│  │  • autoUpdater      │              │ • WS server  │  │
│  │  • Spooler invisível│              │ • Supabase   │  │
│  │  • Notifications    │              │ • Print jobs │  │
│  │  • safeStorage      │              │ • PSHost     │  │
│  │  • WM_DEVICECHANGE  │              │ • Monitor    │  │
│  └─────────────────────┘              └──────────────┘  │
│           │                                  │           │
│           │                                  │           │
└───────────┼──────────────────────────────────┼───────────┘
            │                                  │
            ▼                                  ▼
       ╔════════╗                       ╔═════════════╗
       ║  TRAY  ║                       ║ HTTP+WS API ║
       ║ NATIVO ║                       ║ 127.0.0.1:  ║
       ╚════════╝                       ║    19876     ║
                                        ╚═════════════╝
```

### 3.1 Por que dois processos?

- **main.js (Electron Main Process)**: detém o autoUpdater, Tray, safeStorage, criação de BrowserWindows e o "spooler persistente" (BrowserWindow oculta que renderiza HTML pra impressão térmica via `webContents.print()`).
- **agent.js (Forked Child Process)**: detém Supabase, Express, WS, fila de jobs. Pode crashar e ser reiniciado sem matar o tray. Recebe IPC do main pra imprimir HTML (única operação que precisa de Electron API).

**IPC bidirecional via `child_process.fork`** com mensagens tipadas: `UPDATE_DATA`, `NOTIFICATION`, `UPDATE_ACTION`, `ENCRYPT`/`DECRYPT`, `PRINT_HTML`, `PRINT_TEST_LABEL`, `PRINT_HTML_RESULT`, `DEVICE_CHANGE`, `UPDATE_STATUS`, `UPDATE_ACTION_RESULT`.

### 3.2 Single Instance Lock

`app.requestSingleInstanceLock()` — se já houver um agent rodando, a nova instância dispara `second-instance` no original (que reabre a janela principal) e sai imediatamente. Evita duas instâncias brigando pela porta 19876.

### 3.3 Auto-start no boot

Em produção (`app.isPackaged`):
```js
app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: ['--hidden']
});
```
A flag `--hidden` faz o `createWindow` não mostrar a janela — fica só no tray.

---

## 4. Estrutura de Arquivos

```
Printer-Agent/
├── main.js                     ← Electron Main (tray, autoUpdater, spooler, IPC)
├── agent.js                    ← Forked process (jobs, queue, Supabase)
├── preloadSpooler.js           ← Preload do spooler invisível
├── package.json
├── README.md
├── .github/workflows/
│   └── release.yml             ← CI Windows + electron-builder publish
├── public/                     ← UI local (Express serve isso)
│   ├── login.html
│   ├── index.html              ← Dashboard local (header + status + logs + config)
│   ├── test-label.html         ← Página de teste de impressão
│   ├── blank-spooler.html      ← Página vazia carregada pelo spooler persistente
│   ├── css/dashboard.css       ← shadcn-style + animations
│   ├── js/dashboard.js         ← Lógica UI + polling /api/update + modal
│   └── *.png/.ico              ← Ícones (light/dark variants para tray)
├── assets/bin/
│   ├── SumatraPDF.exe          ← PDF viewer headless
│   └── SumatraPDF-settings.txt
├── data/                       ← gerado em runtime (não commitado)
│   ├── session.secure          ← Sessão Supabase encriptada (safeStorage)
│   ├── credentials.secure      ← Email+senha (encriptado, opt-in "Lembrar")
│   └── update-prefs.json       ← { skippedVersions: ["3.9.0", ...] }
├── src/
│   ├── api/
│   │   ├── server.js           ← Express + rotas + WS attach
│   │   └── controllers.js      ← Handlers (login, health, print, update*)
│   ├── config/
│   │   ├── constants.js        ← Supabase URL/key, HTTP_PORT=19876
│   │   └── state.js            ← Singleton: session, companyId, currentConfig, stats, printerStatus, updateStatus
│   ├── core/
│   │   ├── auth.js             ← Supabase signIn + persistência criptografada
│   │   ├── database.js         ← syncConfig, saveConfig, sendHeartbeat, updateJobStatus
│   │   ├── socket.js           ← Realtime channel + watchdog + drain
│   │   ├── pshost.js           ← PowerShell persistente (REPL via .ps1)
│   │   └── wsBroadcast.js      ← WebSocket server (ws://127.0.0.1:19876/ws)
│   ├── services/
│   │   ├── printerUSB.js       ← Win32 winspool.drv via C# helper (RawPrinterHelper)
│   │   ├── printerNetwork.js   ← TCP socket puro pra 9100 (ZPL/ESC-POS)
│   │   ├── printerPDF.js       ← Download Supabase Storage + SumatraPDF
│   │   └── monitor.js          ← Status de impressora (online/offline/fila) + push WS
│   └── utils/
│       ├── logger.js           ← Console + buffer in-memory + arquivo em logs/
│       └── printerValidator.js ← isValidPrinterName + safePrinterName (defesa-em-profundidade)
└── test/                       ← node:test (sem framework externo)
    ├── regression.test.js      ← 101 testes estáticos de regressão
    ├── printer-validator.test.js
    ├── pshost.test.js
    ├── printer-usb.test.js
    ├── monitor-queries.test.js
    └── ws-broadcast.test.js
```

---

## 5. API HTTP Local (port 19876)

Servidor Express em `http://127.0.0.1:19876` (CORS aberto para localhost + domínios LabelChef).

### 5.1 Auth & sessão

| Método | Path | Auth | Descrição |
|---|---|---|---|
| POST | `/login` | público | Body: `{email, password, remember}`. Retorna `{ok, companyId}`. Se `remember=true`, salva creds em `data/credentials.secure` (safeStorage). |
| GET | `/api/saved-credentials` | público | Retorna creds salvas (se houver). Usado pela tela de login pra pré-preencher. |
| POST | `/api/auto-login` | público | Tenta logar com creds salvas. Bloqueado se `explicitLogout=true`. |
| POST | `/api/logout` | público | Limpa session, seta `explicitLogout=true`. |

### 5.2 Health & status

| Método | Path | Auth | Descrição |
|---|---|---|---|
| GET | `/api/health` | **público** | Probe pelo frontend LabelChef: `{ status, version, authenticated, printerConfigured, defaultPrinter, printerOnline, connStatus, update }`. **Sem dados sensíveis.** |
| GET | `/api/status` | autenticado | Detalhado: config + companyId + companyName + printerStatus + stats + buffer de logs. |

### 5.3 Configuração & diagnóstico

| Método | Path | Auth | Descrição |
|---|---|---|---|
| POST | `/config` | autenticado | Salva config (`printerType`, `printerName`, `printerIp`, `printerPort`, `printerNickname`). Faz UPSERT em `printer_settings` e dispara monitor refresh. |
| GET | `/api/printers` | público | Lista impressoras do Windows via PSHost (cache 30s). |
| GET | `/api/doctor/diagnose` | autenticado | Snapshot da fila + status atual da impressora. |
| POST | `/api/doctor/fix` | autenticado | Limpa fila do spooler (USB) — useful quando job trava. |
| POST | `/api/test-print` | autenticado | Dispara impressão de teste (página em `public/test-label.html`). |

### 5.4 Impressão direta (caminho rápido)

| Método | Path | Auth | Descrição |
|---|---|---|---|
| POST | `/api/local-print` | público | Body: `{content, printerName?, options?}`. Imprime HTML direto via spooler persistente. Síncrono — aguarda `jobEmitter.emit('done:<id>')`. |
| POST | `/api/local-print-batch` | público | Body: `{jobs: [{id, html}]}`. Enfileira tudo no mesmo mutex sequencial usado pelo Realtime. Devolve `{ok, acceptedIds}`. Progresso vai por WS `job-progress`. |

### 5.5 Auto-update

| Método | Path | Auth | Descrição |
|---|---|---|---|
| GET | `/api/update` | público | Estado atual: `{status, version, releaseNotes, releaseName, releaseDate, currentVersion, error, progress, skippedVersions, lastCheckedAt}`. |
| POST | `/api/update/check` | público | Força checagem manual no GitHub Releases. |
| POST | `/api/update/download` | público | Body: `{autoInstall: boolean}`. Inicia download (e instala automaticamente se `autoInstall=true`). |
| POST | `/api/update/install` | público | Aplica update já baixado (quit + relaunch). |
| POST | `/api/update/skip` | público | Body: `{version}`. Persiste em `update-prefs.json`. |

### 5.6 Fallback

| Método | Path | Comportamento |
|---|---|---|
| GET | `*` | Serve `login.html` (SPA-style — JS decide se redireciona pro dashboard). |

---

## 6. WebSocket (port 19876, path `/ws`)

Servidor `ws` acoplado ao mesmo `httpServer` do Express (mesma origem, mesmo socket TCP). Endpoint: `ws://127.0.0.1:19876/ws`.

### 6.1 Mensagens server → cliente

```ts
{ type: 'hello',          payload: { version },              at: timestamp }
{ type: 'status-update',  payload: <printerStatus snapshot>, at: timestamp }
{ type: 'config-changed', payload: { config: <currentConfig> }, at: timestamp }
{ type: 'job-progress',   payload: { id, status: 'printed'|'error', source, error? }, at: timestamp }
```

### 6.2 Keepalive

- Heartbeat custom de 30s: server manda `ping`; se cliente não responder antes do próximo tick, conexão é terminada.
- Cliente não precisa enviar nada — protocolo ping/pong nativo.

### 6.3 Quem consome no frontend LabelChef

- `agentLocalWS` (em `my-app/src/lib/print/agentLocalWS.ts`) abre conexão quando `agentProbe.localAvailable=true` e ouve `status-update` (atualiza badge em <300ms) e `job-progress` (acompanhamento de batch).

---

## 7. Fluxo de Impressão (End-to-End)

### 7.1 Decisão (frontend LabelChef)

`PrintOrchestrator.print({html})` em `my-app/src/lib/print/printOrchestrator.ts`:

```
1. agentProbe.ensureProbed()   ← /api/health em 127.0.0.1
   ├─ localAvailable=true  → POST /api/local-print            (caminho 1)
   └─ localAvailable=false → checkCompanyHasActiveAgent()
                              ├─ hasActive=true  → INSERT em print_queue   (caminho 2)
                              └─ hasActive=false → window.print()           (caminho 3)
```

### 7.2 Caminho 1 — Impressão direta (mesma máquina)

```
Frontend                 Agent (Express)             Main (Electron)
  │                         │                            │
  │ POST /api/local-print   │                            │
  ├────────────────────────▶│                            │
  │                         │ enqueueLocalJob({id,html}) │
  │                         │ runQueue()                 │
  │                         │ processJob()               │
  │                         │ ipc.send('PRINT_HTML')     │
  │                         ├───────────────────────────▶│
  │                         │                            │ spooler.send('inject-html')
  │                         │                            │ webContents.print({deviceName,silent})
  │                         │ PRINT_HTML_RESULT          │
  │                         │◀───────────────────────────┤
  │                         │ jobEmitter.emit('done:id') │
  │ {ok: true}              │                            │
  │◀────────────────────────┤                            │
  │ WS 'job-progress'       │                            │
  │◀────────────────────────┤                            │
```

### 7.3 Caminho 2 — Fila Supabase (mobile / web externo)

```
Mobile/Web                Supabase                    Agent (em outro PC)
  │                         │                            │
  │ INSERT print_queue      │                            │
  ├────────────────────────▶│                            │
  │                         │ Realtime push              │
  │                         ├───────────────────────────▶│ socket.setHandler → jobQueue
  │                         │                            │ runQueue() → processJob()
  │                         │                            │ ipc → PRINT_HTML → spooler
  │                         │ UPDATE status='printed'    │
  │                         │◀───────────────────────────┤
```

**Latência observada quando Realtime saudável**: <1s.
**Safety net (v3.2.0+)**: watchdog de 20s drena `print_queue` mesmo em `SUBSCRIBED` — garante latência máxima ~20s mesmo se Realtime ficar "stuck".

### 7.4 Caminho 3 — Browser print (sem agent)

`BrowserPrintService.print(html)` abre janela com `window.open` + `window.print()`. Fallback final se não houver nem agent local nem remoto.

### 7.5 Batch printing

`POST /api/local-print-batch` aceita N jobs num único request. Internamente passa pelo MESMO `runQueue` sequencial (mutex global `isProcessingQueue`), garantindo ordem e delay de 500ms entre jobs (respiro para o spooler).

Progresso por job vai por WS `job-progress` com o `id` que o cliente enviou — frontend acompanha "X/N enviados" em tempo real.

---

## 8. Anti-Colisão & Spooler Persistente

**Problema clássico:** `webContents.print()` cria uma `BrowserWindow` nova por job. Cada criação demora ~200-400ms (carregar template, fontes, GPU). Em batch isso vira segundos por job.

**Solução (`createPersistentSpooler` em main.js):**
- Uma `BrowserWindow` oculta (`offscreen: true`, `setFrameRate(1)`) é criada no boot do app e fica viva pra sempre.
- Carrega `public/blank-spooler.html` uma vez.
- Para cada job: `webContents.send('inject-html-for-print', {id, htmlContent, printerName, widthMicrons})`.
- O preload do spooler injeta o HTML no DOM e dispara `webContents.print({deviceName, silent: true, pageSize})`.
- Latência por job: ~80-150ms (sem reload).

**Mutex via `isProcessingQueue`** em `runQueue` (agent.js) garante que jobs sequenciais não rodem em paralelo (evita "race" no spooler).

---

## 9. Sistema de Auto-Update (electron-updater)

### 9.1 Configuração

```js
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowDowngrade = false;
```

Controle 100% manual — usuário decide quando baixar e instalar.

### 9.2 Estados (espelhados pro frontend via `/api/update`)

| Status | Significado |
|---|---|
| `idle` | Nenhuma checagem em andamento OU já está atualizado |
| `checking` | Consultando GitHub |
| `available` | Nova versão detectada, aguardando consentimento |
| `downloading` | Baixando (com `downloadProgress` 0-100) |
| `ready` | Baixado, pronto para `quitAndInstall` |
| `error` | Falha (consultar `updateState.error`) |
| `skipped` | Versão atual foi pulada pelo usuário |

### 9.3 Persistência de preferências

`data/update-prefs.json`:
```json
{ "skippedVersions": ["3.9.0", "3.9.3"] }
```

Quando o autoUpdater dispara `update-available` e a versão está na lista, o estado vira `skipped` (sem notificar).

### 9.4 Fluxo "Baixar e instalar" (1 clique)

`actionStartDownload({ autoInstall: true })`:
- Seta `updateState.autoInstallAfterDownload = true`.
- Chama `autoUpdater.downloadUpdate()`.
- Listener `update-downloaded` consume a flag e chama `actionInstallNow()` após 1.5s.
- `actionInstallNow` → `autoUpdater.quitAndInstall(false, true)` (`isSilent=false, isForceRunAfter=true`).

### 9.5 Comparação correta de versões (v3.9.3+)

`actionCheckForUpdates` compara `res.updateInfo.version !== app.getVersion()` em vez de só `!!res.updateInfo` (que retornava true sempre que GitHub tinha qualquer release).

### 9.6 GitHub Actions release pipeline

`.github/workflows/release.yml`:

```yaml
on:
  push:
    tags: ["v*"]
  workflow_dispatch:

jobs:
  build-and-publish:
    runs-on: windows-latest
    steps:
      - actions/checkout@v4
      - actions/setup-node@v4 (node 20, cache npm)
      - npm ci
      - npm test                  # 101 testes (regression + unit)
      - npm run release           # electron-builder --publish always
        env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Artefatos gerados na release:**
- `LabelChef-Agent-Setup-X.Y.Z.exe` (NSIS, ~85MB)
- `LabelChef-Agent-Setup-X.Y.Z.exe.blockmap` (~90KB, delta map para updates incrementais)
- `latest.yml` (~350B, contém versão + hashes + paths)

### 9.7 Sem code-signing

Primeira instalação manual mostra SmartScreen. Updates subsequentes substituem o `.exe` no mesmo path — silenciosos. Não há certificado EV/OV no pipeline.

---

## 10. Tray Nativo (v3.9.0+)

**Padrão Docker Desktop / OneDrive / Slack.** Tudo controlado pelo Windows via `tray.setContextMenu()`:

- `tray.on('double-click')` → abre/foca o painel principal.
- Click esquerdo OU direito → Windows abre o menu nativo (posição, foco, dismiss = SO).

### 10.1 Itens contextuais do menu

Cabeçalho: `LabelChef Agent vX.Y.Z` (disabled).

**Quando `updateState.status === 'available'`:**
- `Atualização disponível: vX.Y.Z` (disabled)
- `Baixar e instalar` → `actionStartDownload({autoInstall: true})`
- `Pular esta versão` → `actionSkipVersion(v)`

**Quando `downloading`:** label `Baixando vX.Y.Z (NN%)` + sufixo `(instala ao terminar)` se autoInstall.

**Quando `ready`:**
- `Versão vX.Y.Z pronta para instalar` (disabled)
- `Instalar e reiniciar agora` → `actionInstallNow()`
- `Pular esta versão`

**Status sempre visível (disabled):**
- `Sistema: <agentState.status>` com ícone `status-on/off/wait-{light|dark}.png`
- `Impressora: <agentState.printerName>`
- `Status: <agentState.printerStatus>`

**Ações sempre disponíveis:**
- `Verificar atualizações` → `actionCheckForUpdates()`
- `Corrigir Fila de Impressão` → IPC `FORCE_CLEAR_QUEUE` pro agent
- `Imprimir Página de Teste` → IPC `RUN_TEST_PRINT`
- `Abrir Painel de Controle` → `mainWindow.show()`
- `Sair` → `app.isQuitting=true; agentProcess.kill(); app.quit()`

### 10.2 Atualização do menu

`updateTrayMenu()` é chamado em:
- Mudanças de `updateState` (via listeners do autoUpdater)
- Mudanças de `nativeTheme` (para alternar ícones light/dark)
- Mudanças de `agentState` (via IPC `UPDATE_DATA` do agent.js)

Loop IPC do tray em agent.js manda `{status, printerName, printerStatus}` a cada 5s, mas **com diff** — só envia se algo mudou (evita re-render desnecessário).

---

## 11. UI Local do Agent (Express + Static)

Servida em `http://127.0.0.1:19876`. Arquivos em `public/`.

### 11.1 Telas

- **`login.html`** — email + senha + "Lembrar-me". Faz POST `/login`. Em caso de creds salvas, exibe banner "Continuar como <email>" via `/api/saved-credentials`.
- **`index.html`** — dashboard com:
  - Header: logo + **badge interativo de update** (v3.9.0+) + uptime + counters de jobs + theme toggle + status de conexão + logout
  - Status card central com ícone, título, mensagem e ações ("Corrigir Fila", "Imprimir Teste")
  - Log do sistema (buffer in-memory do logger)
  - Sidebar de configuração (empresa, conexão USB/Rede, impressora, salvar)
  - **Modal de update** flutuante quando há `available/downloading/ready`

### 11.2 Badge de Update (v3.9.0+ com refinamentos até v3.9.3)

`<span id="updateBadge">` herdando `.version-badge` + classes `.update-badge.state-{idle|checking|available|downloading|ready|error|skipped}`.

Dot indicador colorido sempre visível:
- `state-idle` → verde (atualizado)
- `state-checking` → cinza pulsando
- `state-available` → amarelo pulsando
- `state-downloading` → azul (sem barra interna)
- `state-ready` → verde pulsando
- `state-error` → vermelho
- `state-skipped` → cinza opaco

**Interações:**
- Click em `idle/skipped/error` → toast imediato "Verificando atualizações" + POST `/api/update/check`
- Click em `available/downloading/ready` → abre modal
- **Shift+Click** (modo teste) → renderiza modal com versão fictícia `vX.Y.Z-teste` para verificar o fluxo visual sem release real. Botões ficam informativos (não disparam ação real).

### 11.3 Modal de update

`<div id="updateModal" class="modal-overlay">` em `index.html`. Apresenta:
- Ícone + título conforme estado
- Subtítulo descritivo
- `<details>` com release notes (de `state.releaseNotes`)
- Progress bar (apenas em `downloading`)
- 3 botões em hierarquia visual:
  - **Pular esta versão** (link sublinhado, baixíssima ênfase) → `skipUpdateVersion(v)`
  - **Lembrar depois** (ghost, transparente) → `dismissUpdateModal()` (TTL de 1h)
  - **Baixar e instalar** (CTA primary sólido) → `updateAction('download', {autoInstall: true})`

**Crítico (v3.9.4+)**: o modal usa `.modal-overlay.active` para ficar visível (`opacity: 0 → 1`, `visibility: hidden → visible`). Não basta `display: flex` — sem a classe `.active` o modal está no DOM mas invisível. Helpers `openUpdateModal()` / `closeUpdateModal()` centralizam isso.

**TTL de dismissal (v3.9.2+):** `sessionStorage['labelchef-agent-update-dismissed']` armazena `{[version]: dismissedAt}`. Após 1h, `isDismissed()` limpa automaticamente — evita modal "preso" por clique acidental.

### 11.4 Polling adaptativo

`dashboard.js` faz `pollUpdateStatus()` a cada 5s (1s durante `downloading`). Chama `renderUpdateBadge` + `maybeShowUpdateModal` sempre.

---

## 12. Integração com Frontend LabelChef (Web App)

### 12.1 AgentProbe (`my-app/src/lib/print/agentProbe.ts`)

Singleton que cacheia o estado do agent local:

```ts
interface ProbeSnapshot {
  ok: boolean;
  localAvailable: boolean;
  detail: AgentStatus | null;  // do /api/health
  lastCheckAt: number | null;
  inFlight: boolean;
}
```

Triggers de revalidação:
- `agentProbe.ensureProbed()` no mount (`AgentProbeBootstrap`)
- Tick periódico de 60s
- `visibilitychange` → visible
- `online` event
- `agentProbe.invalidate()` após falha de impressão direta

**Crítico (v3.2.0+):** `applyExternalStatus(printerStatus)` é chamado quando chega push WS `status-update`. **DEVE preservar `version` e demais campos do probe HTTP** via spread `{...current.detail, ...overrides}` — sem isso, a `version` virava `undefined` a cada push e o badge piscava pra "Agent desatualizado" por segundos.

### 12.2 AgentStatusBadge (sidebar)

Estados (`useAgentStatus`):
- `local-online` — probe HTTP em 127.0.0.1 OK
- `remote-online` — sem agent local, mas heartbeat ativo em `printer_settings.last_seen` (<2min)
- `offline` — heartbeat antigo (>2min mas existe registro)
- `none` — empresa nunca teve agent registrado
- `loading` — primeira verificação ainda não concluiu

**CTA de download condicional (v3.9.0+):**
- Variante `install` (verde) → estados sem agent local (`none`, `offline`, `remote-online`)
- Variante `upgrade-legacy` (vermelho com `AlertTriangle`) → `local-online` + `updateStatus="legacy"` (agent <3.7.0 ou sem reportar version)

Tooltip mostra: título, sub, e quando aplicável o texto explicativo de download/upgrade.

### 12.3 Detecção de versão desatualizada (v3.9.x+)

`my-app/src/lib/print/useLatestAgentVersion.ts`:

```ts
function classifyAgentUpdate(current: string|undefined, latest: string|null): AgentUpdateStatus
// "current" | "outdated" | "legacy" | "unknown"
```

Regras:
- `!latest` → `"unknown"` (não decide até saber a release atual)
- `!current` → `"legacy"` (agent muito antigo, não reporta version)
- `compareVersions(current, latest) >= 0` → `"current"`
- `compareVersions(current, "3.7.0") >= 0` → `"outdated"` (tem auto-updater — usuário decide via tray)
- caso contrário → `"legacy"` (precisa instalar manualmente)

**Por que 3.7.0 é a fronteira:** foi a versão que introduziu electron-updater. Agents anteriores não se atualizam sozinhos.

`compareVersions(a, b)` é semver simples (split por `.`, parseInt, NaN → 0 seguro).

### 12.4 Endpoints do Web App (não do agent)

| Path | Função |
|---|---|
| `GET /api/agent/download` | Resolve `releases/latest` do GitHub, encontra `.exe` (excluindo `.blockmap`), retorna 302 redirect. Cache CDN 5min. |
| `GET /api/agent/latest-version` | Retorna `{tag, version, name, publishedAt}` da última release. Cache CDN 5min. |

Ambos públicos (sem auth) — versão é informação pública e download é arquivo binário aberto.

### 12.5 Compare-version e teste

`my-app/src/lib/print/useLatestAgentVersion.test.ts` — 12 testes cobrindo:
- `compareVersions`: iguais, menor patch/minor/major, tamanhos diferentes, entradas inválidas
- `classifyAgentUpdate`: unknown sem latest, legacy sem current, current bate, current à frente (cache stale), outdated (>=3.7.0), legacy (<3.7.0), fronteira exata 3.7.0

`my-app/src/lib/print/agentProbe.test.ts` — teste de regressão crítico: `applyExternalStatus` DEVE preservar `version/authenticated/connStatus` do probe HTTP anterior.

---

## 13. Auth + safeStorage

### 13.1 Login

1. `auth.login(email, password)` → `supabase.auth.signInWithPassword`
2. Sucesso → `loadUserContext(user)` carrega profile + `tenant_id` da tabela `users`
3. `persistSession({access_token, refresh_token})` → encripta com `safeStorage.encryptString` e salva em `data/session.secure`
4. Se `remember=true` no login, também encripta `{email, password}` em `data/credentials.secure`

### 13.2 IPC bridge para safeStorage

`agent.js` (forked) NÃO tem acesso direto a `safeStorage` (Electron API, só no main). Solução:
- `agent.js` envia `{type: 'ENCRYPT', id, data}` ou `{type: 'DECRYPT', id, dataHex}`
- `main.js` chama `safeStorage.encryptString/decryptString` e responde `{type: 'ENCRYPT_RESULT', id, success, data}`
- `agent.js` resolve a Promise correspondente via `pendingRequests.get(id)`

Encriptado fica em hex (JSON-safe) no disco.

### 13.3 Auto-login no boot

1. `auth.init()` lê `data/session.secure`
2. Decripta → JSON `{access_token, refresh_token}`
3. `supabase.auth.setSession()` restaura
4. Se sucesso → carrega context → conecta socket + monitor
5. Se falha → limpa session + força login manual

**Flag `state.explicitLogout`:** após `/api/logout`, fica `true`. `/api/auto-login` rejeita enquanto estiver `true` (impede auto-login após logout intencional).

### 13.4 ⚠️ Segurança crítica

- `data/*.secure` **NUNCA** podem ser commitados (em `.gitignore`)
- `SUPABASE_ANON_KEY` em `src/config/constants.js` é a chave **anônima**, segura para distribuição — proteção real é RLS do banco
- safeStorage usa DPAPI no Windows — chave atrelada à conta de usuário do SO. Copiar `data/` pra outra máquina/usuário INVALIDA os arquivos

---

## 14. Monitor & PSHost

### 14.1 PSHost (PowerShell persistente)

`src/core/pshost.js` mantém UM `powershell.exe` vivo a vida toda do agent, comunicando via stdin/stdout com protocolo REPL custom:

```
Node escreve no stdin:
    [Console]::WriteLine('PS_BEGIN::<id>')
    <comando user>
    [Console]::WriteLine('PS_END::<id>')
    ###END_OF_BLOCK###

PS lê linha por linha, acumula, Invoke-Expression no bloco completo.
```

**Custos comparativos:**
- Antes: spawn `powershell.exe` a cada query (~200-500ms JIT por spawn)
- Agora: 1 processo persistente, latência ~20-50ms por comando

Idle: ~50-80MB RAM constante.

**Preamble:** carregado UMA vez no boot via `pshost.setPreamble(RAW_PRINTER_HELPER_PREAMBLE)`. Contém o `Add-Type @' ... '@` que registra `[RawPrinterHelper]` (classe C# Win32 P/Invoke pra `OpenPrinter/StartDocPrinter/WritePrinter/...`).

### 14.2 Monitor

`src/services/monitor.js`:
- Tick de 60s para `_scanUsbGlobal()` + `_refreshUsb()` ou `_refreshNetwork()`
- `onDeviceChange(reason)` é chamado por:
  - `WM_DEVICECHANGE` (hook do Electron em main.js — quando dispositivo USB é plugado/desplugado)
  - `processJob` antes de cada impressão (refresh just-in-time)
  - `saveConfig` (mudança de impressora configurada)

Após cada refresh: `_publishIfChanged()` compara snapshot atual com o último broadcastado e dispara WS `status-update` somente se diferente.

### 14.3 WM_DEVICECHANGE Hook

`main.js`:
```js
const hookWin = new BrowserWindow({show: false, ...});
hookWin.hookWindowMessage(0x0219, () => {
    if (Date.now() - lastDeviceChangeAt < 1000) return; // debounce
    agentProcess.send({ type: 'DEVICE_CHANGE' });
});
```

Custo idle: 0 (sem polling). Reage instantaneamente a plug/unplug.

---

## 15. Realtime + Safety Net (Print Queue)

### 15.1 Subscription

`src/core/socket.js` em `connect()`:

```js
this.subscription = supabase.channel('agent_queue')
    .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'print_queue',
        filter: `company_id=eq.${state.companyId}`
    }, (payload) => this.handler(payload.new))
    .subscribe();
```

Quando recebe SUBSCRIBED → drena pending (qualquer job que ficou na fila enquanto desconectado).

### 15.2 Modos do timer

| Modo | Quando | Intervalo | Ação |
|---|---|---|---|
| `reconnect` | Status ≠ SUBSCRIBED | 15s | Reconnect + drain (caso conecte) |
| `watchdog` | Status = SUBSCRIBED | **20s** (v3.2.0+) | Verifica status + **drain como safety net** |

### 15.3 Safety net (v3.2.0+) — fix crítico

**Bug histórico:** Realtime do Supabase pode entrar em "stuck SUBSCRIBED" (mostra conectado mas não entrega eventos — comum em redes flaky, wake-from-sleep, NAT rebind). Watchdog antigo SÓ verificava status — como continuava SUBSCRIBED, não drenava nada. Jobs de mobile sentavam ~60s até o heartbeat interno do client Supabase derrubar o canal.

**Fix:** watchdog SUBSCRIBED agora também chama `_drainPending()` a cada tick:

```sql
SELECT * FROM print_queue
WHERE company_id = $1 AND status IN ('pending', 'processing')
```

Latência máxima garantida: ~20s mesmo no pior caso (Realtime totalmente quebrado). Custo: 1 SELECT a cada 20s por agent (negligenciável).

### 15.4 Deduplicação

`processedJobIds: Set<string>` em agent.js — Realtime + drain podem enviar o mesmo job duas vezes. ID é adicionado quando o handler recebe, removido após 60s via `setTimeout`.

### 15.5 Heartbeat (agent → Supabase)

A cada 60s: `UPDATE printer_settings SET last_seen=NOW() WHERE company_id=$1`. Frontend tolera até 2min (4× o intervalo) para considerar o agent "ativo".

---

## 16. Defesa-em-profundidade (Printer Validator)

`src/utils/printerValidator.js`:

```js
function isValidPrinterName(name) {
    // String não-vazia, ≤256 chars, sem caracteres de controle ASCII (0x00-0x1F, 0x7F)
}

function safePrinterName(...candidates) {
    // Primeiro candidato válido. null se todos inválidos.
}
```

Validação aplicada em **3 camadas** (todas DEVEM validar; bug em uma não pode vazar):

1. **`agent.js`** `processJob` + `requestHtmlPrint` + `requestTestPrint` — rejeita ANTES do IPC
2. **`main.js`** handlers `PRINT_HTML`, `PRINT_TEST_LABEL`, `spooler-ready-to-print` — valida ANTES de tocar em `webContents.print`
3. **`controllers.js`** `localPrint`, `localPrintBatch`, `testPrint` — consolida candidatos (`req.body.printerName` → `state.currentConfig.printerName`)

**Por quê:** se `webContents.print({deviceName: ''})` for chamado, Electron usa a **impressora padrão do Windows**. Em escritório compartilhado, recibo LabelChef pode acabar na impressora do RH.

---

## 17. Logging

`src/utils/logger.js`:
- `console.log/warn/error` formatado com cor (terminal)
- Arquivo em `<userData>/logs/agent-YYYY-MM-DD.log`
- Buffer in-memory de ~200 linhas pro `/api/status` expor no dashboard local
- Padrão: `[TAG] mensagem` (ex: `[AUTH]`, `[DB]`, `[SOCKET]`, `[JOB]`, `[PRINTER:USB]`)

---

## 18. Testes (101 testes)

`npm test` roda:

| Arquivo | Cobertura |
|---|---|
| `regression.test.js` | 101 testes estáticos — lê fontes e bate regex (sem mock/runtime). Trava regressões conhecidas (heartbeat 60s, validators chamados, monitor não-bloqueante, etc.) |
| `printer-validator.test.js` | Unit de `isValidPrinterName/safePrinterName` |
| `pshost.test.js` | Protocolo REPL (begin/end, terminator, encoding) |
| `printer-usb.test.js` | Sanitização do nome de impressora no script PowerShell (evita injection) |
| `monitor-queries.test.js` | Forma das queries WMI (Get-Printer, Get-PrintJob) |
| `ws-broadcast.test.js` | Heartbeat de 30s, clientes mortos detectados, broadcast só pra readyState=1 |

**Pré-commit hooks:** `npm run predist` e `npm run prerelease` rodam `npm test` automaticamente — falha em teste = build/release abortado.

---

## 19. Histórico de Releases (relevante para alinhar agents derivados)

| Versão | Mudança Crítica |
|---|---|
| **3.7.0** | Introdução do auto-update via electron-updater + GitHub Releases |
| **3.7.2** | Banner permanente de update (depois substituído por modal em 3.7.3) |
| **3.7.3** | UI limpa: modal substitui banner, tray polido, `version` exposta no `/api/health` |
| **3.7.6** | Botão "Baixar e instalar" em 1 clique (flag `autoInstall`) |
| **3.8.x** | Tentativas falhas de popup HTML do tray (positioning/flicker) |
| **3.9.0** | Revert para menu nativo do Windows (`tray.setContextMenu`). Padrão Docker. |
| **3.9.1** | Badge interativo de update no header do dashboard local |
| **3.9.2** | Badge discreto (estilo shadcn) + TTL de 1h no dismiss do modal |
| **3.9.3** | Fix `hasUpdate` (comparação real de versões), dot verde de "atualizado", toast imediato, modo teste shift+click |
| **3.9.4** | **Fix CRÍTICO**: modal aplica classe `.active` corretamente (estava invisível) |
| **3.9.5** | Modal: tipografia compacta + hierarquia visual CTA/ghost/link |
| **3.2.0** | **Fix CRÍTICO**: watchdog drena pending jobs — corrige latência ~60s em Realtime stuck |

---

## 20. Pontos Críticos para Alinhar Agents Derivados

Se você está mantendo OUTRO agent baseado neste, atenção especial aos seguintes:

### 20.1 Mandatório alinhar

1. **`/api/health` deve retornar `version`** — o frontend LabelChef usa pra detectar agents legados (`!data.version` → classifica como `"legacy"` e força download manual).

2. **`applyExternalStatus` (no probe do frontend) DEVE preservar todos os campos do probe HTTP via spread**:
   ```ts
   const detail = { ...(current.detail ?? {}), ok: true, ..., printerOnline: ... };
   ```
   Sem isso, cada push WS faz o badge piscar pra "outdated".

3. **`tray.setContextMenu()` é o padrão correto** (não HTML popup). Tentativas de popup HTML não conseguem domar posição+flicker no Windows.

4. **Watchdog do socket deve drenar pending jobs mesmo em SUBSCRIBED.** Realtime do Supabase fica stuck em produção — não confie só nele.

5. **`isValidPrinterName` em TRÊS camadas** (agent.js, main.js, controllers.js). Cada bug em uma é mitigado pela próxima — sem isso, vazamento pra default printer do SO.

6. **Modal precisa de `.active` + `display: flex` para ficar visível.** Setar só `display` não basta (CSS tem `opacity: 0; visibility: hidden`).

7. **`autoDownload = false` e `autoInstallOnAppQuit = false`** no autoUpdater. Controle 100% manual — usuário decide.

8. **Comparação de versão deve usar `latest !== current` real**, não `!!res.updateInfo`. O electron-updater retorna `updateInfo` mesmo quando já atualizado.

### 20.2 Padrões de design seguros

- **Spooler persistente** para reduzir latência por job (5-10x mais rápido).
- **PSHost persistente** para queries WMI (evita spawn por query, ~17000 menos spawns/dia).
- **WM_DEVICECHANGE hook** em vez de polling de USB.
- **WS server na MESMA porta do HTTP** (`http.createServer` + `wss({server})`) — sem CORS extra, mesma origem.
- **Validador de printerName + safe fallback null** — nunca cair na default printer.
- **Single instance lock** — sem isso, segunda instância briga pela porta 19876.
- **safeStorage via IPC** quando o agent.js (forked) precisar criptografar — não duplicar lógica de auth.

### 20.3 Anti-padrões evitados (não voltar)

- ❌ Popup HTML em vez de menu nativo do tray
- ❌ Confiar 100% no Supabase Realtime sem safety net
- ❌ Polling de USB em vez de WM_DEVICECHANGE
- ❌ Spawn de PowerShell por query
- ❌ BrowserWindow nova por job de impressão
- ❌ Modal usando `display` sem `.active` 
- ❌ Comparação `!!updateInfo` para detectar nova versão
- ❌ Banner permanente no header em vez de modal

---

## 21. Comandos & Procedures

### 21.1 Desenvolvimento

```bash
npm install
npm start              # electron .
npm test               # 101 testes
```

### 21.2 Release manual

```bash
# 1. Bump em TODOS os arquivos:
#    - package.json
#    - agent.js (logger.info v...)
#    - src/api/server.js (AGENT_VERSION)
#    - src/api/controllers.js (version: '...', footer da test-label)
#    - public/index.html (updateBadgeLabel)
#    - public/test-label.html (footer)
#    - test/regression.test.js (asserts de versão)

# 2. Commit + tag
git add -A && git commit -m "release: vX.Y.Z — <descrição>"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z

# 3. GitHub Actions builda automaticamente em windows-latest
#    Output: LabelChef-Agent-Setup-X.Y.Z.exe + latest.yml + blockmap

# 4. Agents já instalados detectam no próximo boot (8s após app.whenReady)
```

### 21.3 Debug do auto-update

- Logs do agent em `<userData>/logs/agent-YYYY-MM-DD.log`
- Tag `[autoUpdater]` mostra checagens, downloads, erros
- `data/update-prefs.json` lista versões puladas
- DevTools no dashboard local (Ctrl+Shift+I) — console mostra polling + render do modal

---

## 22. Variáveis de Ambiente & Configuração

| Variável | Onde | Valor |
|---|---|---|
| `SUPABASE_URL` | `src/config/constants.js` | `https://dwkgbggxubtqdohntkyr.supabase.co` (público) |
| `SUPABASE_ANON_KEY` | `src/config/constants.js` | Chave anônima — RLS protege o banco |
| `HTTP_PORT` | `src/config/constants.js` | `19876` |
| `RECONNECT_POLL_MS` | `src/core/socket.js` | `15_000` |
| `WATCHDOG_MS` | `src/core/socket.js` | `20_000` (v3.2.0+) |
| `REFRESH_INTERVAL_MS` | `src/services/monitor.js` | `60_000` |
| `HEARTBEAT_MS` (WS) | `src/core/wsBroadcast.js` | `30_000` |
| Heartbeat DB | `agent.js` | `60_000` |
| `AGENT_HEALTH_CHECK_TIMEOUT_MS` (frontend) | `my-app/src/lib/print/localAgentClient.ts` | `8_000` |
| `CACHE_SECONDS` (downloads/version API) | `my-app/src/app/api/agent/*` | `300` |

---

## 23. Glossário

| Termo | Significado |
|---|---|
| **Agent** | Aplicação Electron desktop que roda no PC do usuário |
| **Probe** | Verificação HTTP em `127.0.0.1:19876/api/health` para detectar agent local |
| **Heartbeat** | UPDATE em `printer_settings.last_seen` a cada 60s, indica agent vivo |
| **Spooler persistente** | BrowserWindow oculta que renderiza HTML para imprimir (evita criar uma por job) |
| **PSHost** | Processo PowerShell persistente para queries WMI |
| **Watchdog** | Timer que verifica saúde da subscription Realtime + drena pending (v3.2.0+) |
| **Stuck SUBSCRIBED** | Estado patológico onde Realtime mostra conectado mas não entrega eventos |
| **Local print** | Caminho rápido: POST direto pro 127.0.0.1, sem passar pela cloud |
| **Queue print** | INSERT em `print_queue` da Supabase; agent assina via Realtime |
| **Browser print** | Fallback final: `window.open + window.print()` quando não há nenhum agent |
| **Batch** | Múltiplos jobs num único request, processados em ordem pelo mutex `runQueue` |
| **Legacy agent** | Agent <3.7.0 (sem auto-updater) ou que não reporta `version` em `/api/health` |
| **safeStorage** | API do Electron que usa DPAPI (Windows) para criptografar dados sensíveis com chave do usuário |

---

**Fim do relatório.** Atualizado para v3.2.0. Para mudanças posteriores, consultar `git log` em `dancampari/labelchef-printer-agent`.
