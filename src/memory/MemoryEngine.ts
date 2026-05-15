/**
 * MemoryEngine — unified memory store for the GropWave extension.
 *
 * Replaces the context.md-only approach with a scored, timestamped entry
 * system stored in memory.md. Supports code summaries, conversation turns,
 * and observations with decay-based pruning and relevance retrieval.
 *
 * Entry format (YAML frontmatter blocks inside memory.md):
 *
 *   ---
 *   id: <uuid-short>
 *   type: code_summary | conversation | observation
 *   source: <file path or "chat">
 *   created: <ISO timestamp>
 *   last_accessed: <ISO timestamp>
 *   access_count: <int>
 *   tags: [<keyword list>]
 *   decay_score: <float 0.0–1.0>
 *   ---
 *   <content here>
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getCacheFilePath } from "../utils/paths";

// ─── Entry types ─────────────────────────────────────────────────────────────

export type MemoryEntryType = "code_summary" | "conversation" | "observation";

export interface MemoryEntry {
	id: string;
	type: MemoryEntryType;
	source: string;
	created: string;
	last_accessed: string;
	access_count: number;
	tags: string[];
	decay_score: number;
	content: string;
}

// ─── Stopwords for keyword extraction (reuses same logic as SystemPromptEngine) ──

const STOPWORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "shall", "can", "need", "dare", "ought",
	"used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
	"as", "into", "through", "during", "before", "after", "above",
	"below", "between", "out", "off", "over", "under", "again",
	"further", "then", "once", "and", "but", "or", "nor", "not", "so",
	"yet", "both", "either", "neither", "each", "every", "all", "any",
	"few", "more", "most", "other", "some", "such", "no", "only", "own",
	"same", "than", "too", "very", "just", "because", "if", "when",
	"where", "which", "while", "who", "whom", "what", "how", "this",
	"that", "these", "those", "it", "its", "we", "our", "you", "your",
	"they", "their", "he", "she", "his", "her", "i", "my", "me",
	"about", "also", "make", "like", "use", "using", "used", "ensure",
	"follow", "always", "never", "prefer", "avoid", "note", "important",
	"must", "does", "did", "done",
]);

/**
 * Extract representative keywords from text.
 * Same approach as SystemPromptEngine's extractKeywords.
 */
function extractKeywords(text: string, maxCount = 15): string[] {
	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\s_\-+#./]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w));

	words.sort((a, b) => b.length - a.length);
	const unique = [...new Set(words)];
	return unique.slice(0, maxCount);
}

/** Generate a short UUID (8 hex chars) for entry IDs. */
function shortUuid(): string {
	return Math.random().toString(16).slice(2, 10);
}

// ─── Frontmatter serialization ───────────────────────────────────────────────

/** Serialize a MemoryEntry into a YAML frontmatter block. */
function serializeEntry(entry: MemoryEntry): string {
	const tagsYaml = entry.tags.length > 0
		? `[${entry.tags.map((t) => `"${t}"`).join(", ")}]`
		: "[]";

	return [
		"---",
		`id: ${entry.id}`,
		`type: ${entry.type}`,
		`source: ${entry.source}`,
		`created: ${entry.created}`,
		`last_accessed: ${entry.last_accessed}`,
		`access_count: ${entry.access_count}`,
		`decay_score: ${entry.decay_score.toFixed(4)}`,
		`tags: ${tagsYaml}`,
		"---",
		entry.content,
		"\n",
	].join("\n");
}

