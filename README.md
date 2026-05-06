# pi-commandcode-provider

A [pi](https://pi.dev) extension that adds **[Command Code](https://commandcode.ai)** as a model provider. Route LLM requests through Command Code's API with full streaming support, usage tracking, and cost calculation.

## Features

- 🔄 Full streaming support via Command Code's `/alpha/generate` NDJSON API
- 💰 Accurate per-token cost tracking and usage statistics
- 🔑 Auto-discovers API key from `~/.commandcode/auth.json` or env var
- 🧠 17 models: 11 open-source + 6 premium (Claude, GPT)
- 🛠 Tool call support for agentic coding workflows

## Supported Models

### Open Source (Go plan $1/mo and above)

| Model | Context | Price In/Out/Cache ($/M tokens) |
|---|---|---|
| `deepseek/deepseek-v4-flash` | 1M | $0.14 / $0.28 / $0.01 |
| `deepseek/deepseek-v4-pro` ⚡ | 1M | $0.435 / $0.87 / $0.004 |
| `stepfun/Step-3.5-Flash` | 1M | $0.10 / $0.30 / $0.02 |
| `MiniMaxAI/MiniMax-M2.5` | 205K | $0.27 / $0.95 / $0.03 |
| `MiniMaxAI/MiniMax-M2.7` | 205K | $0.30 / $1.20 / $0.06 |
| `Qwen/Qwen3.6-Plus` | 262K | $0.50 / $3.00 / $0.10 |
| `moonshotai/Kimi-K2.5` | 262K | $0.60 / $3.00 / $0.10 |
| `moonshotai/Kimi-K2.6` | 262K | $0.95 / $4.00 / $0.16 |
| `Qwen/Qwen3.6-Max-Preview` | 262K | $1.30 / $7.80 / $0.26 |
| `zai-org/GLM-5` | 205K | $1.00 / $3.20 / $0.20 |
| `zai-org/GLM-5.1` | 205K | $1.40 / $4.40 / $0.26 |

### Premium (Pro plan $15/mo and above)

| Model | Context | Price In/Out/Cache ($/M tokens) |
|---|---|---|
| `claude-sonnet-4-6` | 200K | $3.00 / $15.00 / $0.30 |
| `claude-opus-4-7` | 200K | $5.00 / $25.00 / $0.50 |
| `claude-haiku-4-5-20251001` | 200K | $1.00 / $5.00 / $0.10 |
| `gpt-5.5` | 400K | $5.00 / $30.00 / $0.50 |
| `gpt-5.4` | 400K | $2.50 / $15.00 / $0.25 |
| `gpt-5.4-mini` | 400K | $0.75 / $4.50 / $0.075 |

> ⚡ DeepSeek V4 Pro has a 75% off deal through May 31, 2026

## Install

### From git (recommended)

```bash
pi install git:github.com/IrvanFza/pi-commandcode-provider
```

### From local path

```bash
git clone https://github.com/IrvanFza/pi-commandcode-provider.git
pi install /path/to/pi-commandcode-provider
```

### Quick test without installing

```bash
pi -e /path/to/pi-commandcode-provider
```

## Getting Your API Key

### Step 1: Create a Command Code account

Sign up at [commandcode.ai](https://commandcode.ai). The **Go** plan is $1/mo and includes $10 in credits — enough for thousands of requests on the cheapest models.

### Step 2: Generate an API key

Choose **one** of these methods:

**Option A — CLI login (easiest):**
```bash
npm i -g command-code@latest
cmd login
```
This opens a browser to authenticate and stores the key in `~/.commandcode/auth.json`. The extension auto-detects this file — no further configuration needed.

**Option B — Studio UI:**
1. Go to [commandcode.ai/studio/api-keys](https://commandcode.ai/studio/api-keys)
2. Click **Generate API key**
3. Copy the key (starts with `user_`)

### Step 3: Make the key available to pi

The extension looks for the API key in this order:

1. **`COMMANDCODE_API_KEY` environment variable**
2. **`~/.commandcode/auth.json`** (auto-created by `cmd login`)

If you used `cmd login` above, you're done — skip to [Usage](#usage).

Otherwise, set the environment variable in your shell profile:

```bash
# Add to ~/.zshrc (macOS default) or ~/.bashrc (Linux)
echo 'export COMMANDCODE_API_KEY="user_paste_your_key_here"' >> ~/.zshrc
source ~/.zshrc
```

Verify it's set:
```bash
echo $COMMANDCODE_API_KEY
# Should print: user_...
```

### (Optional) Verify your key works

```bash
# Quick auth check
curl -s https://api.commandcode.ai/alpha/whoami \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY"

# Should return your user info:
# {"success":true,"user":{"name":"Your Name","userName":"yourname",...}}
```

## Usage

### Non-interactive

```bash
pi --model commandcode/deepseek/deepseek-v4-flash -p "Explain async/await in JavaScript"
```

### Interactive

```bash
pi --model commandcode/moonshotai/Kimi-K2.5
```

### Switch models in-session

```
/model commandcode/zai-org/GLM-5.1
```

### List available models

```bash
pi --list-models commandcode
```

### Use in another project

```bash
cd my-project
pi --model commandcode/deepseek/deepseek-v4-flash --trust "Refactor the auth module"
```

## How It Works

This extension implements a custom `streamSimple` provider that:

1. Converts pi's message format to Command Code's `/alpha/generate` request schema
2. Sends requests with proper authentication headers (`Authorization: Bearer`)
3. Parses Command Code's NDJSON streaming format (`text-start`, `text-delta`, `text-end`, etc.)
4. Maps finish reasons and usage statistics back to pi's internal format
5. Calculates per-token costs based on model pricing

The Command Code API routes requests through Vercel AI Gateway to providers like DeepSeek, Moonshot, Baseten, Bedrock, and Fireworks — so you get reliable multi-provider routing with zero data retention.

## Requirements

- [pi](https://pi.dev) coding agent
- A Command Code account with an active plan (Go $1/mo or higher)

## Author

**Irvan Fauziansyah** — [GitHub](https://github.com/IrvanFza)

## License

[MIT](LICENSE)
