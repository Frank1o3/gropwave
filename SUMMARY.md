# GropWave — Project Summary & Context

> Agentic VS Code Extension for AI-assisted coding with smart model orchestration, quota management, and physical context files.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        VS Code Sidebar                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │ Model Picker│  │ Quota Badge  │  │ Chat Input + /commands │   │
│  │ (optgroup)  │  │ (🟢🟡🔴)     │  │                        │   │
│  └─────────────┘  └──────────────┘  └────────────────────────┘   │
└────────────────────────┬─────────────────────────────────────────┘
                         │ webview.postMessage / onDidReceiveMessage
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                     ChatViewProvider                              │
│  • Streams prompts → orchestrator.dispatch()                      │
│  • Receives streamChunk → appends to DOM in real-time             │
│  • Handles /index, /clear, /help slash commands                   │
│  • Restores conversation history on sidebar reopen                │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                      OrchestratorCore                             │
│                                                                   │
│  dispatch(prompt, onChunk):                                       │
│    1. TaskRouter.classify() → tier (fast/balanced/heavy)          │
│    2. buildMessagesWithHistory():                                 │
│       • Tool preamble (always injected)                           │
│       • system.md relevant sections (keyword-matched)             │
│       • context.md workspace summary                              │
│       • Conversation history (up to 20 turns, persisted)          │
│       • Current user prompt                                       │
│    3. selectModel(): smart routing or explicit model              │
│       • Tier-based fallback chain                                 │
│       • Quota health check (RPM/RPD/TPM/TPD)                      │
│       • Healthiest candidate wins                                 │
│    4. groqClient.streamComplete() → onChunk fires each delta      │
│    5. parseToolCalls() → if found, execute and follow-up          │
│    6. Append to history → save to globalState                     │
│    7. QuotaTracker.record() → emit quota status                   │
│                                                                   │
│  Components:                                                      │
│    ├── QuotaTracker — sliding-window counters (timestamped)       │
│    ├── ModelRegistry — SDK fetch, tier assignment, enable/disable │
│    ├── TaskRouter — heuristic classifier (keywords + length)      │
│    └── GroqClient — chat completions (blocking + streaming)       │
└────────────────────────┬─────────────────────────────────────────┘
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Context    │  │  System     │  │  Agent      │
│  Engine     │  │  Prompt     │  │  Tools      │
│             │  │  Engine     │  │             │
│ • LLM-powered│  │ • Section   │  │ • runCommand│
│   indexing   │  │   parsing   │  │   (sync)    │
│ • Diff-based │  │ • Keyword   │  │ • editFile  │
│   updates    │  │   matching  │  │   (WS Edit) │
│ • Debounced  │  │ • Auto-gen  │  │ • parseTool │
│   file watcher│ │   defaults  │  │   Calls     │
└─────────────┘  └─────────────┘  └─────────────┘
```

---

## File Inventory

| File | Purpose |
|---|---|
| `src/extension.ts` | Activation: config, orchestrator, engines, file watchers, commands, status bar |
| `src/orchestrator/types.ts` | All core types: TaskTier, ModelLimits, QuotaHealth, RegisteredModel, etc. |
| `src/orchestrator/QuotaTracker.ts` | Sliding-window quota tracker (RPM/RPD/TPM/TPD per model) |
| `src/orchestrator/ModelRegistry.ts` | SDK model fetch, tier assignment, DEFAULT_MODEL_LIMITS map |
| `src/orchestrator/TaskRouter.ts` | Heuristic prompt classifier (keyword + length + code detection) |
| `src/orchestrator/GroqClient.ts` | Groq SDK wrapper: complete() + streamComplete() |
| `src/orchestrator/OrchestratorCore.ts` | **The brain**: routing, model selection, dispatch, tool execution, history |
| `src/orchestrator/index.ts` | Barrel exports |
| `src/webview/ChatViewProvider.ts` | Sidebar webview: chat UI, model selector, quota badge, streaming, markdown |
| `src/context-engine/ContextEngine.ts` | LLM-powered context.md generation, debounced diff-based updates |
| `src/context-engine/SystemPromptEngine.ts` | system.md section parsing, keyword-based selective feeding, auto-defaults |
| `src/tools/AgentTools.ts` | Terminal execution (child_process.exec), WorkspaceEdit file editing, tool-call parser, command safety |
| `src/status/StatusBar.ts` | VS Code status bar: model name, quota health icon, click-to-chat |

---

## Implemented Features

### 1. Webview Sidebar
- **Model selector** with `<optgroup>` by tier (Fast / Balanced / Heavy)
- **Quota badge** showing Healthy / Warning / Exhausted with VS Code theme colors
- **Streaming chat** — tokens appear in real-time as the LLM generates them
- **Markdown rendering** — headers, bold, italic, code blocks, inline code, links, images, blockquotes, lists, tables, horizontal rules
- **Slash commands** — `/index`, `/clear`, `/help`
- **Conversation history restoration** — messages replayed from globalState when sidebar reopens

### 2. Smart Orchestration & Quota Management
- **Three-tier model routing**: Fast (8B, mini → 500k TPD), Balanced (13B-34B), Heavy (70B+ → 100k TPD)
- **Heuristic classification**: keyword patterns, prompt length, code block detection, terminal output detection
- **Fallback chains**: Heavy → Balanced → Fast (and permutations based on preferred tier)
- **Sliding-window quota tracking**: timestamped entries that auto-expire (not simple counters)
- **Quota health states**: Healthy (<90%), Warning (90-99%), Exhausted (≥100%)
- **Manual model override**: user can pin a specific model; smart routing as fallback
- **DEFAULT_MODEL_LIMITS map**: per-model RPM/RPD/TPM/TPD defaults for known Groq models

### 3. Context Engine (`context.md`)
- **LLM-powered indexing**: llama-3.1-8b-instant summarizes each file's purpose, key elements, dependencies
- **JSON-structured summaries**: `{purpose, keyElements, dependencies}` per file
- **Batched parallel processing**: 5 files at a time with progress reporting
- **Fallback extraction**: regex-based top-level names and imports when LLM fails
- **Diff-based updates**: `updateFile()` regenerates only the changed file's section
- **Debounced file watcher**: 2-second debounce, tracks active vs pending updates, re-schedules on collision
- **Markdown output**: file structure overview + detailed per-file sections

### 4. Dynamic System Prompts (`system.md`)
- **Section parsing**: `##` headers define independent sections
- **Keyword extraction**: stopword-filtered, length-sorted keywords per section
- **Selective feeding**: scores sections by keyword overlap with user prompt + context
- **General section always included**: "Rules", "Guidelines", "Standards" headings are prioritized
- **Auto-generated defaults**: 4 sections (General Rules, Code Style, Testing Standards, Terminal Usage)
- **Auto-reload on file change**: FileSystemWatcher triggers `reload()`

