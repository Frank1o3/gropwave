/**
 * StatusBar — persistent VS Code status bar item showing GropWave state.
 *
 * Displays:
 *   - Current model (or "Auto").
 *   - Quota health (🟢 Healthy / 🟡 Warning / 🔴 Exhausted).
 *   - Initialization status.
 *
 * Clicking the item focuses the chat view.
 */

import * as vscode from "vscode";
import { OrchestratorCore, ModelQuotaStatus, QuotaHealth } from "../orchestrator";

export class StatusBar {
	private item: vscode.StatusBarItem;
	private currentModel = "Auto";
	private quotaHealth = QuotaHealth.Healthy;
	private isReady = false;

	constructor(context: vscode.ExtensionContext, orchestrator: OrchestratorCore) {
		this.item = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100, // priority — show toward the right
		);
		this.item.command = "gropwave.focusChat";
		this.item.tooltip = "GropWave AI Assistant — click to open chat";
		context.subscriptions.push(this.item);

		// Listen for orchestrator events
		orchestrator.onModelsChange(() => {
			this.updateDisplay();
		});

		orchestrator.onQuotaChange((statuses) => {
			this.updateQuotaHealth(statuses, orchestrator.getLastUsedModel());
		});
	}

	/** Update the model name. */
	setModel(modelId: string): void {
		this.currentModel = modelId === "auto" ? "Auto" : this.shortenModel(modelId);
		this.updateDisplay();
	}

	/** Mark the orchestrator as ready. */
	setReady(ready: boolean): void {
		this.isReady = ready;
		this.updateDisplay();
	}

	/** Show the status bar item. */
	show(): void {
		this.item.show();
	}

	/** Update the quota health from the orchestrator. */
	private updateQuotaHealth(
		statuses: Map<string, ModelQuotaStatus>,
		modelId: string,
	): void {
		if (modelId === "auto") {
			// For auto mode, check if any model is unhealthy
			let worst = QuotaHealth.Healthy;
			for (const status of statuses.values()) {
				if (status.health === QuotaHealth.Exhausted) {
					worst = QuotaHealth.Exhausted;
					break;
				}
				if (status.health === QuotaHealth.Warning) {
					worst = QuotaHealth.Warning;
				}
			}
			this.quotaHealth = worst;
		} else {
			const status = statuses.get(modelId);
			this.quotaHealth = status?.health ?? QuotaHealth.Healthy;
		}
		this.updateDisplay();
	}

	private updateDisplay(): void {
		const modelLabel = this.isReady ? this.currentModel : "Loading…";

		let icon: string;
		switch (this.quotaHealth) {
			case QuotaHealth.Exhausted:
				icon = "$(error)";
				break;
			case QuotaHealth.Warning:
				icon = "$(warning)";
				break;
			default:
				icon = "$(check)";
				break;
		}

		this.item.text = `${icon} GropWave: ${modelLabel}`;

		if (!this.isReady) {
			this.item.tooltip = "GropWave — initializing…";
		} else {
			const healthText = this.quotaHealth === QuotaHealth.Healthy
				? "healthy"
				: this.quotaHealth === QuotaHealth.Warning
					? "near quota limits"
					: "quota exhausted";
			this.item.tooltip = `GropWave AI Assistant (${modelLabel}) — ${healthText}\nClick to open chat`;
		}
	}

	/** Shorten model ID for display (e.g. "llama-3.1-8b-instant" → "llama-3.1-8b"). */
	private shortenModel(modelId: string): string {
		const parts = modelId.split("-");
		if (parts.length > 3) {
			return parts.slice(0, 3).join("-");
		}
		return modelId;
	}
}
