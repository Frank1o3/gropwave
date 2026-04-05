/**
 * TaskRouter — classifies a user prompt into an expertise tier using lightweight
 * heuristics (no LLM call needed). This keeps routing fast and cost-free.
 *
 * Classification signals:
 *   - Prompt length (token estimate)
 *   - Presence of code blocks
 *   - Presence of terminal output / error traces
 *   - Number of workspace files in context
 *   - Keyword patterns (index, summarize, debug, refactor, etc.)
 */

import { TaskTier, ClassifiedTask, TaskMeta, TASK_CLASSIFY_THRESHOLD } from "./types";

// ─── Keyword buckets ─────────────────────────────────────────────────────────

const FAST_KEYWORDS = [
	"index", "summarize", "summary", "list", "what does", "explain briefly",
	"quick", "simple", "outline", "overview", "describe",
];

const HEAVY_KEYWORDS = [
	"debug", "fix", "refactor", "architecture", "implement", "write",
	"generate", "optimize", "complex", "bug", "error", "stack trace",
	"why is", "how do I", "build", "create a function", "create a class",
];

// ─── Heuristic helpers ───────────────────────────────────────────────────────

function estimateTokens(text: string): number {
	// Rough approximation: ~1.3 tokens per word for English code-mixed text.
	const words = text.split(/\s+/).filter(Boolean).length;
	return Math.ceil(words * 1.3);
}

function hasCodeBlock(text: string): boolean {
	return /```[\s\S]*```/.test(text) || /^(import |export |function |class |const |let |def )/m.test(text);
}

function hasTerminalOutput(text: string): boolean {
	return /(error|traceback|exception|segmentation fault|command not found|ENOENT|EACCES|ReferenceError|TypeError)/i.test(text);
}

function containsKeywords(text: string, keywords: string[]): boolean {
	const lower = text.toLowerCase();
	return keywords.some((kw) => lower.includes(kw));
}

// ─── TaskRouter class ────────────────────────────────────────────────────────

export class TaskRouter {
	/**
	 * Classify a prompt into a tier.
	 * @param prompt The user's raw prompt text.
	 * @param fileCount Number of files currently in context (optional).
	 */
	classify(prompt: string, fileCount = 0): ClassifiedTask {
		const promptLength = prompt.length;
		const estimatedTokens = estimateTokens(prompt);
		const codeBlock = hasCodeBlock(prompt);
		const terminalOutput = hasTerminalOutput(prompt);

		const meta: TaskMeta = {
			fileCount,
			hasTerminalOutput: terminalOutput,
			hasCodeBlock: codeBlock,
			promptLength,
		};

		const tier = this.decideTier(prompt, estimatedTokens, codeBlock, terminalOutput, fileCount);

		return { prompt, tier, estimatedTokens, meta };
	}

	// ─── Private: tier decision logic ────────────────────────────────────────

	private decideTier(
		prompt: string,
		tokens: number,
		hasCode: boolean,
		hasTerminal: boolean,
		fileCount: number,
	): TaskTier {
		const { fastMaxTokens, fastMaxFiles, heavyMinTokens } = TASK_CLASSIFY_THRESHOLD;

		// -- Heavy signals ------------------------------------------------
		if (tokens >= heavyMinTokens) {
			return TaskTier.Heavy;
		}
		if (containsKeywords(prompt, HEAVY_KEYWORDS) && (hasCode || hasTerminal)) {
			return TaskTier.Heavy;
		}
		// Debugging / error fixing with a stack trace is always heavy.
		if (hasTerminal && hasCode) {
			return TaskTier.Heavy;
		}

		// -- Fast signals -------------------------------------------------
		if (tokens <= fastMaxTokens && fileCount <= fastMaxFiles) {
			if (containsKeywords(prompt, FAST_KEYWORDS)) {
				return TaskTier.Fast;
			}
			// Short prompts without code are fast by default.
			if (!hasCode && tokens < 500) {
				return TaskTier.Fast;
			}
		}

		// -- Default to balanced ------------------------------------------
		return TaskTier.Balanced;
	}
}
