/**
 * ContextEngine — manages the physical context.md file in the workspace.
 *
 * Responsibilities:
 *   - Read/write context.md from the workspace root.
 *   - Run /index: scan workspace files, use a lightweight LLM to generate
 *     per-file summaries (purpose, key functions, exports), and write to context.md.
 *   - Diff-based updates: as the user works, selectively regenerate sections
 *     of context.md for files that have changed.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { OrchestratorConfig } from "../orchestrator";
import { GroqClient } from "../orchestrator/GroqClient";

// ─── File summary structure ──────────────────────────────────────────────────

interface FileSummary {
	relativePath: string;
	/** One-sentence purpose of the file. */
	purpose: string;
	/** Key functions, classes, or exports. */
	keyElements: string[];
	/** Dependencies / imports of note. */
	dependencies: string[];
}

// ─── LLM provider interface ──────────────────────────────────────────────────
// ContextEngine needs an LLM to generate summaries, but we avoid a circular
// dependency with OrchestratorCore by accepting a minimal interface.

export interface LLMProvider {
	/**
	 * Call the LLM with a system+user prompt and return the full response.
	 * The provider should use whatever model is appropriate for the task.
	 */
	complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ─── ContextEngine class ─────────────────────────────────────────────────────

export class ContextEngine {
	private config: OrchestratorConfig;
	private context: vscode.ExtensionContext;
	private llm?: LLMProvider;

	/** Debounce: pending file paths waiting for the next debounce window. */
	private pendingUpdates = new Map<string, NodeJS.Timeout>();

	/** Debounce: files currently being processed by an in-flight LLM call. */
	private activeUpdates = new Set<string>();

	constructor(context: vscode.ExtensionContext, config: OrchestratorConfig, llm?: LLMProvider) {
		this.context = context;
		this.config = config;
		this.llm = llm;
	}

	/** Allow the LLM provider to be set after construction. */
	setLLMProvider(llm: LLMProvider): void {
		this.llm = llm;
	}

	/** Get the absolute path to context.md in the current workspace. */
	getContextPath(): string | undefined {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return undefined;
		}
		return path.join(workspaceRoot, this.config.contextFile);
	}

