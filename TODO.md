# GropWave — Implementation TODO

*Prioritized by severity. Bugs and missing wiring first, then features.*

## ~~🔴 Critical Bugs~~

~~### 1. `base_url` vs `baseUrl` config key mismatch~~ ✅ Fixed
~~### 2. `defaultModel` config read but never applied at startup~~ ✅ Fixed
~~### 3. No guard against `dispatch()` before `initialize()` completes~~ ✅ Fixed

## ~~🟠 Missing Wiring~~

~~### 4. Diff-based context updates not wired (no file watchers)~~ ✅ Fixed
~~### 5. `system.md` auto-reload not wired~~ ✅ Fixed
~~### 6. Tool availability not programmatically injected into system prompt~~ ✅ Fixed
~~### 7. Initial quota status not sent to webview on load~~ ✅ Fixed

## 🟡 Features & Improvements

~~### 8. `runTerminalCommand` is broken/dead code~~ ✅ Removed
~~### 14. `editFileRange` exported but never wired~~ ✅ Removed

### 9. ~~Conversation history not persisted across restarts~~ ✅ Fixed
- Uses `ExtensionContext.globalState` to save/restore recent turns.
- History restored in UI when sidebar reopens.

### 10. ~~Webview chat state not persisted~~ ✅ Fixed
- Orchestrator persists history in globalState; ChatViewProvider replays it on resolve.

### 11. ~~No debouncing on `ContextEngine.updateFile()`~~ ✅ Fixed
- 2-second debounce window; coalesces rapid saves; tracks active vs pending updates.

### 12. ~~No persistent status bar indicator~~ ✅ Fixed
- New `src/status/StatusBar.ts` — shows model name, quota health icon, initialization state.
- Clicking focuses the chat view.

### 13. ~~Webview markdown renderer is minimal~~ ✅ Fixed
- Now handles: headers, bold, italic, code blocks, inline code, links, images, blockquotes, unordered lists, ordered lists, horizontal rules, tables.

### 15. ~~No command safety enforcement~~ ✅ Fixed
- `isDangerousCommand()` blocks `rm -rf`, `dd`, `mkfs`, destructive `sudo` commands.
- Blocked commands return an error message to the LLM instead of executing.

### 16. Provider locked to Groq SDK
- **Files:** `GroqClient.ts`
- `baseUrl` config implies OpenAI-compatible endpoint support.
- Groq SDK already supports custom base URLs. Good enough for now.
- Future: abstract behind a provider interface for multi-provider support.

## 🔵 Documentation & Quality

### 17. README is placeholder
- **File:** `README.md`
- Replace default VS Code template with feature docs, setup instructions, screenshots.

### 18. Tests are trivial
- **File:** `src/test/extension.test.ts`
- Add unit tests for: TaskRouter, QuotaTracker, ModelRegistry, tool-call parsing, SystemPromptEngine extraction, ContextEngine markdown generation.

### 19. ~~Activity bar icon uses generic codicon~~ ✅ Fixed
- Changed from `$(comment)` to `$(comment-discussion)`.
