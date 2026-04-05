/**
 * OrchestratorCore — the central coordinator for the GropWave extension.
 *
 * Responsibilities:
 *   1. Receive a user prompt.
 *   2. Classify it into a tier via TaskRouter.
 *   3. Select the best available model in that tier (checking quota health).
 *   4. Fall back to the next tier if the preferred tier is exhausted.
 *   5. Dispatch the request through GroqClient (with optional streaming).
 *   6. Record usage in QuotaTracker for future decisions.
 */

import * as vscode from "vscode";
import {
	TaskTier,
	RegisteredModel,
	ModelQuotaStatus,
	QuotaHealth,
	OrchestratorConfig,
	ChatMessage,
} from "./types";
import { QuotaTracker } from "./QuotaTracker";
import { ModelRegistry } from "./ModelRegistry";
import { TaskRouter } from "./TaskRouter";
import { GroqClient } from "./GroqClient";
import { SystemPromptEngine } from "../context-engine/SystemPromptEngine";
import { ContextEngine } from "../context-engine/ContextEngine";
import { parseToolCalls, executeToolCalls, ParsedToolCall } from "../tools/AgentTools";
import { ActiveFileTracker } from "../active-context/ActiveFileTracker";

// ─── Tier ordering for fallback ──────────────────────────────────────────────

const TIER_FALLBACK_ORDER: TaskTier[][] = [
	[TaskTier.Heavy, TaskTier.Balanced, TaskTier.Fast],   // heavy → balanced → fast
	[TaskTier.Balanced, TaskTier.Heavy, TaskTier.Fast],   // balanced → heavy → fast
	[TaskTier.Fast, TaskTier.Balanced, TaskTier.Heavy],   // fast → balanced → heavy
];

function fallbackTiers(preferred: TaskTier): TaskTier[] {
	const idx = TIER_FALLBACK_ORDER.findIndex((t) => t[0] === preferred);
	return idx >= 0 ? TIER_FALLBACK_ORDER[idx] : [preferred, TaskTier.Balanced, TaskTier.Fast];
}

// ─── OrchestratorCore class ──────────────────────────────────────────────────

export class OrchestratorCore {
	private config: OrchestratorConfig;
	private quotaTracker: QuotaTracker;
	private modelRegistry: ModelRegistry;
	private taskRouter: TaskRouter;
	private groqClient: GroqClient;

	/** Optional engines for context/system prompt extraction. */
	private systemPromptEngine?: SystemPromptEngine;
	private contextEngine?: ContextEngine;
	private activeFileTracker?: ActiveFileTracker;

	/** Extension context for state persistence. */
	private extensionContext: vscode.ExtensionContext;

	/** The model the user has manually selected, or "auto". */
	private selectedModel: string = "auto";

	/** The model used for the most recent dispatch (for UI display). */
	private lastUsedModel: string = "";

	/** Whether initialize() has completed. Dispatch is blocked until true. */
	private initialized = false;

	/** Event emitters for UI updates. */
	private onModelsChangeEmitter: vscode.EventEmitter<RegisteredModel[]>;
	private onQuotaChangeEmitter: vscode.EventEmitter<Map<string, ModelQuotaStatus>>;

	constructor(
		config: OrchestratorConfig,
		context: vscode.ExtensionContext,
		dependencies?: {
			systemPromptEngine?: SystemPromptEngine;
			contextEngine?: ContextEngine;
			activeFileTracker?: ActiveFileTracker;
		},
	) {
		this.config = config;
		this.extensionContext = context;
		this.quotaTracker = new QuotaTracker(config.quotaWarningThreshold);
		this.taskRouter = new TaskRouter();

		this.groqClient = new GroqClient(config);
		this.modelRegistry = new ModelRegistry(this.groqClient.raw);

		this.systemPromptEngine = dependencies?.systemPromptEngine;
		this.contextEngine = dependencies?.contextEngine;
		this.activeFileTracker = dependencies?.activeFileTracker;

		this.onModelsChangeEmitter = new vscode.EventEmitter<RegisteredModel[]>();
		this.onQuotaChangeEmitter = new vscode.EventEmitter<Map<string, ModelQuotaStatus>>();

		context.subscriptions.push(
			this.onModelsChangeEmitter,
			this.onQuotaChangeEmitter,
		);
	}

	// ─── Public events ───────────────────────────────────────────────────────

	/** Fire when the model list changes (refresh). */
	get onModelsChange(): vscode.Event<RegisteredModel[]> {
		return this.onModelsChangeEmitter.event;
	}

