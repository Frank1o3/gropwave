// Suppress punycode deprecation warning from Groq SDK dependencies
// Must run before any import that pulls in the groq-sdk
process.removeAllListeners("warning");
process.on("warning", (warning) => {
	if (!warning.message?.includes("punycode")) {
		 
		console.warn(warning);
	}
});

import * as vscode from "vscode";
import { OrchestratorCore, OrchestratorConfig } from "./orchestrator";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { ContextEngine, LLMProvider } from "./context-engine/ContextEngine";
import { SystemPromptEngine } from "./context-engine/SystemPromptEngine";
import { GroqClient } from "./orchestrator/GroqClient";
import { StatusBar } from "./status/StatusBar";
import { ActiveFileTracker } from "./active-context/ActiveFileTracker";

let orchestrator: OrchestratorCore | undefined;
let contextEngine: ContextEngine | undefined;
let systemPromptEngine: SystemPromptEngine | undefined;
let groqClient: GroqClient | undefined;
let statusBar: StatusBar | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let activeFileTracker: ActiveFileTracker | undefined;

export function activate(extensionContext: vscode.ExtensionContext) {
	// ─── Output channel ────────────────────────────────────────────────
	outputChannel = vscode.window.createOutputChannel("GropWave", "log");
	outputChannel.appendLine("=".repeat(60));
	outputChannel.appendLine("GropWave extension activated");
	extensionContext.subscriptions.push(outputChannel);

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
		outputChannel!.appendLine("[Config] WARNING: No API key configured");
		vscode.window.showWarningMessage(
			"GropWave: No API key configured. Set `gropwave.apiKey` in settings or define GROQ_API_KEY.",
		);
	} else {
		outputChannel!.appendLine("[Config] API key configured ✓");
	}

	// ─── Create GroqClient and LLMProvider adapter ───────────────────────
	groqClient = new GroqClient(orchestratorConfig);
	const llmProvider: LLMProvider = {
		async complete(systemPrompt: string, userPrompt: string): Promise<string> {
			return groqClient!.complete("llama-3.1-8b-instant", [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			], { temperature: 0.1 });
		},
	};

	// ─── Initialize context engine ───────────────────────────────────────
	SystemPromptEngine.ensureDefaultExists(orchestratorConfig).then((created) => {
		if (created) {
			vscode.window.showInformationMessage(
				"GropWave: Created a default system.md in your workspace. Edit it to customize AI behavior.",
			);
		}
	}).catch((err) => {
		console.warn("[GropWave] Failed to ensure system.md:", err);
	});

	contextEngine = new ContextEngine(extensionContext, orchestratorConfig, llmProvider, outputChannel);
	systemPromptEngine = new SystemPromptEngine(orchestratorConfig);

	// ─── Initialize orchestrator ─────────────────────────────────────────
	orchestrator = new OrchestratorCore(orchestratorConfig, extensionContext, {
		systemPromptEngine,
		contextEngine,
		activeFileTracker,
	});
	orchestrator.initialize().then(() => {
		outputChannel?.appendLine("[Init] Orchestrator initialized ✓");
		statusBar?.setReady(true);
	}).catch((err) => {
		outputChannel?.appendLine(`[Init] Failed: ${String(err)}`);
		console.error("[GropWave] Failed to initialize orchestrator:", err);
	});

	// ─── Status bar ──────────────────────────────────────────────────────
	statusBar = new StatusBar(extensionContext, orchestrator);
	statusBar.setReady(false);
	statusBar.show();

	// Apply user's default model preference
	if (orchestratorConfig.defaultModel && orchestratorConfig.defaultModel !== "auto") {
		orchestrator.setSelectedModel(orchestratorConfig.defaultModel);
	}

	// ─── Register webview view provider ──────────────────────────────────
	activeFileTracker = ActiveFileTracker.createAndAttach(extensionContext);

	const chatViewProvider = new ChatViewProvider(
		extensionContext.extensionUri,
		orchestrator,
		contextEngine,
		outputChannel,
		activeFileTracker,
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

	const fileWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
		const engine = contextEngine;
		if (!engine) {
			return;
		}
		if (doc.uri.scheme !== "file") {
			return;
		}
		const contextPath = engine.getContextPath();
		if (contextPath && doc.uri.fsPath === contextPath) {
			return;
		}
		setTimeout(() => {
			try {
				engine.updateFile(doc.uri.fsPath);
			} catch (err) {
				console.warn("[GropWave] Failed to update context for", doc.uri.fsPath, err);
			}
		}, 1000);
	});

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	let systemWatcher: vscode.FileSystemWatcher | undefined;
	if (workspaceRoot) {
		const systemPath = new vscode.RelativePattern(workspaceRoot, orchestratorConfig.systemFile);
		systemWatcher = vscode.workspace.createFileSystemWatcher(systemPath);
		systemWatcher.onDidChange(() => {
			if (systemPromptEngine) {
				systemPromptEngine.reload();
				outputChannel?.appendLine("[Watch] Reloaded system.md");
			}
		});
	}

	extensionContext.subscriptions.push(fileWatcher);
	if (systemWatcher) {
		extensionContext.subscriptions.push(systemWatcher);
	}
}

export function deactivate() {
	outputChannel?.appendLine("GropWave extension deactivated");
	orchestrator = undefined;
	contextEngine = undefined;
	systemPromptEngine = undefined;
	groqClient = undefined;
	statusBar = undefined;
	outputChannel = undefined;
	activeFileTracker = undefined;
}
