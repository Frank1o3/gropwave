/**
 * ChatViewProvider — manages the sidebar webview for GropWave.
 *
 * Handles:
 *   - Rendering the chat UI with model selector and quota badges.
 *   - Sending prompts to the orchestrator and streaming responses back.
 *   - Populating models and quota status from orchestrator events.
 *   - Handling slash commands (/index, /help).
 */

import * as vscode from "vscode";
import { OrchestratorCore } from "../orchestrator";
import { ContextEngine } from "../context-engine/ContextEngine";

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "gropwave.chatView";

	private view?: vscode.WebviewView;
	private isProcessing = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly orchestrator: OrchestratorCore,
		private readonly contextEngine: ContextEngine,
	) {
		// Listen for orchestrator events and push to webview
		this.orchestrator.onModelsChange((models) => {
			this.postMessage({
				type: "models",
				models: models.filter((m) => !m.disabled),
			});
		});

		this.orchestrator.onQuotaChange((statuses) => {
			this.postMessage({ type: "quotaStatus", statuses: Array.from(statuses.entries()) });
		});
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void | Thenable<void> {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		webviewView.webview.html = this.getHtml();

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case "prompt":
					await this.handlePrompt(message.content);
					break;
				case "selectModel":
					this.orchestrator.setSelectedModel(message.modelId);
					break;
				case "command":
					await this.handleCommand(message.command);
					break;
			}
		});

		// Send initial model list and quota status
		const models = this.orchestrator.getModels().filter((m) => !m.disabled);
		if (models.length > 0) {
			this.postMessage({ type: "models", models });
			this.postMessage({ type: "quotaStatus", statuses: Array.from(this.orchestrator.getQuotaStatuses().entries()) });
		}

		// Restore persisted conversation history to the UI
		const history = this.orchestrator.getHistory();
		if (history.length > 0) {
			// Signal to webview that history is being restored
			this.postMessage({ type: "history", messages: history });
		}
	}

	/** Post a message to the webview. */
	private postMessage(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	// ─── Prompt handling ──────────────────────────────────────────────────────

	private async handlePrompt(content: string): Promise<void> {
		if (this.isProcessing) {
			this.postMessage({ type: "error", error: "Already processing a request. Please wait." });
			return;
		}

		// Show user message immediately
		this.postMessage({
			type: "response",
			message: { role: "user", content, timestamp: Date.now() },
		});

		this.isProcessing = true;

		// Create a placeholder assistant message for streaming
		this.postMessage({
			type: "streamChunk",
			content: "",
			streamId: Date.now(),
		});

		try {
			let fullResponse = "";
			fullResponse = await this.orchestrator.dispatch(content, (chunk: string) => {
				fullResponse += chunk;
				this.postMessage({
					type: "streamChunk",
					content: chunk,
				});
			});

			// Signal stream done
			this.postMessage({
				type: "streamDone",
				message: {
					role: "assistant",
					content: fullResponse,
					timestamp: Date.now(),
					modelId: this.orchestrator.getLastUsedModel(),
				},
			});
		} catch (err: unknown) {
			this.postMessage({ type: "error", error: String(err) });
		} finally {
			this.isProcessing = false;
		}
	}

	// ─── Command handling ─────────────────────────────────────────────────────

	private async handleCommand(command: string): Promise<void> {
		const parts = command.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/index":
				this.postMessage({
					type: "response",
					message: { role: "assistant", content: "Starting workspace index...", timestamp: Date.now() },
				});
				try {
					await this.contextEngine.indexWorkspace();
					this.postMessage({
						type: "response",
						message: { role: "assistant", content: "Workspace indexed. `context.md` updated.", timestamp: Date.now() },
					});
				} catch (err: unknown) {
					this.postMessage({ type: "error", error: `Indexing failed: ${String(err)}` });
				}
				break;

			case "/help":
				this.postMessage({
					type: "response",
					message: {
						role: "assistant",
						content: [
							"**Available commands:**",
							"- `/index` — Scan workspace and generate `context.md`",
							"- `/clear` — Clear conversation history",
							"- `/help` — Show this help message",
							"",
							"**Tips:**",
							"- Select a specific model from the dropdown, or use **Auto** for smart routing.",
							"- The quota badge shows the health of your selected model.",
						].join("\n"),
						timestamp: Date.now(),
					},
				});
				break;

			case "/clear":
				this.orchestrator.clearHistory();
				// Clear the chat area in the webview
				this.postMessage({
					type: "response",
					message: { role: "assistant", content: "Conversation cleared.", timestamp: Date.now() },
				});
				break;

			default:
				this.postMessage({ type: "error", error: `Unknown command: ${cmd}` });
				break;
		}
	}

	// ─── HTML template ────────────────────────────────────────────────────────

	private getHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
	<title>GropWave</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; }
		body {
			padding: 0; margin: 0;
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
		}
		.container {
			display: flex; flex-direction: column; height: 100vh;
		}

		/* Model selector bar */
		.model-bar {
			display: flex; align-items: center; gap: 8px;
			padding: 8px 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			font-size: 12px;
		}
		.model-bar select {
			flex: 1;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			padding: 4px 8px; border-radius: 4px;
		}
		.quota-badge {
			font-size: 10px; padding: 2px 6px; border-radius: 8px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		.quota-badge.warning {
			background: var(--vscode-editorWarning-background);
			color: var(--vscode-editorWarning-foreground);
		}
		.quota-badge.exhausted {
			background: var(--vscode-inputValidation-errorBackground);
			color: var(--vscode-inputValidation-errorForeground);
		}

		/* Chat area */
		.chat-area {
			flex: 1; overflow-y: auto; padding: 12px;
		}
		.message {
			margin-bottom: 8px; padding: 8px 10px;
			border-radius: 6px; font-size: 13px; line-height: 1.5;
			white-space: pre-wrap; word-break: break-word;
		}
		.message.user {
			background: var(--vscode-input-background);
		}
		.message.assistant {
			background: var(--vscode-editor-inactiveSelectionBackground);
		}
		.message .label {
			font-weight: 600; margin-bottom: 4px; font-size: 11px;
			opacity: 0.7;
		}
		.message .model-tag {
			font-size: 10px; opacity: 0.5; margin-top: 4px;
		}
		.placeholder {
			display: flex; align-items: center; justify-content: center;
			height: 100%; opacity: 0.5; font-size: 13px; text-align: center;
			padding: 20px;
		}

		/* Input area */
		.input-area {
			display: flex; gap: 8px; padding: 8px 12px;
			border-top: 1px solid var(--vscode-panel-border);
		}
		.input-area textarea {
			flex: 1;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px; padding: 8px;
			resize: none; font-family: var(--vscode-font-family);
			font-size: 13px; min-height: 40px; max-height: 120px;
		}
		.input-area textarea:focus {
			outline: 1px solid var(--vscode-focusBorder);
		}
		.input-area button {
			align-self: flex-end;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none; padding: 8px 16px; border-radius: 4px;
			cursor: pointer; font-size: 13px;
		}
		.input-area button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.input-area button:disabled {
			opacity: 0.5; cursor: not-allowed;
		}

		/* Markdown-like rendering */
		.message code {
			background: var(--vscode-textCodeBlock-background);
			padding: 1px 4px; border-radius: 3px;
			font-family: var(--vscode-editor-font-family);
			font-size: 12px;
		}
		.message pre code {
			display: block; padding: 8px; overflow-x: auto;
		}
		.message strong { font-weight: 600; }
	</style>
</head>
<body>
	<div class="container">
		<div class="model-bar">
			<select id="modelSelect" title="Select model">
				<option value="auto">Auto (Smart Routing)</option>
			</select>
			<span id="quotaStatus" class="quota-badge">—</span>
		</div>
		<div class="chat-area" id="chatArea">
			<div class="placeholder">GropWave AI Assistant<br/><br/>Type a message or use <code>/index</code>, <code>/help</code></div>
		</div>
		<div class="input-area">
			<textarea id="chatInput" placeholder="Ask anything..." rows="1"></textarea>
			<button id="sendBtn">Send</button>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		const sendBtn = document.getElementById("sendBtn");
		const chatInput = document.getElementById("chatInput");
		const chatArea = document.getElementById("chatArea");

		let currentAssistantDiv = null;
		let isProcessing = false;

		sendBtn.addEventListener("click", sendPrompt);
		chatInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				sendPrompt();
			}
		});

		function sendPrompt() {
			const value = chatInput.value.trim();
			if (!value || isProcessing) return;

			if (value.startsWith("/")) {
				vscode.postMessage({ type: "command", command: value });
			} else {
				vscode.postMessage({ type: "prompt", content: value });
			}
			chatInput.value = "";
		}

		document.getElementById("modelSelect").addEventListener("change", (e) => {
			vscode.postMessage({ type: "selectModel", modelId: e.target.value });
		});

		window.addEventListener("message", (event) => {
			const msg = event.data;
			switch (msg.type) {
				case "models":
					populateModels(msg.models);
					break;
				case "quotaStatus":
					updateQuotaStatus(msg.statuses);
					break;
				case "history":
					restoreHistory(msg.messages);
					break;
				case "response":
					addMessage(msg.message);
					break;
				case "streamChunk":
					appendStreamChunk(msg.content);
					break;
				case "streamDone":
					finalizeStream(msg.message);
					break;
				case "error":
					addMessage({ role: "assistant", content: "⚠ Error: " + msg.error, timestamp: Date.now() });
					setProcessing(false);
					break;
			}
		});

		function populateModels(models) {
			const select = document.getElementById("modelSelect");
			select.innerHTML = '<option value="auto">Auto (Smart Routing)</option>';
			const tiers = { fast: [], balanced: [], heavy: [] };
			models.filter(m => !m.disabled).forEach(m => {
				if (tiers[m.tier]) tiers[m.tier].push(m);
			});
			for (const [tier, list] of Object.entries(tiers)) {
				if (list.length === 0) continue;
				const group = document.createElement("optgroup");
				group.label = tier.charAt(0).toUpperCase() + tier.slice(1);
				list.forEach(m => {
					const opt = document.createElement("option");
					opt.value = m.id;
					opt.textContent = m.id;
					group.appendChild(opt);
				});
				select.appendChild(group);
			}
		}

		function updateQuotaStatus(statuses) {
			const el = document.getElementById("quotaStatus");
			const selected = document.getElementById("modelSelect").value;

			if (selected === "auto") {
				el.textContent = "Auto";
				el.className = "quota-badge";
				return;
			}

			// statuses is an array of [modelId, status] entries
			let status = null;
			for (const [id, s] of statuses) {
				if (id === selected) { status = s; break; }
			}
			if (!status) {
				el.textContent = "—";
				el.className = "quota-badge";
				return;
			}
			if (status.health === "exhausted") {
				el.textContent = "Quota Exceeded";
				el.className = "quota-badge exhausted";
			} else if (status.health === "warning") {
				el.textContent = status.mostConstrained.key.toUpperCase() + " near limit";
				el.className = "quota-badge warning";
			} else {
				el.textContent = "Healthy";
				el.className = "quota-badge";
			}
		}

		function addMessage(msg) {
			removePlaceholder();
			const div = document.createElement("div");
			div.className = "message " + msg.role;
			const label = msg.role === "user" ? "You" : "AI";
			let html = '<div class="label">' + label + '</div>';
			html += '<div class="content">' + renderMarkdown(msg.content) + '</div>';
			if (msg.modelId) {
				html += '<div class="model-tag">via ' + msg.modelId + '</div>';
			}
			div.innerHTML = html;
			chatArea.appendChild(div);
			scrollToBottom();
		}

		function restoreHistory(messages) {
			removePlaceholder();
			for (const msg of messages) {
				const div = document.createElement("div");
				div.className = "message " + msg.role;
				const label = msg.role === "user" ? "You" : "AI";
				div.innerHTML = '<div class="label">' + label + '</div>' +
					'<div class="content">' + renderMarkdown(msg.content) + '</div>';
				chatArea.appendChild(div);
			}
			scrollToBottom();
		}

		function appendStreamChunk(chunk) {
			if (!currentAssistantDiv) {
				removePlaceholder();
				currentAssistantDiv = document.createElement("div");
				currentAssistantDiv.className = "message assistant";
				currentAssistantDiv.innerHTML =
					'<div class="label">AI</div><div class="content"></div>';
				chatArea.appendChild(currentAssistantDiv);
			}
			const contentEl = currentAssistantDiv.querySelector(".content");
			contentEl.textContent += chunk;
			scrollToBottom();
		}

		function finalizeStream(msg) {
			if (currentAssistantDiv) {
				const contentEl = currentAssistantDiv.querySelector(".content");
				contentEl.innerHTML = renderMarkdown(msg.content);
				if (msg.modelId) {
					const tag = document.createElement("div");
					tag.className = "model-tag";
					tag.textContent = "via " + msg.modelId;
					currentAssistantDiv.appendChild(tag);
				}
				currentAssistantDiv = null;
			}
			setProcessing(false);
		}

		function setProcessing(processing) {
			isProcessing = processing;
			sendBtn.disabled = processing;
			chatInput.disabled = processing;
		}

		function removePlaceholder() {
			const ph = chatArea.querySelector(".placeholder");
			if (ph) ph.remove();
		}

		function scrollToBottom() {
			chatArea.scrollTop = chatArea.scrollHeight;
		}

		// Improved markdown renderer
		function renderMarkdown(text) {
			const BT = String.fromCharCode(96);
			// Escape HTML first
			let html = text
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");

			// Code blocks (triple backtick with optional language)
			const codeBlockRe = new RegExp(BT + BT + BT + '(\\\\w*)\\n([\\s\\S]*?)' + BT + BT + BT, 'g');
			html = html.replace(codeBlockRe, '<pre><code class="lang-$1">$2</code></pre>');

			// Inline code (single backtick)
			const inlineCodeRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
			html = html.replace(inlineCodeRe, "<code>$1</code>");

			// Images: ![alt](url)
			html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;border-radius:4px;" />');

			// Links: [text](url)
			html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

			// Headers: ### text
			html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
			html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
			html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");

			// Bold + Italic: ***text***
			html = html.replace(/\\*\\*\\*([^*]+)\\*\\*\\*/g, "<strong><em>$1</em></strong>");
			// Bold: **text**
			html = html.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
			// Italic: *text* or _text_
			html = html.replace(/(?<!\\w)\\*([^*]+)\\*(?!\\w)/g, "<em>$1</em>");
			html = html.replace(/(?<!\\w)_([^_]+)_(?!\\w)/g, "<em>$1</em>");

			// Blockquotes: > text
			html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

			// Horizontal rule: --- or ***
			html = html.replace(/^(?:---|\\*\\*\\*)$/gm, "<hr/>");

			// Unordered lists: - item or * item
			html = html.replace(/^[\\-\\*] (.+)$/gm, "<li>$1</li>");
			// Wrap consecutive <li> in <ul>
			html = html.replace(/((?:<li>.*<\/li><br\/>?)+)/g, (match) => {
				const items = match.replace(/<br\/?>/g, "");
				return "<ul>" + items + "</ul>";
			});

			// Ordered lists: 1. item
			html = html.replace(/^\\d+\\. (.+)$/gm, "<li>$1</li>");

			// Tables: | col | col |
			html = html.replace(/^\\|(.+)\\|$/gm, (line) => {
				const cells = line.slice(1, -1).split("|").map((c) => c.trim());
				if (cells.every((c) => /^[-:]+$/.test(c))) {
					return ""; // separator row
				}
				return "<tr>" + cells.map((c) => "<td>" + c + "</td>").join("") + "</tr>";
			});
			// Wrap consecutive <tr> in <table>
			html = html.replace(/((?:<tr>.*<\/tr><br\/>?)+)/g, (match) => {
				const rows = match.replace(/<br\/?>/g, "");
				return "<table>" + rows + "</table>";
			});

			// Line breaks (but not after block elements)
			html = html.replace(/\\n/g, "<br/>");

			// Clean up extra <br/> after block elements
			html = html.replace(/(<\/(?:h[2-4]|ul|ol|pre|blockquote|table|hr)>)<br\/?>/g, "$1");

			return html;
		}
	</script>
</body>
</html>`;
	}
}
