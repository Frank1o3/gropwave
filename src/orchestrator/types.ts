/**
 * Core type definitions for the GropWave Smart Orchestrator.
 */

// ─── Model & Tier Types ─────────────────────────────────────────────────────

/** Expertise tier for model routing. */
export enum TaskTier {
	Fast = "fast",       // 8B, mini models — indexing, summaries, simple Qs
	Balanced = "balanced", // 13B–34B — refactoring, explanations
	Heavy = "heavy",     // 70B+, pro — complex logic, debugging, code gen
}

/** Hard-coded tier assignment by model ID pattern. */
export const MODEL_TIER_MAP: Record<string, TaskTier> = {
	// Fast tier — lightweight models with high daily limits
	"llama-3.1-8b-instant": TaskTier.Fast,
	"llama3-8b-8192": TaskTier.Fast,
	"gemma2-9b-it": TaskTier.Fast,
	"llama-3.2-11b-vision-preview": TaskTier.Fast,
	"llama-3.2-90b-vision-preview": TaskTier.Balanced,

	// Balanced tier
	"llama-3.1-70b-versatile": TaskTier.Balanced,
	"llama3-70b-8192": TaskTier.Balanced,
	"mixtral-8x7b-32768": TaskTier.Balanced,

	// Heavy tier — pro / largest models
	"llama-3.1-405b-reasoning": TaskTier.Heavy,
	"llama-guard-4-12b": TaskTier.Balanced,
};

/** Resolve tier from a model ID string. */
export function resolveTier(modelId: string): TaskTier {
	// Direct match
	if (MODEL_TIER_MAP[modelId]) {return MODEL_TIER_MAP[modelId];}
	// Pattern match
	const lower = modelId.toLowerCase();
	if (lower.includes("8b") || lower.includes("9b") || lower.includes("11b") || lower.includes("mini")) {
		return TaskTier.Fast;
	}
	if (lower.includes("405b") || lower.includes("pro") || lower.includes("reasoning")) {
		return TaskTier.Heavy;
	}
	return TaskTier.Balanced; // default
}

/** Quota limits for a single model (provided by SDK or configured locally). */
export interface ModelLimits {
	rpm: number;  // requests per minute
	rpd: number;  // requests per day
	tpm: number;  // tokens per minute
	tpd: number;  // tokens per day
}

/** Current quota usage snapshot for a model. */
export interface QuotaUsage {
	rpmCount: number;
	rpdCount: number;
	tpmCount: number;
	tpdCount: number;
}

/** Health status of a model's quota. */
export enum QuotaHealth {
	Healthy = "healthy",       // < warning threshold
	Warning = "warning",       // >= warning threshold but < 100%
	Exhausted = "exhausted",   // >= 100% — should not be used
}

/** Combined status of a model including quota health. */
export interface ModelQuotaStatus {
	modelId: string;
	health: QuotaHealth;
	limits: ModelLimits;
	usage: QuotaUsage;
	// Which limit is the most constrained (0-1 ratio)
	mostConstrained: { key: keyof ModelLimits; ratio: number };
}

/** A model entry in the registry. */
export interface RegisteredModel {
	id: string;
	name: string;
	tier: TaskTier;
	limits: ModelLimits;
	/** When true the model should not appear in the UI or be selected. */
	disabled: boolean;
}

// ─── Task Routing Types ─────────────────────────────────────────────────────

/** A categorized task ready for model selection. */
export interface ClassifiedTask {
	prompt: string;
	tier: TaskTier;
	estimatedTokens: number;
	/** Extra context: number of files, terminal output present, etc. */
	meta: TaskMeta;
}

export interface TaskMeta {
	fileCount: number;
	hasTerminalOutput: boolean;
	hasCodeBlock: boolean;
	promptLength: number;
}

/** Heuristic thresholds for tier classification. */
export const TASK_CLASSIFY_THRESHOLD = {
	fastMaxTokens: 2000,
	fastMaxFiles: 5,
	heavyMinTokens: 4000,
	heavyHasCode: true,
};

// ─── Orchestrator Config ────────────────────────────────────────────────────

export interface OrchestratorConfig {
	apiKey: string;
	baseUrl: string;
	defaultModel: string; // "auto" or explicit model ID
	quotaWarningThreshold: number; // 0-1
	contextFile: string;
	systemFile: string;
}

// ─── Chat Message Types (for webview ↔ extension IPC) ───────────────────────

export interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	modelId?: string;
}

/** Messages sent from extension to webview. */
export type WebviewMessage =
	| { type: "models"; models: RegisteredModel[] }
	| { type: "quotaStatus"; statuses: ModelQuotaStatus[] }
	| { type: "response"; message: ChatMessage }
	| { type: "error"; error: string }
	| { type: "streamChunk"; content: string }
	| { type: "streamDone"; message: ChatMessage };

/** Messages sent from webview to extension. */
export type ExtensionMessage =
	| { type: "prompt"; content: string }
	| { type: "selectModel"; modelId: string }
	| { type: "command"; command: string };
