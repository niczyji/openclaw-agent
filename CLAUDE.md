# OpenClaw-Agent — CLAUDE.md

## Projektübersicht
TypeScript-Agent mit Telegram-Bot-Interface, Tool-Loop und zwei LLM-Providern (Grok + Anthropic).
Läuft als systemd-Service (`openclaw-agent.service`).

## Architektur

```
src/
├── main.ts                  # Entry: startet Telegram oder CLI
├── config.ts                # Env-Variablen (GROK_API_KEY, ANTHROPIC_API_KEY, ...)
├── logger.ts                # logEvent() utility
├── adapters/
│   ├── telegram.ts          # Telegram-Bot (polling), Approval-Flow, Builder-Commands
│   ├── telegram-utils.ts    # sendLongMessage() helper
│   └── cli.ts               # CLI-Adapter
├── core/
│   ├── router.ts            # chat() → grok | anthropic je nach purpose
│   ├── toolloop.ts          # runToolLoop() + runAgentToolLoop()
│   ├── agent.ts             # runAgent() (simpler, kein Tool-Loop)
│   ├── budget.ts            # Token/Step-Limits
│   ├── types.ts             # LlmMessage, ToolCall, Usage, Purpose, etc.
│   └── builder/             # diff/apply/rollback für File-Patches
├── providers/
│   ├── grok.ts              # OpenAI-SDK → api.x.ai
│   └── anthropic.ts         # Anthropic SDK
├── tools/
│   ├── definitions.ts       # ALL_TOOLS: read_file, list_dir, write_file, run_cmd, calculator, stage_file, diff_op, apply_patch, rollback
│   ├── registry.ts          # runToolFromModelCall()
│   ├── policy.ts            # classifyTool(), Zugriffskontrolle
│   ├── builder.ts           # Builder-Tool-Implementations
│   └── run_cmd.ts           # Shell-Allowlist
├── memory/
│   ├── store.ts             # getOrCreateSession(), saveSession()
│   └── sessions.ts          # deleteSession()
└── features/
    └── verkaufpilot/        # Gmail-Integration, Kleinanzeigen-Parser
        ├── gmail/           # Google Gmail API
        ├── classifyKleinanzeigenIntent.ts
        └── parseKleinanzeigenMail.ts
```

## Routing-Logik
- **runtime** (default) → **Grok** (`grok-3-mini`)
- **dev** (`/dev`, `/devon`) → **Anthropic** (`claude-sonnet-4-6`)
- Provider wählbar per `OPENCLAW_PROVIDER` / `OPENCLAW_MODEL` env

## Telegram-Commands
| Command | Beschreibung |
|---------|-------------|
| `/help` / `/start` | Hilfe anzeigen |
| `/id` | chatId + sessionId |
| `/reset` | Session löschen |
| `/dev <text>` | Dev-Mode (Anthropic) + Builder |
| `/devon` / `/devoff` | Dev als Standard ein/aus |
| `/autopilot on/off` | Autopilot (nur Admin) |
| `/lastop` | Letzte staged Operation |
| `/status <opId>` | Op-Status |
| `/diff <opId>` | Diff anzeigen |
| `/apply <opId>` | Patch anwenden (Admin + /devon) |
| `/rollback <opId>` | Rollback (Admin + /devon) |
| `/discard <opId>` | Op verwerfen (Admin) |

## Environment (.env)
```
GROK_API_KEY=...
ANTHROPIC_API_KEY=...
GROK_MODEL=grok-3-mini
ANTHROPIC_MODEL=claude-sonnet-4-6
TELEGRAM_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=1868433117
TELEGRAM_ADMIN_CHAT_IDS=1868433117
TELEGRAM_RATE_LIMIT_SECONDS=5
TELEGRAM_SHOW_USAGE=1
COST_GROK_USD_PER_1M_IN=0.30
COST_GROK_USD_PER_1M_OUT=0.50
COST_ANTHROPIC_USD_PER_1M_IN=3
COST_ANTHROPIC_USD_PER_1M_OUT=15
MAX_STEPS=6
MAX_OUTPUT_TOKENS=700
MAX_TOTAL_READ_BYTES=200000
MAX_TOOL_CALLS=8
WRITE_BUDGET=1
AGENT_DISABLED=0
OPENCLAW_PROVIDER=anthropic
OPENCLAW_MODEL=claude-sonnet-4-6
```

## Google / Gmail
- **Credentials**: `secrets/google-gmail-credentials.json` (OAuth 2.0 Web App)
  - project_id: `vocal-affinity-490010-f6`
  - redirect_uri: `http://localhost:3000/oauth2callback`
- **Token**: `token.json` (access_token + refresh_token, scope: gmail.readonly)
- Auth-Lib: `@google-cloud/local-auth`

## NPM Scripts
```bash
npm run dev          # tsx src/main.ts (Telegram wenn TOKEN gesetzt, sonst CLI)
npm run build        # tsup → dist/
npm start            # node dist/telegram-main.js
npm run restart      # build + systemctl restart openclaw-agent.service
npm run lint:fix     # ESLint auto-fix
```

## Abhängigkeiten (wichtigste)
- `@anthropic-ai/sdk` ^0.78.0
- `googleapis` ^171.4.0
- `node-telegram-bot-api` ^0.67.0
- `openai` ^6.22.0 (für Grok via OpenAI-compat.)
- `dotenv` ^17.3.1
- `tsx` + `tsup` für Build

## Limits / Budget
- `MAX_STEPS=6` — max Tool-Loop-Iterationen
- `MAX_TOOL_CALLS=8` — max Tool-Calls pro Run
- `WRITE_BUDGET=1` — max Writes pro Run
- `MAX_OUTPUT_TOKENS=700`

## Daten-Verzeichnisse
- `data/patches/staged/` — Builder-Ops (nach ISO-Timestamp sortierbar)
- `data/outputs/` — write_file Output (runtime)
- `logs/` — logEvent Output

## Systemd
```bash
sudo systemctl status openclaw-agent.service
sudo journalctl -u openclaw-agent.service -n 50 --no-pager
npm run restart      # build + daemon-reload + restart + logs
```
