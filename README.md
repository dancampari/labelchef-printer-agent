# 🖨️ LabelChef Printer Agent - Build Guide

Este diretório contém todo o código fonte necessário para gerar o instalador do Agente de Impressão Windows.

## 📋 Pré-requisitos

1. **Node.js** instalado na sua máquina de desenvolvimento.
2. **Inno Setup** instalado (para compilar o `.iss`).
3. **NSSM (Non-Sucking Service Manager)**.

## 🚀 Passo a Passo para Compilação

### 1. Configurar Credenciais
Abra o arquivo `agent.js` e edite as primeiras linhas com suas credenciais do Supabase:
```javascript
const CONST_SUPABASE_URL = "SUA_URL";
const CONST_SUPABASE_KEY = "SUA_KEY";
```
> **DICA:** Use a `service_role` key se quiser evitar problemas complexos de RLS no agente, já que ele roda no servidor do cliente.

### 2. Instalar Dependências
Abra o terminal nesta pasta (`printer_agent`) e rode:
```bash
npm install
```

### 3. Compilar o Executável (.exe)
Vamos usar a biblioteca `pkg` para transformar o JS em um EXE autônomo.
```bash
npm run build
```
Isso criará o arquivo `LabelChefAgent.exe` na pasta.

### 4. Preparar Arquivos do Instalador
Certifique-se de que os seguintes arquivos estejam JUNTOS nesta pasta:
- `LabelChefAgent.exe` (Gerado no passo anterior)
- `setup.iss` (Já criado)
- `nssm.exe` (⚠️ **VOCÊ PRECISA BAIXAR ISTO**)
  - Baixe em: https://nssm.cc/download
  - Extraia o zip e pegue o executável da pasta `win64`.
  - Copie para cá com o nome `nssm.exe`.

### 5. Gerar o Instalador
1. Dê um duplo clique no arquivo `setup.iss`.
2. O Inno Setup Compiler vai abrir.
3. Clique em "Run" (ou F9) para compilar.
4. O arquivo `LabelChefAgentSetup.exe` será gerado na pasta `Output` (ou na mesma pasta, dependendo da config do seu Inno).

## 📦 O que entregar para o cliente?
Apenas o arquivo final: `LabelChefAgentSetup.exe`.

Ao instalar, ele fará tudo automaticamente:
- Copia os arquivos.
- Cria o Serviço Windows "LabelChefPrint".
- Abre a porta do firewall.
- Cria atalho na área de trabalho.

## 🛠️ Como usar (Cliente)
1. Instalar o software.
2. Abrir o atalho "Configurar Impressora LabelChef" no Desktop.
3. Preencher o **Restaurant ID** (que ele pega no painel do sistema) e o IP da impressora.
4. Salvar.
5. Pronto! A impressora começará a receber pedidos da nuvem.
