/**
 * SystemPromptEngine — manages the physical system.md file and performs
 * selective feeding. Instead of sending the entire system.md to every LLM
 * call, it extracts only the sections relevant to the user's current task.
 *
 * Expected system.md format (sections separated by ## headers):
 *
 *   ## General Rules
 *   ...
 *
 *   ## Python Guidelines
 *   ...
 *
 *   ## Testing Standards
 *   ...
 *
 * The engine parses these sections and matches keywords from the user's
 * prompt to determine which sections are relevant.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { OrchestratorConfig } from "../orchestrator";

// ─── Section structure ──────────────────────────────────────────────────────

interface Section {
	heading: string;
	content: string;
	/** Keywords automatically associated with this section for matching. */
	keywords: string[];
}

// ─── Section-level keyword extraction ────────────────────────────────────────

/**
 * Extract representative keywords from a block of text.
 * Uses a simple approach: take all words, remove stopwords, return the
 * most distinctive ones (longer words are usually more meaningful).
 */
function extractKeywords(text: string, maxCount = 15): string[] {
	const stopwords = new Set([
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
		"must", "do", "does", "did", "done",
	]);

	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\s_\-+#./]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !stopwords.has(w));

	// Sort by length descending (longer words tend to be more specific)
	words.sort((a, b) => b.length - a.length);

	// Deduplicate
	const unique = [...new Set(words)];
	return unique.slice(0, maxCount);
}

// ─── Default system.md template ──────────────────────────────────────────────

const DEFAULT_SYSTEM_MD = `## General Rules

- Always read the user's request carefully and reference the workspace context (context.md) before responding.
- When writing code, prefer clear, idiomatic patterns appropriate for the language.
- Prefer small, focused functions over large monolithic blocks.
- When unsure about a file's contents, ask the user or use tool calls to inspect it.
- Never fabricate information about files you have not seen.
- When modifying code, use the \`<tool:edit_file>\` tool with the full updated content of the affected region.

## Code Style

- Use meaningful variable and function names. Avoid single-letter names except for loop indices.
- Add comments only when the intent is non-obvious; prefer self-documenting code.
- When generating TypeScript, use strict types — avoid \`any\` unless absolutely necessary.
- When generating Python, use type hints and follow PEP 8 conventions.
- Keep imports grouped logically: standard library, third-party, then local modules.

## Testing Standards

- When asked to write tests, match the project's existing test framework (Mocha, Jest, pytest, etc.).
- Write tests that cover the happy path and at least one edge case.
- Use descriptive test names that explain what is being verified.

## Terminal Usage

- When running commands, use the \`<tool:run_command>\` tool.
- Prefer non-destructive commands. Avoid \`rm -rf\`, \`dd\`, or similar without explicit user confirmation.
- When installing dependencies, always check the project's package manager (npm, yarn, pip, cargo, go mod) before running install commands.
`.trimStart();

// ─── SystemPromptEngine class ────────────────────────────────────────────────

export class SystemPromptEngine {
	private config: OrchestratorConfig;
	private sections: Section[] = [];
	private rawContent: string = "";

	constructor(config: OrchestratorConfig) {
		this.config = config;
	}

	/**
	 * Check if system.md exists in the workspace root. If not, create it
	 * with a sensible default template. Returns true if the file was created.
	 */
	static async ensureDefaultExists(config: OrchestratorConfig): Promise<boolean> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return false;
		}
		const filePath = path.join(workspaceRoot, config.systemFile);

		// Check if file already exists
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
			return false; // exists
		} catch {
			// File doesn't exist — create it
			await vscode.workspace.fs.writeFile(
				vscode.Uri.file(filePath),
				Buffer.from(DEFAULT_SYSTEM_MD, "utf-8"),
			);
			return true;
		}
	}

	/** Get the absolute path to system.md in the current workspace. */
	private getSystemPath(): string | undefined {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return undefined;
		}
		return path.join(workspaceRoot, this.config.systemFile);
	}

	/** Read and parse the system.md file. Returns true if found and parsed. */
	load(): boolean {
		const filePath = this.getSystemPath();
		if (!filePath) {
			this.sections = [];
			this.rawContent = "";
			return false;
		}

		try {
			this.rawContent = fs.readFileSync(filePath, "utf-8");
		} catch {
			this.sections = [];
			this.rawContent = "";
			return false;
		}

		this.sections = this.parseSections(this.rawContent);
		return true;
	}

	/**
	 * Reload from disk (call when system.md changes externally).
	 */
	reload(): boolean {
		return this.load();
	}

	/**
	 * Extract only the sections relevant to the user's prompt.
	 * This is the main entry point used by OrchestratorCore before
	 * dispatching to the LLM.
	 *
	 * @param prompt The user's prompt (used for keyword matching).
	 * @param contextContent Optional workspace context for additional matching.
	 * @returns A concatenated string of relevant sections, or empty string.
	 */
	extractRelevant(prompt: string, contextContent?: string): string {
		if (this.sections.length === 0) {
			return this.rawContent; // no sections — return as-is or empty
		}

		// Build a set of query keywords from the prompt + optional context
		const queryWords = new Set<string>();
		const promptWords = extractKeywords(prompt, 30);
		for (const w of promptWords) {
			queryWords.add(w);
		}

		// If context is provided (from context.md), add language/file clues
		if (contextContent) {
			const contextWords = extractKeywords(contextContent, 20);
			for (const w of contextWords) {
				queryWords.add(w);
			}
		}

		// Score each section by keyword overlap
		const scored = this.sections.map((section) => {
			let overlap = 0;
			for (const kw of section.keywords) {
				if (queryWords.has(kw)) {
					overlap++;
				}
			}
			// Also check if any query word appears in the section content
			for (const qw of queryWords) {
				if (section.content.toLowerCase().includes(qw)) {
					overlap += 0.5; // partial credit for content match
				}
			}
			return { section, score: overlap };
		});

		// Always include "general" or top-level rules sections
		const generalSection = this.sections.find((s) =>
			/general|rules?|guidelines?|standards?/i.test(s.heading),
		);

		// Take sections with score > 0, plus always the general section
		const relevant = scored
			.filter((s) => s.score > 0)
			.map((s) => s.section);

		if (generalSection && !relevant.includes(generalSection)) {
			relevant.unshift(generalSection);
		}

		// If nothing matched, fall back to the first section as a default
		if (relevant.length === 0 && this.sections.length > 0) {
			relevant.push(this.sections[0]);
		}

		// Build the output
		return relevant
			.map((s) => `## ${s.heading}\n${s.content.trim()}`)
			.join("\n\n");
	}

	/** Return all parsed sections (for debugging or full inclusion). */
	getAllSections(): Section[] {
		return this.sections;
	}

	/** Return the raw system.md content. */
	getRawContent(): string {
		return this.rawContent;
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	/** Parse the raw system.md into sections based on ## headers. */
	private parseSections(content: string): Section[] {
		const lines = content.split("\n");
		const sections: Section[] = [];
		let currentHeading = "";
		let currentLines: string[] = [];

		const flushSection = () => {
			if (currentHeading && currentLines.length > 0) {
				const text = currentLines.join("\n").trim();
				sections.push({
					heading: currentHeading,
					content: text,
					keywords: extractKeywords(text),
				});
			}
		};

		for (const line of lines) {
			const headingMatch = line.match(/^##\s+(.+)$/);
			if (headingMatch) {
				flushSection();
				currentHeading = headingMatch[1].trim();
				currentLines = [];
			} else {
				currentLines.push(line);
			}
		}
		flushSection(); // don't forget the last section

		return sections;
	}
}