	/** Fire when quota statuses change. */
	get onQuotaChange(): vscode.Event<Map<string, ModelQuotaStatus>> {
		return this.onQuotaChangeEmitter.event;
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	/** Initialize: fetch models and apply any config overrides. */
	async initialize(): Promise<void> {
		// Load system prompt engine from disk if available
		if (this.systemPromptEngine) {
			this.systemPromptEngine.load();
		}

		await this.modelRegistry.refresh();
		this.onModelsChangeEmitter.fire(this.modelRegistry.getModels());
		this.emitQuotaStatus();
		this.initialized = true;
	}

	/** Re-fetch models from the API. */
	async refreshModels(): Promise<RegisteredModel[]> {
		const models = await this.modelRegistry.refresh();
		this.onModelsChangeEmitter.fire(models);
		this.emitQuotaStatus();
		return models;
	}

	// ─── Model selection ─────────────────────────────────────────────────────

	/** Set the user's manually selected model, or "auto" for smart routing. */
	setSelectedModel(modelId: string): void {
		this.selectedModel = modelId;
	}

	getSelectedModel(): string {
		return this.selectedModel;
	}

	/** The model actually used for the last dispatch (useful for UI display). */
	getLastUsedModel(): string {
		return this.lastUsedModel;
	}

	/** Get the current registered model list. */
	getModels(): RegisteredModel[] {
		return this.modelRegistry.getModels();
	}

	// ─── Main dispatch ───────────────────────────────────────────────────────

	/**
	 * Process a user prompt: classify → select model → dispatch → record usage.
	 *
	 * Maintains conversation history for multi-turn chat.
	 * Automatically detects and executes tool calls in the LLM response,
	 * feeding the results back for a follow-up turn.
	 *
	 * @param prompt The user's prompt text.
	 * @param onChunk Optional callback for streaming chunks.
	 * @returns The final assistant response text.
	 */
	async dispatch(
		prompt: string,
		onChunk?: (chunk: string) => void,
	): Promise<string> {
		if (!this.initialized) {
			throw new Error("GropWave is still initializing. Please wait a moment and try again.");
		}
		if (!this.config.apiKey) {
			throw new Error("No API key configured. Set gropwave.apiKey in settings or define GROQ_API_KEY.");
		}

		// 1. Classify the task
		const task = this.taskRouter.classify(prompt);

		// 2. Build the full message list: system + context + active file + history + user
		const messages = this.buildMessagesWithHistory(prompt);

		// 3. Select model (smart routing or explicit)
		const modelId = this.selectModel(task.tier, task.estimatedTokens);
		if (!modelId) {
			throw new Error("No suitable model available — all models in relevant tiers are quota-exhausted.");
		}

		this.lastUsedModel = modelId;

		// 4. Dispatch to LLM
		let response: string;
		if (onChunk) {
			response = await this.groqClient.streamComplete(modelId, messages, onChunk);
		} else {
			response = await this.groqClient.complete(modelId, messages);
		}

		// 5. Record usage
		const totalTokens = task.estimatedTokens + estimateTokens(response);
		this.quotaTracker.record(modelId, totalTokens);
		this.emitQuotaStatus();

		// 6. Check for tool calls in the response
		const toolCalls = parseToolCalls(response);
		if (toolCalls.length > 0) {
			// Execute tools and feed results back for a follow-up
			response = await this.handleToolCalls(toolCalls, messages, modelId, onChunk);
		}

		return response;
	}

	/**
	 * Execute tool calls found in the LLM response, then send the results
	 * back as a user message for a follow-up completion.
	 */
	private async handleToolCalls(
		toolCalls: ParsedToolCall[],
		baseMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
		modelId: string,
		onChunk?: (chunk: string) => void,
	): Promise<string> {
		const results = await executeToolCalls(toolCalls);
		const toolSummary = results.join("\n\n");

		// Build a follow-up message with tool results
		const followUpMessages = [
			...baseMessages,
			{
				role: "user" as const,
				content: `Tool execution results:\n\n${toolSummary}\n\nPlease summarize what was done and continue.`,
			},
		];

		// Stream a follow-up response
		if (onChunk) {
			onChunk("\n\n_Executing tools..._\n\n");
		}

		let followUpResponse: string;
		if (onChunk) {
			followUpResponse = await this.groqClient.streamComplete(
				modelId,
				followUpMessages,
				onChunk,
			);
		} else {
			followUpResponse = await this.groqClient.complete(modelId, followUpMessages);
		}

		// Record the follow-up usage too
		this.quotaTracker.record(modelId, estimateTokens(followUpResponse));
		return followUpResponse;
	}

	// ─── Quota status ────────────────────────────────────────────────────────

	/** Get current quota statuses for all models. */
	getQuotaStatuses(): Map<string, ModelQuotaStatus> {
		const models = this.modelRegistry.getModels();
		const limitsMap = new Map(models.map((m) => [m.id, m.limits]));
		return this.quotaTracker.getAllHealth(limitsMap);
	}

	// ─── Internal: model selection with fallback ─────────────────────────────

	private selectModel(preferredTier: TaskTier, estimatedTokens: number): string | null {
		// If the user manually selected a specific model, honor it (quota check only).
		if (this.selectedModel !== "auto") {
			const model = this.modelRegistry.getModel(this.selectedModel);
			if (!model || model.disabled) {
				return null;
			}
			if (this.quotaTracker.canAccept(model.id, model.limits, estimatedTokens)) {
				return model.id;
			}
			// Manual pick is exhausted — fall through to smart routing.
		}

		// Smart routing: try tiers in fallback order.
		const tiers = fallbackTiers(preferredTier);

		for (const tier of tiers) {
			const candidates = this.modelRegistry
				.getModels()
				.filter((m) => m.tier === tier && !m.disabled);

			// Sort candidates by healthiest first (most constrained ratio ascending).
			const statuses = this.getQuotaStatuses();
			candidates.sort((a, b) => {
				const sa = statuses.get(a.id);
				const sb = statuses.get(b.id);
				return (sa?.mostConstrained.ratio ?? 0) - (sb?.mostConstrained.ratio ?? 0);
			});

			for (const model of candidates) {
				if (this.quotaTracker.canAccept(model.id, model.limits, estimatedTokens)) {
					return model.id;
				}
			}
		}

		return null;
	}

	// ─── Internal: message assembly with conversation history ──────────────────

	/** Static preamble that describes available tools — always injected. */
	private static readonly TOOL_PREAMBLE = [
		"You have access to the following tools. Use them when appropriate to take action.",
		"",
		"### Tools",
		"",
		"**Run a terminal command:**",
		'Wrap the command in `<tool:run_command>...</tool:run_command>` tags.',
		"Example: `<tool:run_command>npm test</tool:run_command>`",
		"",
		"**Edit a file:**",
		'Wrap the new file content in `<tool:edit_file path="relative/path">...</tool:edit_file>` tags.',
		'Example: `<tool:edit_file path="src/index.ts">export const x = 1;</tool:edit_file>`',
		"",
		"After using tools, summarize what you did and provide the final answer to the user.",
		"Only use tools when they are genuinely needed — prefer answering from knowledge when possible.",
		"",
	].join("\n");

	/**
	 * Build the full message list: system prompt + workspace context +
	 * conversation history + the current user prompt.
	 */
	private buildMessagesWithHistory(userPrompt: string): Array<{ role: "system" | "user" | "assistant"; content: string }> {
		const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

		// 1. System prompt (selective feeding from system.md) + tool preamble
		let systemPrompt = this.extractSystemPrompt(userPrompt);
		// Always prepend tool availability — the LLM must know what it can do
		if (systemPrompt.trim()) {
			systemPrompt = OrchestratorCore.TOOL_PREAMBLE + "\n\n" + systemPrompt;
		} else {
			systemPrompt = OrchestratorCore.TOOL_PREAMBLE;
		}
		messages.push({ role: "system", content: systemPrompt });

		// 2. Workspace context (from context.md)
		const contextPrompt = this.extractContext();
		if (contextPrompt.trim()) {
			messages.push({
				role: "system",
				content: `## Workspace Context (from context.md)\n${contextPrompt}`,
			});
		}

		// 3. Current user prompt — with active file context prepended for prominence
		let finalPrompt = userPrompt;
		const activeContextStr = this.activeFileTracker?.getActiveContext();
		if (activeContextStr) {
			finalPrompt = `[Currently editing: ${activeContextStr}]\n\n${userPrompt}`;
		}
		messages.push({ role: "user", content: finalPrompt });

		return messages;
	}

	/** Extract relevant system prompt sections for this prompt. */
	private extractSystemPrompt(prompt: string): string {
		if (!this.systemPromptEngine) {
			return "";
		}
		const contextContent = this.contextEngine?.readContext() ?? "";
		return this.systemPromptEngine.extractRelevant(prompt, contextContent || undefined);
	}

	/** Read workspace context from context.md. */
	private extractContext(): string {
		if (!this.contextEngine) {
			return "";
		}
		return this.contextEngine.readContext();
	}

	// ─── Internal: emit quota status event ───────────────────────────────────

	private emitQuotaStatus(): void {
		this.onQuotaChangeEmitter.fire(this.getQuotaStatuses());
	}
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
	const words = text.split(/\s+/).filter(Boolean).length;
	return Math.ceil(words * 1.3);
}