	/** Read the current contents of context.md. Returns empty string if not found. */
	readContext(): string {
		const filePath = this.getContextPath();
		if (!filePath) {
			return "";
		}
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return "";
		}
	}

	/** Write new contents to context.md. Creates the file if it doesn't exist. */
	async writeContext(content: string): Promise<void> {
		const filePath = this.getContextPath();
		if (!filePath) {
			vscode.window.showWarningMessage("No workspace folder open. Cannot write context.md.");
			return;
		}
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(filePath),
			Buffer.from(content, "utf-8"),
		);
	}

	/**
	 * Index the workspace: scan all relevant files, use a lightweight LLM model
	 * to generate per-file summaries, and write the full context.md.
	 */
	async indexWorkspace(): Promise<string> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			throw new Error("No workspace folder open.");
		}

		// Scan workspace files
		const files = await this.scanFiles(workspaceRoot);

		if (files.length === 0) {
			const empty = this.buildContextMarkdown([]);
			await this.writeContext(empty);
			return empty;
		}

		// If no LLM is available, fall back to file listing only
		if (!this.llm) {
			const summary = this.buildContextFallback(files);
			await this.writeContext(summary);
			return summary;
		}

		// Batch files into groups of 5 for parallel summarization
		const batchSize = 5;
		const allSummaries: FileSummary[] = [];

		for (let i = 0; i < files.length; i += batchSize) {
			const batch = files.slice(i, i + batchSize);
			const summaries = await Promise.all(
				batch.map((filePath) => this.summarizeFile(filePath, workspaceRoot)),
			);
			allSummaries.push(...summaries);

			// Report progress
			const progress = Math.min(i + batchSize, files.length);
			vscode.window.setStatusBarMessage(
				`Indexing: ${progress}/${files.length} files`,
				2000,
			);
		}

		const markdown = this.buildContextMarkdown(allSummaries);
		await this.writeContext(markdown);
		return markdown;
	}

	/**
	 * Update context.md for a specific file that has changed.
	 * Debounced: rapid successive calls for the same file are coalesced.
	 * Only regenerates the section for the given file rather than re-indexing.
	 */
	updateFile(filePath: string): void {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return;
		}

		// If no LLM, skip
		if (!this.llm) {
			return;
		}

		// If already processing this file, mark it as pending for a follow-up
		if (this.activeUpdates.has(filePath)) {
			this.scheduleUpdate(filePath);
			return;
		}

		// Debounce: cancel any existing pending timer for this file
		const existingTimer = this.pendingUpdates.get(filePath);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const timer = setTimeout(() => {
			this.pendingUpdates.delete(filePath);
			this.processFileUpdate(filePath, workspaceRoot);
		}, 2000); // 2-second debounce window

		this.pendingUpdates.set(filePath, timer);
	}

	/** Actually process a single file update (called after debounce). */
	private async processFileUpdate(filePath: string, workspaceRoot: string): Promise<void> {
		this.activeUpdates.add(filePath);

		try {
			const relative = vscode.workspace.asRelativePath(filePath);
			const summary = await this.summarizeFile(filePath, workspaceRoot);

			// Read current context.md
			const currentContext = this.readContext();
			if (!currentContext) {
				// No context yet — do a full index
				await this.indexWorkspace();
				return;
			}

			// Replace or append the section for this file
			const sectionHeader = `### \`${relative}\``;
			const newSection = this.formatFileSection(summary);

			const sectionStart = currentContext.indexOf(sectionHeader);
			let updated: string;
			if (sectionStart >= 0) {
				const afterStart = currentContext.slice(sectionStart + sectionHeader.length);
				const nextSectionMatch = afterStart.match(/\n(#{1,3} )/);
				if (nextSectionMatch) {
					const sectionEnd = sectionStart + sectionHeader.length + nextSectionMatch.index!;
					updated = currentContext.slice(0, sectionStart) + newSection + currentContext.slice(sectionEnd);
				} else {
					updated = currentContext.slice(0, sectionStart) + newSection;
				}
			} else {
				updated = currentContext.trimEnd() + "\n\n" + newSection;
			}

			await this.writeContext(updated);
		} catch (err) {
			console.warn(`[ContextEngine] Failed to update ${filePath}:`, err);
		} finally {
			this.activeUpdates.delete(filePath);

			// If another update was requested while we were processing,
			// schedule it again
			if (this.pendingUpdates.has(filePath)) {
				this.updateFile(filePath);
			}
		}
	}

	/** Schedule a re-update for a file that changed during active processing. */
	private scheduleUpdate(filePath: string): void {
		const existingTimer = this.pendingUpdates.get(filePath);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}
		const timer = setTimeout(() => {
			this.pendingUpdates.delete(filePath);
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				this.processFileUpdate(filePath, workspaceRoot);
			}
		}, 2000);
		this.pendingUpdates.set(filePath, timer);
	}

	// ─── Internal: file summarization ─────────────────────────────────────────

	/**
	 * Read a file's content and use the LLM to generate a structured summary.
	 */
	private async summarizeFile(absolutePath: string, workspaceRoot: string): Promise<FileSummary> {
		const relativePath = path.relative(workspaceRoot, absolutePath);

		let content: string;
		try {
			content = fs.readFileSync(absolutePath, "utf-8");
		} catch {
			return {
				relativePath,
				purpose: "Could not read file.",
				keyElements: [],
				dependencies: [],
			};
		}

		// Truncate very long files (focus on first 200 lines for summary)
		const lines = content.split("\n");
		const truncated = lines.slice(0, 200).join("\n");
		const isTruncated = lines.length > 200;

		const systemPrompt = [
			"You are a code analyzer. Given a source file, produce a concise structured summary.",
			"Respond ONLY with a JSON object in this exact format:",
			'{ "purpose": "one-sentence description", "keyElements": ["func1", "class2"], "dependencies": ["module1", "module2"] }',
			"Be specific. For keyElements, list function names, class names, and exported symbols.",
			"For dependencies, list important imported modules or packages.",
			"Keep purpose under 100 characters. List at most 8 key elements and 5 dependencies.",
		].join("\n");

		const userPrompt = [
			`File: ${relativePath}${isTruncated ? " (first 200 lines shown)" : ""}`,
			"",
			"```",
			truncated,
			"```",
			"",
			"Generate the JSON summary.",
		].join("\n");

		try {
			const response = await this.llm!.complete(systemPrompt, userPrompt);
			// Parse JSON from response (may have markdown wrapping)
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]) as {
					purpose: string;
					keyElements: string[];
					dependencies: string[];
				};
				return {
					relativePath,
					purpose: parsed.purpose || "No description provided.",
					keyElements: parsed.keyElements || [],
					dependencies: parsed.dependencies || [],
				};
			}
		} catch (err) {
			console.warn(`[ContextEngine] Failed to summarize ${relativePath}:`, err);
		}

		// Fallback if LLM call fails
		return {
			relativePath,
			purpose: `Source file (${lines.length} lines).`,
			keyElements: this.extractTopLevelNames(truncated),
			dependencies: this.extractImports(truncated),
		};
	}

	// ─── Internal: fallback (no LLM) ─────────────────────────────────────────

	private buildContextFallback(filePaths: string[]): string {
		const summaries: FileSummary[] = filePaths.map((fp) => {
			const relative = vscode.workspace.asRelativePath(fp);
			let content = "";
			try {
				content = fs.readFileSync(fp, "utf-8");
			} catch {
				content = "";
			}
			return {
				relativePath: relative,
				purpose: `Source file.`,
				keyElements: this.extractTopLevelNames(content),
				dependencies: this.extractImports(content),
			};
		});

		return this.buildContextMarkdown(summaries);
	}

	// ─── Internal: markdown generation ────────────────────────────────────────

	private buildContextMarkdown(summaries: FileSummary[]): string {
		const lines: string[] = [
			"# Workspace Context",
			"",
			`Generated: ${new Date().toISOString()}`,
			`Files indexed: ${summaries.length}`,
			"",
			"## File Structure",
			"",
		];

		for (const summary of summaries) {
			lines.push(`- \`${summary.relativePath}\` — ${summary.purpose}`);
		}

		lines.push("");
		lines.push("## Detailed Summaries");
		lines.push("");

		for (const summary of summaries) {
			lines.push(this.formatFileSection(summary));
		}

		return lines.join("\n");
	}

	private formatFileSection(summary: FileSummary): string {
		const lines: string[] = [];
		lines.push(`### \`${summary.relativePath}\``);
		lines.push("");
		lines.push(`**Purpose:** ${summary.purpose}`);
		lines.push("");

		if (summary.keyElements.length > 0) {
			lines.push("**Key elements:**");
			for (const el of summary.keyElements) {
				lines.push(`- \`${el}\``);
			}
			lines.push("");
		}

		if (summary.dependencies.length > 0) {
			lines.push("**Dependencies:**");
			for (const dep of summary.dependencies) {
				lines.push(`- \`${dep}\``);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	// ─── Internal: file scanning ──────────────────────────────────────────────

	/** Scan the workspace for indexable files (skip node_modules, .git, etc.). */
	private async scanFiles(_root: string): Promise<string[]> {
		const maxFiles = 200; // Cap to avoid overwhelming the LLM

		const allFiles = await vscode.workspace.findFiles(
			"**/*.{ts,js,tsx,jsx,py,go,rs,md,json,yaml,yml,toml,cfg,ini,html,css}",
			"{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/*.lock,**/package-lock.json}",
			maxFiles,
		);

		return allFiles.map((uri) => uri.fsPath);
	}

	// ─── Internal: regex-based extraction (fallback when LLM unavailable) ─────

	/** Extract top-level function/class/const names from source text. */
	private extractTopLevelNames(text: string): string[] {
		const names = new Set<string>();

		// Function declarations
		const funcRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
		for (const m of text.matchAll(funcRe)) {
			names.add(m[1]);
		}

		// Arrow / const function
		const arrowRe = /^(?:export\s+)?const\s+(\w+)\s*[:=]/gm;
		for (const m of text.matchAll(arrowRe)) {
			names.add(m[1]);
		}

		// Class declarations
		const classRe = /^(?:export\s+)?class\s+(\w+)/gm;
		for (const m of text.matchAll(classRe)) {
			names.add(m[1]);
		}

		// Python def
		const defRe = /^(?:async\s+)?def\s+(\w+)/gm;
		for (const m of text.matchAll(defRe)) {
			names.add(m[1]);
		}

		return [...names].slice(0, 15);
	}

	/** Extract import statements as dependency clues. */
	private extractImports(text: string): string[] {
		const deps = new Set<string>();

		// ES modules: import ... from "module"
		const esRe = /from\s+["']([^"']+)["']/g;
		for (const m of text.matchAll(esRe)) {
			// Only keep the package/root module (not relative paths)
			const mod = m[1];
			if (!mod.startsWith(".")) {
				deps.add(mod.split("/")[0]);
			}
		}

		// CommonJS: require("module")
		const reqRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
		for (const m of text.matchAll(reqRe)) {
			const mod = m[1];
			if (!mod.startsWith(".")) {
				deps.add(mod.split("/")[0]);
			}
		}

		// Python: import module / from module import
		const pyRe = /^(?:import|from)\s+(\w+)/gm;
		for (const m of text.matchAll(pyRe)) {
			deps.add(m[1]);
		}

		return [...deps].slice(0, 10);
	}
}
