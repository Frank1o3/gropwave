/**
 * ChatViewProvider — serves the sidebar chat webview from `media/chat.html`.
 *
 * Responsibilities:
 *   - Load the webview HTML from the media directory.
 *   - Wire up message passing between the webview and the extension.
 *   - Stream prompts → orchestrator.dispatch() → chunks back to the webview.
 *   - Handle slash commands (/index, /clear, /help).
 *   - Send initial models, quota status, and conversation history on load.
 *   - Log activity to the GropWave output channel.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { OrchestratorCore } from "../orchestrator";
import { ContextEngine } from "../context-engine/ContextEngine";
import { ActiveFileTracker } from "../active-context/ActiveFileTracker";

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "gropwave.chatView";

	private view?: vscode.WebviewView;
	private isProcessing = false;
	private outputChannel: vscode.OutputChannel;
	private activeFileTracker: ActiveFileTracker;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly orchestrator: OrchestratorCore,
		private readonly contextEngine: ContextEngine,
		outputChannel: vscode.OutputChannel,
		activeFileTracker: ActiveFileTracker,
	) {
		this.outputChannel = outputChannel;
		this.activeFileTracker = activeFileTracker;

		// Listen for active context changes and push to webview
		this.activeFileTracker.onDidChange(() => {
			const display = this.activeFileTracker.getCompactDisplay();
			this.postMessage({ type: "activeContext", display: display ?? "" });
		});

		this.orchestrator.onModelsChange((models) => {
			const enabled = models.filter((m) => !m.disabled).length;
			this.outputChannel.appendLine(`[UI] Models updated: ${enabled} enabled`);
			this.postMessage({ type: "models", models: models.filter((m) => !m.disabled) });
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

		webviewView.webview.onDidReceiveMessage(async (message) => {
			this.outputChannel.appendLine(`[UI←] ${message.type} ${JSON.stringify(message).slice(0, 120)}`);
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

		// Send initial state
		const models = this.orchestrator.getModels().filter((m) => !m.disabled);
		if (models.length > 0) {
			this.outputChannel.appendLine(`[UI→] Sending ${models.length} models + quota status`);
			this.postMessage({ type: "models", models });
			this.postMessage({ type: "quotaStatus", statuses: Array.from(this.orchestrator.getQuotaStatuses().entries()) });
		} else {
			this.outputChannel.appendLine("[UI→] No models available yet");
		}

		// Send initial active context
		const activeDisplay = this.activeFileTracker.getCompactDisplay();
		this.postMessage({ type: "activeContext", display: activeDisplay ?? "" });
	}

	private postMessage(message: unknown): void {
		this.view?.webview.postMessage(message);
	}

	// ─── Prompt handling ──────────────────────────────────────────────────────

	private async handlePrompt(content: string): Promise<void> {
		if (this.isProcessing) {
			this.postMessage({ type: "error", error: "Already processing a request. Please wait." });
			return;
		}

		this.outputChannel.appendLine(`[Dispatch] Prompt: "${content.slice(0, 80)}..."`);

		this.postMessage({
			type: "response",
			message: { role: "user", content, timestamp: Date.now() },
		});

		this.isProcessing = true;

		try {
			let fullResponse = "";
			fullResponse = await this.orchestrator.dispatch(content, (chunk: string) => {
				fullResponse += chunk;
				this.postMessage({ type: "streamChunk", content: chunk });
			});

			this.outputChannel.appendLine(
				`[Dispatch] Response (${fullResponse.length} chars) via ${this.orchestrator.getLastUsedModel()}`,
			);

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
			this.outputChannel.appendLine(`[Dispatch] Error: ${String(err)}`);
			this.postMessage({ type: "error", error: String(err) });
		} finally {
			this.isProcessing = false;
		}
	}

	// ─── Command handling ─────────────────────────────────────────────────────

	private async handleCommand(command: string): Promise<void> {
		const cmd = command.trim().split(/\s+/)[0].toLowerCase();

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
							"- `/what` — Show what file/function you're currently editing",
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

			case "/what":
			case "/workingon": {
				const extra = command.slice(cmd.length).trim();
				const ctx = this.activeFileTracker.getActiveContext();

				if (extra) {
					// User asked a question after /what — let the AI answer it.
					// Active context is already injected by OrchestratorCore.
					await this.handlePrompt(extra);
				} else if (ctx) {
					this.postMessage({
						type: "response",
						message: { role: "assistant", content: ctx, timestamp: Date.now() },
					});
				} else {
					this.postMessage({
						type: "response",
						message: { role: "assistant", content: "You're not currently editing any file. Open a file in the editor and I'll track what you're working on.", timestamp: Date.now() },
					});
				}
				break;
			}

			default:
				this.postMessage({ type: "error", error: `Unknown command: ${cmd}` });
				break;
		}
	}

	// ─── HTML loading ─────────────────────────────────────────────────────────

	private getHtml(): string {
		const mediaPath = path.join(this.extensionUri.fsPath, "media", "chat.html");
		try {
			let html = fs.readFileSync(mediaPath, "utf-8");

			// Replace relative media URIs with webview-safe URIs
			html = html.replace(
				/(src|href)="([^"]+)"/g,
				(_match, attr, file) => {
					const uri = vscode.Uri.joinPath(this.extensionUri, "media", file);
					const webviewUri = this.view?.webview.asWebviewUri(uri).toString();
					return `${attr}="${webviewUri ?? uri.toString()}"`;
				},
			);

			return html;
		} catch (err) {
			return `<p>Failed to load chat UI: ${String(err)}</p>`;
		}
	}
}
