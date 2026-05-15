/**
 * Path utilities for the GropWave extension.
 *
 * All extension-managed files (context.md, system.md, memory.md) live in
 * `.cache/gropwave/` under the workspace root to keep the workspace clean.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * Returns the absolute path to `.cache/gropwave/` in the current workspace root.
 * Creates the directory if it does not exist.
 * Returns undefined if no workspace is open.
 */
export function getCacheDir(): string | undefined {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {return undefined;}
	const dir = path.join(root, ".cache", "gropwave");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * Returns the absolute path to a named file inside `.cache/gropwave/`.
 *
 * @param filename The file name (e.g. "context.md", "system.md").
 * @returns The absolute path, or undefined if no workspace is open.
 */
export function getCacheFilePath(filename: string): string | undefined {
	const dir = getCacheDir();
	if (!dir) {return undefined;}
	return path.join(dir, filename);
}
