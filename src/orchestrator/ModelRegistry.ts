/**
 * ModelRegistry — fetches available models from the Groq SDK, enriches them
 * with tier classification and quota limits, and maintains the canonical list.
 *
 * Since the Groq API does not expose per-model rate limits via the model list
 * endpoint, we maintain a local `MODEL_LIMITS` map with sensible defaults that
 * can be overridden via configuration.
 */

import Groq from "groq-sdk";
import { RegisteredModel, ModelLimits, resolveTier, TaskTier } from "./types";

// ─── Default per-model limits ────────────────────────────────────────────────
// These are approximations based on public Groq tier docs. Adjust as needed.

export const DEFAULT_MODEL_LIMITS: Record<string, ModelLimits> = {
	// Fast tier — high limits
	"llama-3.1-8b-instant": { rpm: 30000, rpd: 500000, tpm: 150000, tpd: 500000 },
	"llama3-8b-8192":       { rpm: 30000, rpd: 500000, tpm: 150000, tpd: 500000 },
	"gemma2-9b-it":          { rpm: 30000, rpd: 500000, tpm: 150000, tpd: 500000 },
	"llama-3.2-11b-vision-preview": { rpm: 30000, rpd: 500000, tpm: 150000, tpd: 500000 },

	// Balanced tier
	"llama-3.1-70b-versatile":      { rpm: 10000, rpd: 200000, tpm: 80000, tpd: 200000 },
	"llama3-70b-8192":              { rpm: 10000, rpd: 200000, tpm: 80000, tpd: 200000 },
	"mixtral-8x7b-32768":           { rpm: 10000, rpd: 200000, tpm: 80000, tpd: 200000 },
	"llama-3.2-90b-vision-preview": { rpm: 10000, rpd: 200000, tpm: 80000, tpd: 200000 },

	// Heavy tier — tighter limits
	"llama-3.1-405b-reasoning": { rpm: 5000, rpd: 100000, tpm: 40000, tpd: 100000 },
	"llama-guard-4-12b":        { rpm: 10000, rpd: 200000, tpm: 80000, tpd: 200000 },
};

/** Fallback limits for any model not in the map above. */
const FALLBACK_LIMITS: ModelLimits = { rpm: 5000, rpd: 100000, tpm: 40000, tpd: 100000 };

// ─── ModelRegistry class ─────────────────────────────────────────────────────

export class ModelRegistry {
	private client: Groq;
	private models: RegisteredModel[] = [];
	/** Override limits provided via config. */
	private limitOverrides: Map<string, ModelLimits> = new Map();

	constructor(client: Groq) {
		this.client = client;
	}

	/** Allow consumers to override limits for specific models. */
	setLimits(modelId: string, limits: ModelLimits): void {
		this.limitOverrides.set(modelId, limits);
	}

	/** Fetch models from the Groq API and build the registered model list. */
	async refresh(): Promise<RegisteredModel[]> {
		try {
			const response = await this.client.models.list();
			const rawModels = response.data ?? [];

			this.models = rawModels
				.filter((m) => m.id && !m.id.startsWith("whisper")) // filter non-chat models
				.map((m) => {
					const id = m.id;
					const tier = resolveTier(id);
					const limits =
						this.limitOverrides.get(id) ??
						DEFAULT_MODEL_LIMITS[id] ??
						FALLBACK_LIMITS;

					return {
						id,
						name: id, // could be enhanced with display names
						tier,
						limits,
						disabled: false,
					};
				});

			return this.models;
		} catch (err) {
			// If the API call fails, fall back to known model IDs so the
			// extension remains functional.
			console.warn("[ModelRegistry] Failed to fetch models from API, using fallback list:", err);
			this.models = this.getFallbackModels();
			return this.models;
		}
	}

	/** Return the current cached model list. */
	getModels(): RegisteredModel[] {
		return this.models;
	}

	/** Get models for a specific tier, optionally filtering out unhealthy ones. */
	getModelsByTier(tier: TaskTier): RegisteredModel[] {
		return this.models.filter((m) => m.tier === tier && !m.disabled);
	}

	/** Look up a single model by ID. */
	getModel(modelId: string): RegisteredModel | undefined {
		return this.models.find((m) => m.id === modelId);
	}

	/** Disable a model (e.g. when it consistently fails). */
	disableModel(modelId: string): void {
		const model = this.models.find((m) => m.id === modelId);
		if (model) {model.disabled = true;}
	}

	/** Re-enable a model. */
	enableModel(modelId: string): void {
		const model = this.models.find((m) => m.id === modelId);
		if (model) {model.disabled = false;}
	}

	// ─── Private helpers ─────────────────────────────────────────────────────

	/** Fallback model list used when the API is unreachable. */
	private getFallbackModels(): RegisteredModel[] {
		return Object.keys(DEFAULT_MODEL_LIMITS).map((id) => ({
			id,
			name: id,
			tier: resolveTier(id),
			limits: this.limitOverrides.get(id) ?? DEFAULT_MODEL_LIMITS[id] ?? FALLBACK_LIMITS,
			disabled: false,
		}));
	}
}
