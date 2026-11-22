# dsh-agents

[English](README.md) | 中文

在 [dsh](https://github.com/deepseek-ai/deepseek-harness) 里管理 Claude Code / Codex 会话：浏览、续接、对话、批准。只渲染和转发，不改 CLI 的设置、提示词、工具。

## 安装

```sh
dsh plugin --profile web add @januory/dsh-agents
```

## 结构

```
浏览器 (lib/client.js)                    宿主 (src/index.js)
  sidebar.workspaces  会话列表              agentCliProviders 注册表
  main                转录 + 输入框         Remote "agentCli"（Typert，JSON）
  shell.overlay       标题栏下拉框          TurnManager：seq 缓冲，轮询
  settings.section    默认选项              claude：JSONL + claude -p stream-json
                                            codex： app-server JSON-RPC
```

## 配置

```yaml
- id: dsh-agents
  name: '@januory/dsh-agents'
  config:
    claude: { enabled: true, command: claude, home: '' }   # home 留空 → ~/.claude
    codex:  { enabled: true, command: codex,  home: '' }   # 留空 → 默认；填写 → CODEX_HOME
    turnRetentionMs: 600000
    abandonTimeoutMs: 300000
```

## 开发

```sh
pnpm install && pnpm run build:client
pnpm test
node test/smoke-claude.mjs --tool
node test/smoke-codex.mjs
SKIP_TURNS=1 node test/ui-check.mjs   # Playwright；需先用 tmp/home 起 dsh web，见脚本
```
