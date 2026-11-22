# dsh-agents

English | [中文](README.zh.md)

Claude Code and Codex sessions inside [dsh](https://github.com/deepseek-ai/deepseek-harness): browse, resume, chat, approve. Renders and forwards only — the CLIs' settings, prompts and tools are untouched.

## Install

```sh
dsh plugin --profile web add @januory/dsh-agents
```

## Architecture

```
client (lib/client.js)                    host (src/index.js)
  sidebar.workspaces  session list          agentCliProviders registry
  main                transcript+composer   Remote "agentCli" (Typert, JSON)
  shell.overlay       header dropdown       TurnManager: seq buffer, polled
  settings.section    defaults              claude: JSONL + claude -p stream-json
                                            codex:  app-server JSON-RPC
```

## Config

```yaml
- id: dsh-agents
  name: '@januory/dsh-agents'
  config:
    claude: { enabled: true, command: claude, home: '' }   # home '' → ~/.claude
    codex:  { enabled: true, command: codex,  home: '' }   # home '' → default; set → CODEX_HOME
    turnRetentionMs: 600000
    abandonTimeoutMs: 300000
```

## Dev

```sh
pnpm install && pnpm run build:client
pnpm test
node test/smoke-claude.mjs --tool
node test/smoke-codex.mjs
SKIP_TURNS=1 node test/ui-check.mjs   # Playwright; needs a dsh web on tmp/home, see script
```
