/**
 * QuotaTracker — tracks per-model usage with sliding-window counters.
 *
 * Instead of simple increments, each request logs a timestamped entry with
 * token counts. Expired entries are pruned on each check, giving accurate
 * RPM/TPM (60s window) and RPD/TPD (24h window) counts.
 */

import { ModelLimits, QuotaUsage, QuotaHealth, ModelQuotaStatus } from "./types";

// ─── Internal log entry ─────────────────────────────────────────────────────

interface UsageEntry {
	timestamp: number;   // Date.now() when the request was made
	tokens: number;      // total tokens used in this request
}

// ─── QuotaTracker class ─────────────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class QuotaTracker {
	/** Per-model usage logs keyed by model ID. */
	private logs: Map<string, UsageEntry[]> = new Map();

	/** Warning threshold ratio (e.g. 0.9 = 90%). */
	private warningThreshold: number;

	constructor(warningThreshold = 0.9) {
		this.warningThreshold = warningThreshold;
	}

	/** Record a request and its token usage for a model. */
	record(modelId: string, tokens: number): void {
		const entries = this.logs.get(modelId) ?? [];
		entries.push({ timestamp: Date.now(), tokens });
		this.logs.set(modelId, entries);
	}

	/** Prune entries older than the given window for a model. */
	private prune(modelId: string, windowMs: number): void {
		const entries = this.logs.get(modelId);
		if (!entries) {return;}
		const cutoff = Date.now() - windowMs;
		// Keep only entries within the window
		const filtered = entries.filter((e) => e.timestamp > cutoff);
		// Only mutate the map if something was actually removed
		if (filtered.length !== entries.length) {
			this.logs.set(modelId, filtered);
		}
	}

	/** Compute current usage counts for a model across all windows. */
	getUsage(modelId: string): QuotaUsage {
		this.prune(modelId, DAY_MS); // prune oldest first
		const entries = this.logs.get(modelId) ?? [];

		const minuteCutoff = Date.now() - MINUTE_MS;
		let rpmCount = 0;
		let tpmCount = 0;

		for (const entry of entries) {
			if (entry.timestamp > minuteCutoff) {
				rpmCount++;
				tpmCount += entry.tokens;
			}
		}

		return {
			rpmCount,
			rpdCount: entries.length,
			tpmCount,
			tpdCount: entries.reduce((sum, e) => sum + e.tokens, 0),
		};
	}

	/** Check whether a new request of ~`tokens` would exceed any limit. */
	canAccept(
		modelId: string,
		limits: ModelLimits,
		estimatedTokens: number,
	): boolean {
		const usage = this.getUsage(modelId);

		const projectedRpm = usage.rpmCount + 1;
		const projectedRpd = usage.rpdCount + 1;
		const projectedTpm = usage.tpmCount + estimatedTokens;
		const projectedTpd = usage.tpdCount + estimatedTokens;

		return (
			projectedRpm <= limits.rpm &&
			projectedRpd <= limits.rpd &&
			projectedTpm <= limits.tpm &&
			projectedTpd <= limits.tpd
		);
	}

	/** Compute quota health and the most-constrained limit ratio. */
	getHealth(modelId: string, limits: ModelLimits): ModelQuotaStatus {
		const usage = this.getUsage(modelId);

		const ratios: Record<keyof ModelLimits, number> = {
			rpm: usage.rpmCount / (limits.rpm || 1),
			rpd: usage.rpdCount / (limits.rpd || 1),
			tpm: usage.tpmCount / (limits.tpm || 1),
			tpd: usage.tpdCount / (limits.tpd || 1),
		};

		// Find the most constrained dimension
		let maxKey: keyof ModelLimits = "rpm";
		let maxRatio = 0;
		for (const [key, ratio] of Object.entries(ratios)) {
			if (ratio > maxRatio) {
				maxRatio = ratio;
				maxKey = key as keyof ModelLimits;
			}
		}

		let health: QuotaHealth;
		if (maxRatio >= 1.0) {
			health = QuotaHealth.Exhausted;
		} else if (maxRatio >= this.warningThreshold) {
			health = QuotaHealth.Warning;
		} else {
			health = QuotaHealth.Healthy;
		}

		return {
			modelId,
			health,
			limits,
			usage,
			mostConstrained: { key: maxKey, ratio: maxRatio },
		};
	}

	/** Return health statuses for all registered models at once. */
	getAllHealth(
		modelLimits: Map<string, ModelLimits>,
	): Map<string, ModelQuotaStatus> {
		const result = new Map<string, ModelQuotaStatus>();
		for (const [modelId, limits] of modelLimits) {
			result.set(modelId, this.getHealth(modelId, limits));
		}
		return result;
	}

	/** Reset all counters for a model (e.g. on manual refresh). */
	reset(modelId: string): void {
		this.logs.delete(modelId);
	}

	/** Reset all counters for all models. */
	resetAll(): void {
		this.logs.clear();
	}

	/** Update the warning threshold at runtime. */
	setWarningThreshold(threshold: number): void {
		this.warningThreshold = threshold;
	}
}
