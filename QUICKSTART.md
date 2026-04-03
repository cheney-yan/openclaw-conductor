# Quick Start

This guide gets you to **step one**: the conductor bot is online and you can talk to it via Discord DM. That's the foundation everything else builds on.

Orchestrating OpenClaw agents and other Discord bots comes next — the conductor walks you through that interactively once it's running (use `/setup` in your server).

---

## Prerequisites

- Node.js 20+
- An OpenAI-compatible API key
- A Discord server where you have admin rights

---

## 1. Create the Discord Bot

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. **Bot** tab → **Add Bot**
3. **Privileged Gateway Intents** → enable **Message Content Intent**
4. **Reset Token** → copy it
5. **OAuth2 → URL Generator** → scopes: `bot` + `applications.commands` → permissions: **Administrator**
6. Open the generated URL → authorize for your server

---

## 2. Configure & Run

```bash
git clone https://github.com/your-username/openclaw-conductor
cd openclaw-conductor
npm install
cp .env.example .env
```

Edit `.env` — only **two values** required:

```env
DISCORD_BOT_TOKEN=    # from step 1
OPENAI_API_KEY=       # your OpenAI-compatible API key
```

```bash
npm start
```

The bot auto-detects its application ID, registers slash commands, and comes online.

**Optional:** copy `providers.example.yaml` → `providers.yaml` for multi-provider fallback chain.

---

## Commands

**DM the bot:**

| Command | What it does |
|---------|-------------|
| `!help` | List all commands |
| `!new` | Start a fresh conversation session |
| `!clean` | Archive + delete bot messages (with confirmation) |
| `stop` | Interrupt a running task |

**In a guild channel:**

| Slash Command | What it does |
|---------|-------------|
| `/topic` | Open / manage work topics |
| `/memory` | Inspect captured memory |
| `/status` | List open topics |
| `/model` | Show or switch the active AI model |
| `/openclaw` | View / manage OpenClaw config |
| `/setup` | Step-by-step new agent wizard |
