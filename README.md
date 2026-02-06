# t2c — Pay for AI with Ecash

> CLI + local proxy that makes any AI tool work with token2chat. No accounts, no API keys.

t2c manages a local Cashu ecash wallet and runs a proxy that auto-attaches payment tokens to your LLM requests. Point your AI tool at `localhost:10402` and it just works.

Built by an autonomous AI agent.

## Install

```bash
npm install -g @token2chat/t2c
```

## Quick Start

```bash
# 1. Initialize wallet and config
t2c init

# 2. Fund your wallet via Lightning
t2c mint 5000              # creates invoice for 5000 sats
t2c mint --check <quote>   # check payment & mint ecash

# 3. Connect your AI tool
t2c connect cursor         # or: openclaw, cline, aider, continue, env
t2c service start          # start the local proxy

# 4. Use AI as normal — t2c handles payment automatically
```

## How It Works

```
Your AI Tool (Cursor, Cline, OpenClaw, etc.)
    │
    │  POST http://127.0.0.1:10402/v1/chat/completions
    │  Authorization: Bearer <proxy-secret>
    ▼
t2c proxy (local)
    │  1. Estimate price from request
    │  2. Select ecash proofs from wallet
    │  3. Encode as Cashu V4 token
    │  4. Attach X-Cashu header
    │  5. Forward to Gate
    ▼
Gate (gate.token2chat.com)
    │  6. Verify ecash, proxy to LLM
    │  7. Return response + change token
    ▼
Response flows back to your AI tool
(t2c reclaims change into wallet)
```

## CLI Reference

### Wallet

| Command | Description |
|---------|-------------|
| `t2c init` | Initialize config + wallet |
| `t2c balance` | Show wallet balance (in USD) |
| `t2c mint [amount]` | Fund wallet via Lightning invoice |
| `t2c mint --check <quote>` | Check payment and mint ecash |
| `t2c recover` | Recover failed change/refund tokens |
| `t2c audit` | Full fund audit (wallet + mint + gate + anomalies) |

### Proxy Service

| Command | Description |
|---------|-------------|
| `t2c service start` | Start local proxy (foreground) |
| `t2c service stop` | Stop proxy |
| `t2c service restart` | Restart proxy |
| `t2c service status` | Show proxy status |
| `t2c service logs` | View proxy logs |
| `t2c service install` | Install as system service (launchd/systemd) |
| `t2c service uninstall` | Remove system service |

### Integration

| Command | Description |
|---------|-------------|
| `t2c connect <app>` | Auto-configure an AI tool |
| `t2c config <tool>` | Print config snippet for a specific tool |
| `t2c status` | Service status + balance overview |
| `t2c monitor` | Live TUI dashboard |
| `t2c doctor` | Self-diagnostic |

### Supported AI Tools

| Tool | Command | What it does |
|------|---------|-------------|
| **Cursor** | `t2c connect cursor` | Writes proxy URL + key to Cursor config |
| **OpenClaw** | `t2c connect openclaw` | Adds provider to OpenClaw config |
| **Cline** | `t2c connect cline` | Configures VS Code extension |
| **Continue** | `t2c connect continue` | Configures Continue extension |
| **Aider** | `t2c connect aider` | Sets environment variables |
| **Any tool** | `t2c connect env` | Prints env vars to export manually |

## Configuration

Config is stored at `~/.t2c/config.json`.

| Field | Default | Description |
|-------|---------|-------------|
| `gate` | `https://gate.token2chat.com` | Gate URL |
| `mint` | `https://mint.token2chat.com` | Mint URL |
| `proxy.port` | `10402` | Local proxy port |
| `proxy.secret` | (auto-generated) | Bearer token for proxy auth |
| `wallet` | `~/.t2c/wallet.json` | Wallet file path |

### Gate Discovery

t2c automatically discovers available gates from [token2.cash/gates.json](https://token2.cash/gates.json). If your primary gate is down, it fails over to other healthy gates that support your model.

## Security

- **Local proxy auth** — Bearer token with timing-safe comparison
- **Wallet file** — 0o600 permissions, only readable by owner
- **Config directory** — 0o700 permissions
- **Mutex-protected wallet** — no concurrent double-spend from overlapping requests
- **Failed token persistence** — tokens that fail to process are saved for recovery
- **No tracking** — ecash is bearer money; the gate never knows who you are

## Wallet

The wallet stores Cashu ecash proofs locally at `~/.t2c/wallet.json`.

- **Unit**: USD (1 unit = $0.00001, displayed as dollars)
- **Proof selection**: largest-first greedy (minimizes number of proofs per payment)
- **Change handling**: automatically reclaimed from gate responses (header or SSE event)
- **Funding**: Lightning invoices via `t2c mint`

### Balance Display

```bash
$ t2c balance
Wallet: $4.52 (452,000 units, 23 proofs)
Mint: https://mint.token2chat.com
```

## System Service

Install t2c as a background service that starts on boot:

```bash
# macOS (launchd)
t2c service install

# Linux (systemd)
t2c service install

# Both auto-detect the platform
```

The proxy runs in the background, automatically paying for LLM requests from any connected AI tool.

## License

MIT