### 5. Agentic Capabilities & Tool Use
- **Tool-call syntax**: `<tool:run_command>cmd</tool:run_command>` and `<tool:edit_file path="...">content</tool:edit_file>`
- **Tool preamble injection**: always prepended to system message so LLM knows about tools
- **Auto-execution loop**: tool calls detected → executed → results fed back → LLM summarizes
- **Command safety**: denylist blocks `rm -rf`, `dd`, `mkfs`, destructive `sudo` commands
- **WorkspaceEdit file editing**: goes through VS Code's undo/redo stack, triggers language server events

### 6. Status Bar
- Shows: `✓ GropWave: llama-3.1-8b` (or ⚠/✗ for warnings/exhaustion)
- "Loading…" during initialization
- Click focuses the chat view
- Listens to orchestrator events for real-time updates

### 7. Persistence
- **Conversation history**: saved to `ExtensionContext.globalState` after every turn
- **Restored on initialize**: history loaded from globalState during startup
- **Restored in UI**: ChatViewProvider replays history messages into webview DOM on resolve

---

## Key Design Decisions

### Quota Tracking: Sliding Window vs Simple Counters
Each request logs a `{timestamp, tokens}` entry. On each check, entries outside the window are pruned. This gives accurate RPM/TPM (60s) and RPD/TPD (24h) counts without over-counting.

### Heuristic Routing (No LLM Call)
TaskRouter uses keyword matching and token estimation — no API call needed for routing decisions. This keeps routing fast and free.

