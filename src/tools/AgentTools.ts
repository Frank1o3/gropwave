/**
 * AgentTools — agentic capabilities exposed to the LLM during chat.
 *
 * Provides:
 *   1. Terminal execution — run shell commands, capture output.
 *   2. Safe file editing — apply diffs via vscode.WorkspaceEdit so they
 *      integrate with VS Code's native undo/redo stack.
 *   3. Tool-call parsing — extract XML-style tags from LLM responses.
 *
 *   <tool:run_command>npm test</tool:run_command>
 *   <tool:edit_file path="src/foo.ts">...full content...</tool:edit_file>
 */

import * as vscode from "vscode";

// ─── Terminal Execution ──────────────────────────────────────────────────────

export interface TerminalResult {
	command: string;
	exitCode: number | undefined;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Dangerous command patterns that trigger a block. */
const DANGEROUS_COMMAND_PATTERNS = [
	/\brm\s+(-rf?|--recursive)\b/i,
	/\bdd\s/i,
	/\bmkfs\./i,
	/\bsudo\s+(rm|dd|mkfs|chmod|chown)\b/i,
	/>\/dev\/sd/i,
	/\bshred\b/i,
];

export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function runCommandSync(
	command: string,
	options?: { cwd?: string; timeout?: number },
): Promise<TerminalResult> {
	return new Promise((resolve) => {
		const { exec } = require("child_process");
		const cwd = options?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const timeout = options?.timeout ?? 30000;

		exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (
			error: Error | null,
			stdout: string,
			stderr: string,
		) => {
			resolve({
				command,
				exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
				stdout: stdout.toString(),
				stderr: stderr.toString(),
				timedOut: error?.message?.includes("timed out") ?? false,
			});
		});
	});
}

// ─── Safe File Editing ───────────────────────────────────────────────────────

export interface FileEditResult {
	success: boolean;
	message: string;
}

export async function editFileContent(
	filePath: string,
	newContent: string,
): Promise<FileEditResult> {
	const uri = vscode.Uri.file(filePath);

	try {
		const currentDoc = await vscode.workspace.openTextDocument(uri);
		if (currentDoc.getText() === newContent) {
			return { success: true, message: "No changes — file content is identical." };
		}

		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			currentDoc.positionAt(0),
			currentDoc.positionAt(currentDoc.getText().length),
		);
		edit.replace(uri, fullRange, newContent);

		const success = await vscode.workspace.applyEdit(edit, { isRefactoring: false });
		if (!success) {
			return { success: false, message: "Workspace edit was rejected." };
		}

		await currentDoc.save();
		return { success: true, message: `Updated ${vscode.workspace.asRelativePath(filePath)}` };
	} catch (err: unknown) {
		if (err instanceof vscode.FileSystemError) {
			return await createFileContent(filePath, newContent);
		}
		return { success: false, message: `Edit failed: ${String(err)}` };
	}
}

async function createFileContent(filePath: string, content: string): Promise<FileEditResult> {
	const uri = vscode.Uri.file(filePath);

	try {
		const edit = new vscode.WorkspaceEdit();
		edit.createFile(uri, {
			overwrite: false,
			contents: new Uint8Array(Buffer.from(content, "utf-8")),
		});
		const success = await vscode.workspace.applyEdit(edit);
		if (!success) {
			return { success: false, message: `Failed to create ${vscode.workspace.asRelativePath(filePath)}` };
		}
		return { success: true, message: `Created ${vscode.workspace.asRelativePath(filePath)}` };
	} catch (err: unknown) {
		return { success: false, message: `Create failed: ${String(err)}` };
	}
}

// ─── Tool Call Parser ────────────────────────────────────────────────────────

export interface ParsedToolCall {
	type: "run_command" | "edit_file";
	payload: string;
	targetPath?: string;
}

export function parseToolCalls(response: string): ParsedToolCall[] {
	const calls: ParsedToolCall[] = [];

	const commandRegex = /<tool:run_command>([\s\S]*?)<\/tool:run_command>/g;
	let match: RegExpExecArray | null;
	while ((match = commandRegex.exec(response)) !== null) {
		calls.push({ type: "run_command", payload: match[1].trim() });
	}

	const editRegex = /<tool:edit_file\s+path="([^"]+)">([\s\S]*?)<\/tool:edit_file>/g;
	while ((match = editRegex.exec(response)) !== null) {
		calls.push({ type: "edit_file", payload: match[2].trim(), targetPath: match[1] });
	}

	return calls;
}

export async function executeToolCalls(calls: ParsedToolCall[]): Promise<string[]> {
	const results: string[] = [];

	for (const call of calls) {
		switch (call.type) {
			case "run_command": {
				if (isDangerousCommand(call.payload)) {
					results.push(`Command blocked (dangerous): ${call.payload}\nPlease confirm with the user before running destructive commands.`);
					break;
				}
				const result = await runCommandSync(call.payload);
				results.push(`Command: ${call.payload}\nExit: ${result.exitCode}\nStdout: ${result.stdout}\nStderr: ${result.stderr}`);
				break;
			}
			case "edit_file": {
				if (!call.targetPath) {
					results.push("Edit failed: no path provided");
					continue;
				}
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				const fullPath = call.targetPath.startsWith("/")
					? call.targetPath
					: `${workspaceRoot}/${call.targetPath}`;
				const result = await editFileContent(fullPath, call.payload);
				results.push(`Edit ${call.targetPath}: ${result.message}`);
				break;
			}
		}
	}

	return results;
}