/** Parse all MemoryEntry blocks from the content of memory.md. */
function parseEntries(content: string): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	const blockRegex = /---\nid:\s*(.+?)\ntype:\s*(.+?)\nsource:\s*(.+?)\ncreated:\s*(.+?)\nlast_accessed:\s*(.+?)\naccess_count:\s*(\d+)\ndecay_score:\s*([\d.]+)\ntags:\s*(\[.*?\])\n---\n([\s\S]*?)(?=\n---\nid:|$)/g;

	let match: RegExpExecArray | null;
	while ((match = blockRegex.exec(content)) !== null) {
		const rawTags = match[8].trim();
		let tags: string[] = [];
		try {
			// Parse YAML-style list: ["tag1", "tag2"] or [tag1, tag2]
			const inner = rawTags.slice(1, -1);
			if (inner.trim().length > 0) {
				tags = inner.split(",").map((t) => t.trim().replace(/^["']|["']$/g, ""));
			}
		} catch {
			tags = [];
		}

		entries.push({
			id: match[1].trim(),
			type: match[2].trim() as MemoryEntryType,
			source: match[3].trim(),
			created: match[4].trim(),
			last_accessed: match[5].trim(),
			access_count: parseInt(match[6], 10),
			decay_score: parseFloat(match[7]),
			tags,
			content: match[9].trim(),
		});
	}

	return entries;
}

// ─── MemoryEngine class ──────────────────────────────────────────────────────

export class MemoryEngine {
	private entries: MemoryEntry[] = [];
	private memoryFilePath: string;
	private initialized = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		memoryFileName: string = "memory.md",
	) {
		const cachePath = getCacheFilePath(memoryFileName);
		if (!cachePath) {
			throw new Error("No workspace folder open. MemoryEngine requires a workspace.");
		}
		this.memoryFilePath = cachePath;
	}

	/** Load existing entries from memory.md. Call once on startup. */
	async load(): Promise<void> {
		try {
			const content = await vscode.workspace.fs.readFile(vscode.Uri.file(this.memoryFilePath));
			this.entries = parseEntries(Buffer.from(content).toString("utf-8"));
		} catch {
			// File doesn't exist or is unreadable — start fresh
			this.entries = [];
		}
		this.initialized = true;
	}

	/**
	 * Decay all entries scores. Called once on extension startup.
	 * Multiplies each entry's decay_score by 0.92 to gradually
	 * reduce the relevance of stale entries.
	 */
	decayAll(): void {
		for (const entry of this.entries) {
			entry.decay_score *= 0.92;
		}
		this.persistEntries();
	}

	/**
	 * Add a new memory entry and persist to memory.md.
	 *
	 * @param type The entry type (code_summary, conversation, observation).
	 * @param source The file path or "chat" for conversation entries.
	 * @param content The entry content text.
	 * @param tags Keywords for relevance matching.
	 */
	addEntry(type: MemoryEntryType, source: string, content: string, tags: string[]): void {
		const now = new Date().toISOString();
		const entry: MemoryEntry = {
			id: shortUuid(),
			type,
			source,
			created: now,
			last_accessed: now,
			access_count: 0,
			decay_score: 1.0,
			tags,
			content,
		};

		this.entries.push(entry);
		this.persistEntries();
	}

	/**
	 * Retrieve entries relevant to the user's prompt.
	 *
	 * Scores all entries against the prompt using keyword overlap,
	 * boosted by recency and access_count. Filters entries with
	 * decay_score < 0.1 and returns top N as a concatenated string.
	 *
	 * @param prompt The user's prompt text.
	 * @param maxEntries Maximum number of entries to return (default 8).
	 * @returns Concatenated string of relevant memory entries.
	 */
	retrieveRelevant(prompt: string, maxEntries = 8): string {
		const promptKeywords = extractKeywords(prompt, 30);
		if (promptKeywords.length === 0) {
			return "";
		}

		const now = Date.now();
		const oneDayMs = 24 * 60 * 60 * 1000;

		const scored = this.entries
			.filter((e) => e.decay_score >= 0.1)
			.map((entry) => {
				// Keyword overlap score
				let overlapScore = 0;
				for (const kw of promptKeywords) {
					if (entry.tags.includes(kw)) {
						overlapScore += 1.0;
					}
				}
				// Also check content for keyword presence (partial credit)
				const contentLower = entry.content.toLowerCase();
				for (const kw of promptKeywords) {
					if (contentLower.includes(kw)) {
						overlapScore += 0.3;
					}
				}

				// Recency boost: entries accessed more recently score higher
				const lastAccessed = new Date(entry.last_accessed).getTime();
				const daysSinceAccess = Math.max(0, (now - lastAccessed) / oneDayMs);
				const recencyBoost = Math.exp(-daysSinceAccess / 30); // 30-day half-life

				// Access count boost: frequently accessed entries score higher
				const accessBoost = Math.min(entry.access_count * 0.05, 0.5); // Cap at 0.5

				const totalScore = (overlapScore + recencyBoost + accessBoost) * entry.decay_score;

				return { entry, score: totalScore };
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, maxEntries);

		if (scored.length === 0) {
			return "";
		}

		// Build the concatenated result
		return scored
			.map(({ entry }) => {
				const header = `[${entry.type}] ${entry.source}`;
				return `### ${header}\n${entry.content}`;
			})
			.join("\n\n");
	}

	/**
	 * Record that an entry was accessed.
	 * Updates last_accessed timestamp and increments access_count.
	 *
	 * @param id The entry ID to record access for.
	 */
	recordAccess(id: string): void {
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) {
			return;
		}
		entry.last_accessed = new Date().toISOString();
		entry.access_count += 1;
		this.persistEntries();
	}

	/**
	 * Add a conversation turn (user prompt + assistant response) as a single entry.
	 *
	 * Auto-extracts tags via keyword extraction. Truncates content to 800 chars
	 * if longer.
	 *
	 * @param userPrompt The user's message.
	 * @param assistantResponse The assistant's reply.
	 * @param modelId The model that generated the response.
	 */
	addConversationTurn(userPrompt: string, assistantResponse: string, modelId: string): void {
		// Build combined content for tagging and storage
		const combinedText = `User: ${userPrompt}\nAssistant: ${assistantResponse}`;
		const tags = extractKeywords(combinedText, 12);

		// Truncate content to 800 chars
		const truncated = combinedText.length > 800
			? combinedText.slice(0, 800) + "..."
			: combinedText;

		const source = modelId ? `chat (${modelId})` : "chat";
		this.addEntry("conversation", source, truncated, tags);
	}

	/**
	 * Remove entries whose decay_score has fallen below the threshold.
	 *
	 * @param threshold Minimum decay_score to keep (default 0.05).
	 */
	pruneDecayed(threshold = 0.05): void {
		const before = this.entries.length;
		this.entries = this.entries.filter((e) => e.decay_score >= threshold);
		const removed = before - this.entries.length;
		if (removed > 0) {
			this.persistEntries();
		}
	}

	/** Get the raw file path to memory.md (for logging/debugging). */
	getFilePath(): string {
		return this.memoryFilePath;
	}

	/** Get all current entries (for debugging). */
	getAllEntries(): MemoryEntry[] {
		return [...this.entries];
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	/** Serialize all entries and write to memory.md. */
	private persistEntries(): void {
		const content = this.entries
			.map(serializeEntry)
			.join("\n");

		// Prepend a header comment
		const header = `# GropWave Memory\n# Generated: ${new Date().toISOString()}\n# Entries: ${this.entries.length}\n\n`;

		try {
			vscode.workspace.fs.writeFile(
				vscode.Uri.file(this.memoryFilePath),
				Buffer.from(header + content, "utf-8"),
			);
		} catch (err) {
			console.warn("[MemoryEngine] Failed to persist entries:", err);
		}
	}
}
