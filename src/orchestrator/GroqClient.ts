/**
 * GroqClient — thin wrapper around the groq-sdk that handles initialization
 * and exposes chat-completion streaming.
 */

import Groq from "groq-sdk";
import { OrchestratorConfig } from "./types";

export class GroqClient {
	private client: Groq;

	constructor(config: OrchestratorConfig) {
		this.client = new Groq({
			apiKey: config.apiKey || undefined,
			baseURL: config.baseUrl || undefined,
		});
	}

	/** Expose the raw client for the ModelRegistry to use. */
	get raw(): Groq {
		return this.client;
	}

	/**
	 * Send a chat completion request and return the full response text.
	 * Use streaming for real-time UI updates via `streamCompletion`.
	 */
	async complete(
		model: string,
		messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
		options?: { temperature?: number; max_tokens?: number },
	): Promise<string> {
		const response = await this.client.chat.completions.create({
			model,
			messages,
			temperature: options?.temperature ?? 0.1,
			max_tokens: options?.max_tokens,
		});

		return response.choices[0]?.message?.content ?? "";
	}

	/**
	 * Stream a chat completion. Calls `onChunk` for each delta and
	 * resolves with the full assembled text.
	 */
	async streamComplete(
		model: string,
		messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
		onChunk: (chunk: string) => void,
		options?: { temperature?: number; max_tokens?: number },
	): Promise<string> {
		const stream = await this.client.chat.completions.create({
			model,
			messages,
			temperature: options?.temperature ?? 0.1,
			max_tokens: options?.max_tokens,
			stream: true,
		});

		let fullText = "";
		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta?.content;
			if (delta) {
				fullText += delta;
				onChunk(delta);
			}
		}
		return fullText;
	}
}