### Tool Calls: XML Tags vs Function Calling
Uses `<tool:...>` XML tags instead of Groq's function calling. Pros: works with any model, no schema registration, easily parsable. Cons: relies on LLM following instructions.

### System Prompt: Selective Feeding
Instead of sending entire system.md, only relevant sections are extracted via keyword overlap scoring. Saves tokens, especially for large system.md files.

### Context Updates: Debounced Per-File
File watcher fires on every save. 2-second debounce coalesces rapid saves. `activeUpdates` set prevents concurrent LLM calls for the same file. If a file changes during processing, it's re-scheduled.

### Default Model Limits
`DEFAULT_MODEL_LIMITS` in ModelRegistry maps known model IDs to their rate limits. Falls back to conservative defaults for unknown models. Adjustable via `setLimits()` at runtime.

---

## Configuration (package.json)

| Setting | Type | Default | Description |
|---|---|---|---|
| `gropwave.apiKey` | string (password) | `""` | API key (falls back to GROQ_API_KEY env var) |
| `gropwave.baseUrl` | string | `""` | Custom API endpoint URL |
| `gropwave.defaultModel` | string | `"auto"` | Specific model ID or `"auto"` for smart routing |
| `gropwave.quotaWarningThreshold` | number (0.5-1.0) | `0.9` | Quota ratio at which to show warning |
| `gropwave.contextFile` | string | `"context.md"` | Workspace context filename |
| `gropwave.systemFile` | string | `"system.md"` | System instructions filename |

---

## Commands

| Command | Title | Description |
|---|---|---|
| `gropwave.focusChat` | Focus GropWave Chat | Opens the sidebar |
| `gropwave.indexWorkspace` | Index Workspace | Scans workspace, generates context.md |
| `gropwave.refreshModels` | Refresh Available Models | Re-fetches model list from API |

---

## Build Status

- **TypeScript**: ✅ Zero errors
- **ESLint**: ✅ Zero warnings
- **esbuild**: ✅ Compiles cleanly
- Build command: `npm run compile`

---

## Remaining TODOs (from TODO.md)

| # | Item | Priority | Notes |
|---|---|---|---|
| 16 | Provider abstraction layer | Low | Groq SDK already supports custom base URLs; future work for multi-provider |
| 17 | README rewrite | Low | Replace VS Code default template with real docs |
| 18 | Unit tests | Low | Add tests for TaskRouter, QuotaTracker, ModelRegistry, tool-call parsing, SystemPromptEngine |

---

## How to Continue

1. **Read this file** to understand the full architecture and what's been built.
2. **Read `TODO.md`** for the remaining items (3 items, all documentation/quality).
3. **Key files to know:**
   - `src/orchestrator/OrchestratorCore.ts` — the central dispatcher; modify here for routing/model selection changes.
   - `src/webview/ChatViewProvider.ts` — the UI; both TypeScript and inline HTML/JS.
   - `src/context-engine/ContextEngine.ts` — context.md generation; LLMProvider interface is here.
   - `src/tools/AgentTools.ts` — tool execution and safety; add new tool types here.
   - `src/status/StatusBar.ts` — self-contained status bar; listen to orchestrator events.
4. **Build command**: `npm run compile` — should always pass with zero errors and zero warnings.
5. **Lint fix**: `npx eslint src --fix` — auto-fixes curly brace and style issues.

---

## Model Tier Reference

| Tier | Models | Daily Limit Priority | Use Cases |
|---|---|---|---|
| **Fast** | 8B, 9B, 11B, mini | High (500k+ TPD) | Indexing, summarization, simple Q&A |
| **Balanced** | 13B-34B, 70B versatile | Medium (200k TPD) | Refactoring, explanations, medium complexity |
| **Heavy** | 70B, 405B, pro, reasoning | Low (100k TPD) | Complex logic, debugging, code generation |

---

## Tool Call Protocol

The LLM can invoke tools by emitting XML-style tags in its response:

```
<tool:run_command>npm test</tool:run_command>
<tool:edit_file path="src/foo.ts">export const x = 1;</tool:edit_file>
```

These are parsed by `parseToolCalls()`, executed by `executeToolCalls()`, and results are fed back as a follow-up user message. Dangerous commands are blocked automatically.
