import * as vscode from "vscode";
import { OrchestratorCore, OrchestratorConfig } from "./orchestrator";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { ContextEngine, LLMProvider } from "./context-engine/ContextEngine";
import { SystemPromptEngine } from "./context-engine/SystemPromptEngine";
import { GroqClient } from "./orchestrator/GroqClient";
import { StatusBar } from "./status/StatusBar";

let orchestrator: OrchestratorCore | undefined;
let contextEngine: ContextEngine | undefined;
let systemPromptEngine: SystemPromptEngine | undefined;
let groqClient: GroqClient | undefined;
let statusBar: StatusBar | undefined;

export function activate(extensionContext: vscode.ExtensionContext) {
	console.log("GropWave extension is now active");

	// ─── Read configuration ──────────────────────────────────────────────
	const config = vscode.workspace.getConfiguration("gropwave");
	const orchestratorConfig: OrchestratorConfig = {
		apiKey: config.get<string>("apiKey") || process.env.GROQ_API_KEY || "",
		baseUrl: config.get<string>("baseUrl") || "",
		defaultModel: config.get<string>("defaultModel") || "auto",
		quotaWarningThreshold: config.get<number>("quotaWarningThreshold") ?? 0.9,
		contextFile: config.get<string>("contextFile") || "context.md",
		systemFile: config.get<string>("systemFile") || "system.md",
	};

	if (!orchestratorConfig.apiKey) {
		vscode.window.showWarningMessage(
			"GropWave: No API key configured. Set `gropwave.apiKey` in settings or define GROQ_API_KEY.",
		);
	}

	// ─── Create GroqClient and LLMProvider adapter ───────────────────────
	groqClient = new GroqClient(orchestratorConfig);
	const llmProvider: LLMProvider = {
		async complete(systemPrompt: string, userPrompt: string): Promise<string> {
			// Use a fast model for summarization tasks
			return groqClient!.complete("llama-3.1-8b-instant", [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			], { temperature: 0.1 });
		},
	};

	// ─── Initialize context engine ───────────────────────────────────────
	// Auto-generate system.md if it doesn't exist
	SystemPromptEngine.ensureDefaultExists(orchestratorConfig).then((created) => {
		if (created) {
			vscode.window.showInformationMessage(
				"GropWave: Created a default system.md in your workspace. Edit it to customize AI behavior.",
			);
		}
	}).catch((err) => {
		console.warn("[GropWave] Failed to ensure system.md:", err);
	});

	contextEngine = new ContextEngine(extensionContext, orchestratorConfig, llmProvider);
	systemPromptEngine = new SystemPromptEngine(orchestratorConfig);

	// ─── Initialize orchestrator ─────────────────────────────────────────
	orchestrator = new OrchestratorCore(orchestratorConfig, extensionContext, {
		systemPromptEngine,
		contextEngine,
	});
	orchestrator.initialize().then(() => {
		statusBar?.setReady(true);
	}).catch((err) => {
		console.error("[GropWave] Failed to initialize orchestrator:", err);
	});

	// ─── Status bar ──────────────────────────────────────────────────────
	statusBar = new StatusBar(extensionContext, orchestrator);
	statusBar.setReady(false); // will be set true after initialize completes
	statusBar.show();

	// Apply user's default model preference
	if (orchestratorConfig.defaultModel && orchestratorConfig.defaultModel !== "auto") {
		orchestrator.setSelectedModel(orchestratorConfig.defaultModel);
	}

	// ─── Register webview view provider ──────────────────────────────────
	const chatViewProvider = new ChatViewProvider(
		extensionContext.extensionUri,
		orchestrator,
		contextEngine,
	);
	extensionContext.subscriptions.push(
		vscode.window.registerWebviewViewProvider("gropwave.chatView", chatViewProvider),
	);

	// ─── Register commands ───────────────────────────────────────────────

	const focusChat = vscode.commands.registerCommand("gropwave.focusChat", () => {
		vscode.commands.executeCommand("gropwave.chatView.focus");
	});

	const indexWorkspace = vscode.commands.registerCommand("gropwave.indexWorkspace", async () => {
		const engine = contextEngine;
		if (!engine) {return;}
		vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Indexing workspace...",
				cancellable: false,
			},
			async () => {
				try {
					await engine.indexWorkspace();
					vscode.window.showInformationMessage("Workspace indexed. context.md updated.");
				} catch (err: unknown) {
					vscode.window.showErrorMessage(`Indexing failed: ${String(err)}`);
				}
			},
		);
	});

	const refreshModels = vscode.commands.registerCommand("gropwave.refreshModels", async () => {
		if (!orchestrator) {return;}
		await orchestrator.refreshModels();
		vscode.window.showInformationMessage("Model list refreshed.");
	});

	extensionContext.subscriptions.push(focusChat, indexWorkspace, refreshModels);

	// ─── File watchers ───────────────────────────────────────────────────

	// Watch for saved source files and update context.md incrementally
	const fileWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
		const engine = contextEngine;
		if (!engine) {
			return;
		}
		// Skip context.md itself and non-file documents
		if (doc.uri.scheme !== "file") {
			return;
		}
		const contextPath = engine.getContextPath();
		if (contextPath && doc.uri.fsPath === contextPath) {
			return;
		}
		// Debounce: small delay to batch rapid saves
		setTimeout(() => {
			try {
				engine.updateFile(doc.uri.fsPath);
			} catch (err) {
				console.warn("[GropWave] Failed to update context for", doc.uri.fsPath, err);
			}
		}, 1000);
	});

	// Watch for system.md changes and reload the engine
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	let systemWatcher: vscode.FileSystemWatcher | undefined;
	if (workspaceRoot) {
		const systemPath = new vscode.RelativePattern(workspaceRoot, orchestratorConfig.systemFile);
		systemWatcher = vscode.workspace.createFileSystemWatcher(systemPath);
		systemWatcher.onDidChange(() => {
			if (systemPromptEngine) {
				systemPromptEngine.reload();
				console.log("[GropWave] Reload system.md");
			}
		});
	}

	extensionContext.subscriptions.push(fileWatcher);
	if (systemWatcher) {
		extensionContext.subscriptions.push(systemWatcher);
	}
}

export function deactivate() {
	orchestrator = undefined;
	contextEngine = undefined;
	systemPromptEngine = undefined;
	groqClient = undefined;
	statusBar = undefined;
}
