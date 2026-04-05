/**
 * ActiveFileTracker — tracks the file, class, and function the user is
 * currently editing so the AI knows what they're working on.
 *
 * Listens to:
 *   - vscode.window.onDidChangeActiveTextEditor
 *   - vscode.window.onDidChangeTextEditorSelection
 *
 * Parses the document around the cursor to find:
 *   - Current file path
 *   - Current line number
 *   - Enclosing class name (if any)
 *   - Enclosing function name (if any)
 *
 * Exposes:
 *   - getActiveContext() — human-readable summary of current editing location
 *   - getActiveContextRaw() — structured object for programmatic use
 */

import * as vscode from "vscode";

export interface ActiveContext {
	filePath: string;
	fileName: string;
	line: number;
	column: number;
	className: string | null;
	functionName: string | null;
	language: string;
}

export class ActiveFileTracker {
	private currentContext: ActiveContext | null = null;
	private disposables: vscode.Disposable[] = [];
	private _onDidChange = new vscode.EventEmitter<ActiveContext | null>();

	/** Fires whenever the active context changes (editor, selection, or cursor). */
	get onDidChange(): vscode.Event<ActiveContext | null> {
		return this._onDidChange.event;
	}

	constructor() {
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.update()),
			vscode.window.onDidChangeTextEditorSelection(() => this.update()),
			this._onDidChange,
		);

		// Capture initial state
		this.update();
	}

	/** Clean up event listeners. */
	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
	}

	/** Get the current active context (or null if not editing). */
	getActiveContext(): string | null {
		if (!this.currentContext) {
			return null;
		}
		return this.formatContext(this.currentContext);
	}

	/** Get a compact one-line display string for the sidebar status. */
	getCompactDisplay(): string | null {
		if (!this.currentContext) {
			return null;
		}
		const c = this.currentContext;
		const scope = c.functionName
			? `${c.functionName}()`
			: c.className
				? `class ${c.className}`
				: "";
		const scopePart = scope ? ` → ${scope}` : "";
		return `${c.fileName}${scopePart} :${c.line}`;
	}

	/** Get raw structured context object. */
	getActiveContextRaw(): ActiveContext | null {
		return this.currentContext;
	}

	/** Update the active context from the current editor state. */
	private update(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			if (this.currentContext !== null) {
				this.currentContext = null;
				this._onDidChange.fire(null);
			}
			return;
		}

		const document = editor.document;
		const position = editor.selection.active;
		const text = document.getText();
		const lines = text.split("\n");

		const className = this.findEnclosingClass(lines, position.line, this.detectLanguage(document));
		const functionName = this.findEnclosingFunction(lines, position.line, this.detectLanguage(document));

		this.currentContext = {
			filePath: document.uri.fsPath,
			fileName: vscode.workspace.asRelativePath(document.uri),
			line: position.line + 1, // 1-based
			column: position.character + 1,
			className,
			functionName,
			language: this.detectLanguage(document),
		};
		this._onDidChange.fire(this.currentContext);
	}

	/** Format active context into a human-readable string for the AI. */
	private formatContext(ctx: ActiveContext): string {
		const parts: string[] = [];

		parts.push(`Currently editing: \`${ctx.fileName}\` (line ${ctx.line})`);

		if (ctx.className) {
			parts.push(`  Inside class: \`${ctx.className}\``);
		}
		if (ctx.functionName) {
			parts.push(`  Inside function: \`${ctx.functionName}\``);
		}
		if (ctx.language) {
			parts.push(`  Language: ${ctx.language}`);
		}

		return parts.join("\n");
	}

	/** Detect the language from the document's languageId or extension. */
	private detectLanguage(document: vscode.TextDocument): string {
		const langMap: Record<string, string> = {
			typescript: "TypeScript",
			javascript: "JavaScript",
			python: "Python",
			go: "Go",
			rust: "Rust",
			java: "Java",
			cpp: "C++",
			c: "C",
			csharp: "C#",
			html: "HTML",
			css: "CSS",
			json: "JSON",
			yaml: "YAML",
			markdown: "Markdown",
		};
		return langMap[document.languageId] || document.languageId;
	}

	/**
	 * Find the enclosing class name for a given line number.
	 * Supports: TypeScript/JavaScript (class X {}), Python (class X:).
	 */
	private findEnclosingClass(lines: string[], targetLine: number, language: string): string | null {
		const classPattern = language === "Python"
			? /^\s*class\s+(\w+)/
			: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/;

		// Track brace-based classes for TS/JS
		if (language === "TypeScript" || language === "JavaScript") {
			return this.findEnclosingClassBraces(lines, targetLine, classPattern);
		}

		// For Python: find the nearest class declaration above with matching or less indent
		if (language === "Python") {
			let currentClass: string | null = null;
			let classIndent = -1;

			for (let i = 0; i < targetLine; i++) {
				const match = lines[i].match(classPattern);
				if (match) {
					const indent = lines[i].search(/\S/);
					// Only update if this class is at the same or lesser indent level
					if (indent <= classIndent || classIndent === -1) {
						currentClass = match[1];
						classIndent = indent;
					}
				}
			}
			return currentClass;
		}

		// Generic: just find the nearest class declaration above
		for (let i = targetLine - 1; i >= Math.max(0, targetLine - 50); i--) {
			const match = lines[i].match(classPattern);
			if (match) {return match[1];}
		}
		return null;
	}

	/** Find enclosing class using brace tracking for TS/JS/C-style languages. */
	private findEnclosingClassBraces(
		lines: string[],
		targetLine: number,
		classPattern: RegExp,
	): string | null {
		// Scan upward to find a class declaration, then track braces
		for (let i = targetLine - 1; i >= Math.max(0, targetLine - 100); i--) {
			const line = lines[i].trim();
			const match = lines[i].match(classPattern);

			if (match && (line.endsWith("{") || line.includes("implements") || line.includes("extends"))) {
				// Found a class declaration — verify we're inside its braces
				let braceCount = 0;
				for (let j = i; j < targetLine; j++) {
					for (const ch of lines[j]) {
						if (ch === "{") {braceCount++;}
						if (ch === "}") {braceCount--;}
					}
				}
				if (braceCount > 0) {
					return match[1];
				}
			}
		}
		return null;
	}

	/**
	 * Find the enclosing function name for a given line number.
	 * Supports: TypeScript/JavaScript, Python.
	 */
	private findEnclosingFunction(lines: string[], targetLine: number, language: string): string | null {
		if (language === "Python") {
			return this.findEnclosingPythonFunction(lines, targetLine);
		}

		// TypeScript / JavaScript / C-style
		return this.findEnclosingCStyleFunction(lines, targetLine);
	}

	/** Find enclosing function in Python (def keyword). */
	private findEnclosingPythonFunction(lines: string[], targetLine: number): string | null {
		const defPattern = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/;
		let currentFunc: string | null = null;
		let funcIndent = -1;

		for (let i = 0; i < targetLine; i++) {
			const match = lines[i].match(defPattern);
			if (match) {
				const indent = lines[i].search(/\S/);
				if (indent <= funcIndent || funcIndent === -1) {
					currentFunc = match[1];
					funcIndent = indent;
				}
			}
		}
		return currentFunc;
	}

	/** Find enclosing function in C-style languages using brace tracking. */
	private findEnclosingCStyleFunction(lines: string[], targetLine: number): string | null {
		const funcPatterns = [
			/^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+(\w+)/,
			/^\s*(?:private|public|protected|static)\s+(?:async\s+)?(?:function\s+)?(\w+)\s*\(/,
			/^\s*(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{/, // method signature
			/^\s*(\w+)\s*=\s*(?:async\s+)?\(/, // arrow function assigned to const
		];

		// Scan upward and track braces
		let braceCount = 0;
		for (let i = targetLine - 1; i >= Math.max(0, targetLine - 100); i--) {
			const line = lines[i];

			// Count braces
			for (const ch of line) {
				if (ch === "}") {braceCount++;}
				if (ch === "{") {
					braceCount--;
					// We exited a scope — check if the line above is a function
					if (braceCount === 0) {
						for (const pattern of funcPatterns) {
							const match = lines[i].match(pattern);
							if (match) {return match[1];}
						}
					}
				}
			}
		}
		return null;
	}

	/** Dispose the tracker (called on extension deactivation). */
	static createAndAttach(context: vscode.ExtensionContext): ActiveFileTracker {
		const tracker = new ActiveFileTracker();
		context.subscriptions.push({ dispose: () => tracker.dispose() });
		return tracker;
	}
}
