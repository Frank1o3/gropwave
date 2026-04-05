# GropWave

> Agentic AI assistant for VS Code with smart model orchestration, physical context management, and tool use.

GropWave connects your editor to powerful LLMs (via Groq) and acts as an intelligent coding companion — routing tasks to the right model, managing workspace context in physical files, and safely executing commands and edits.

---

## Features

### 💬 Chat Sidebar

Open the GropWave sidebar from the activity bar and start chatting with the AI assistant.

- **Streaming responses** — tokens appear in real-time as the model generates them
- **Markdown rendering** — code blocks, headers, lists, links, tables, and more
- **Model selector** — choose a specific model or use **Auto** for smart routing
- **Quota badge** — shows the health of your selected model's API usage (🟢 Healthy / 🟡 Warning / 🔴 Exhausted) (currently implementing)

### 🧠 Smart Orchestration

GropWave automatically routes your prompt to the best model for the job:

| Tier | Models | Use Cases |
|---|---|---|
| **Fast** | 8B, mini models | Indexing, summarization, simple questions |
| **Balanced** | 13B–34B models | Refactoring, explanations, medium complexity |
| **Heavy** | 70B+, pro models | Complex logic, debugging, code generation |

If the preferred model is nearing its rate limit, GropWave automatically falls back to the next best option — keeping your workflow uninterrupted.

### 📄 Physical Context Files

GropWave uses real files in your workspace to manage knowledge:

- **`system.md`** — Your coding standards, style guides, and behavioral instructions for the AI. Auto-generated with sensible defaults if it doesn't exist.
- **`context.md`** — An AI-generated summary of your codebase's purpose, file structure, key functions, and dependencies. Updated as you work.

These files are physically in your workspace — you can read them, edit them, and commit them. The AI reads only the relevant sections for each task, saving tokens.

### 📍 Active File Tracking

As you edit files, GropWave tracks your cursor position, enclosing class, and function. A compact bar at the top of the chat view shows what you're working on:

```
📝 src/model_view/main.py → calculate_soft_body() :42
```

This context is injected into every AI call, so you can ask "what does this function do?" and the AI knows exactly which function you mean.

### 🛠️ Agentic Tool Use (planned to be implemented)

The AI can execute commands and edit files on your behalf using XML-style tool tags:

```
<tool:run_command>npm test</tool:run_command>
<tool:edit_file path="src/index.ts">export const x = 1;</tool:edit_file>
```

- **Terminal execution** — runs commands via `child_process.exec`, captures stdout/stderr
- **Safe file editing** — all edits go through `vscode.WorkspaceEdit`, integrating with VS Code's undo/redo stack
- **Command safety** — dangerous commands (`rm -rf`, `dd`, `mkfs`, destructive `sudo`) are blocked automatically

### 📊 Status Bar Indicator (planned to be implemented)

The VS Code status bar shows GropWave's state at a glance: the current model name and quota health. Click it to focus the chat sidebar.

---

## Getting Started

### 1. Set your API key

Open VS Code Settings (`Ctrl+,` / `Cmd+,`), search `gropwave`, and set:

- **Gropwave: Api Key** — your Groq API key (starts with `gsk_`)

Or set the environment variable `GROQ_API_KEY` before launching VS Code.

### 2. Open the chat sidebar

Click the GropWave icon in the activity bar (left sidebar).

### 3. Start chatting

Type a message and press Enter. The AI will automatically select the best model for your task.

---

## Slash Commands

| Command | Description |
|---|---|
| `/index` | Scan your workspace and generate `context.md` with per-file summaries |
| `/help` | Show available commands and tips |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `gropwave.apiKey` | `""` | API key for Groq (or set `GROQ_API_KEY` env var) |
| `gropwave.baseUrl` | `""` | Custom API endpoint URL (optional) |
| `gropwave.defaultModel` | `"auto"` | Pin a specific model, or `"auto"` for smart routing |
| `gropwave.quotaWarningThreshold` | `0.9` | Quota ratio (0–1) at which to show a warning |
| `gropwave.contextFile` | `"context.md"` | Workspace context filename |
| `gropwave.systemFile` | `"system.md"` | System instructions filename |

---

## Architecture

```
┌──────────────────────────────────────────┐
│           VS Code Sidebar                 │
│  Model Picker │ Quota Badge │ Chat Input  │
└─────────────────┬────────────────────────┘
                  │
┌─────────────────▼────────────────────────┐
│          Orchestrator Core               │
│  Task Router → Model Selection → Dispatch│
│  (tier-based + quota-aware + fallback)   │
└──────┬──────────┬──────────┬─────────────┘
       │          │          │
┌──────▼──┐ ┌────▼───┐ ┌───▼──────┐
│ Context │ │ System │ │  Agent   │
│ Engine  │ │ Prompt │ │  Tools   │
│ .md     │ │  .md   │ │  exec    │
└─────────┘ └────────┘ └──────────┘
```

---

## Known Issues

- **Rate limits** — On the Groq free tier (6000 TPM), indexing large workspaces may hit rate limits. The indexer retries with exponential backoff, but patience is appreciated.
- **No multi-provider support yet** — Currently Groq-only. Custom `baseUrl` works with any OpenAI-compatible endpoint, but the SDK is Groq-specific.

---

## Release Notes

### 0.1.0

Initial release with:

- Webview chat sidebar with streaming responses
- Smart model orchestration (Fast / Balanced / Heavy tiers)
- Quota tracking with sliding-window counters
- `context.md` generation via LLM-powered indexing
- `system.md` with selective section feeding and auto-defaults
- Active file tracking (file, class, function, line)
- Tool execution: terminal commands and safe file edits
- Command safety (dangerous command blocking)
- Debounced diff-based context updates on file save
- Status bar indicator with quota health
- `.gitignore`-aware file scanning during indexing

---

## License

MIT
