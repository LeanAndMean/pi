import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import { streamGoogle } from "../src/providers/google.js";
import { streamGoogleVertex } from "../src/providers/google-vertex.js";
import { streamMistral } from "../src/providers/mistral.js";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, StreamOptions, SystemPromptSection } from "../src/types.js";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.js";
import { flattenSystemPrompt } from "../src/utils/system-prompt.js";

/**
 * Self-flatten coverage for the six built-in non-Anthropic providers.
 *
 * All built-ins set `handlesSystemPromptSections: true` in register-builtins.ts,
 * which bypasses the registry's `normalizeContext` flatten safety net
 * (api-registry.ts). Each provider is therefore individually responsible for
 * calling `flattenSystemPrompt` on a sectioned `Context.systemPrompt`. These
 * tests pass an actual `SystemPromptSection[]` through each provider's request
 * builder and assert the flattened string lands in the right payload field — if
 * a provider regresses to reading `context.systemPrompt` directly it would ship
 * `[object Object],...` with no failing test to catch it.
 *
 * Requests are captured via `onPayload`, which fires while building the request.
 * The callback records the payload and then throws a sentinel, so the provider
 * aborts before any network access — nothing leaves the machine.
 */

// openai-codex parses the API key as a JWT (extractAccountId) before it builds
// the request body, so a plausibly-structured token is needed to reach onPayload.
const codexClaim = JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } });
const fakeCodexToken = `header.${Buffer.from(codexClaim).toString("base64")}.signature`;

class CapturedPayload extends Error {
	constructor(readonly payload: unknown) {
		super("payload captured");
	}
}

const sections: SystemPromptSection[] = [
	{ id: "core", text: "You are pi, a helpful coding assistant." },
	{ id: "append", text: "\n\nAlways answer in haiku." },
	{ id: "volatile", text: "\nCurrent date: 2026-01-01\nCurrent working directory: /tmp", cacheRetention: "none" },
];

const expectedSystemPrompt = flattenSystemPrompt(sections);

function makeContext(): Context {
	return {
		systemPrompt: sections,
		messages: [{ role: "user", content: "Hello", timestamp: 1735689600000 }],
	};
}

async function capturePayload(
	run: (options: StreamOptions) => AssistantMessageEventStream,
	apiKey = "fake-key",
): Promise<unknown> {
	let captured: unknown;
	const stream = run({
		apiKey,
		onPayload: (payload) => {
			captured = payload;
			// Throw after capturing so the provider aborts before any network call.
			throw new CapturedPayload(payload);
		},
	});
	for await (const event of stream) {
		if (event.type === "error") break;
	}
	expect(captured).toBeDefined();
	return captured;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("built-in providers flatten sectioned system prompts", () => {
	it("openai-responses puts the flattened prompt in the leading system/developer message", async () => {
		const model = getModel("openai", "gpt-5-mini");
		const payload = await capturePayload((options) => streamOpenAIResponses(model, makeContext(), options));

		if (!isRecord(payload) || !Array.isArray(payload.input)) throw new Error("expected responses input array");
		const first = payload.input[0];
		if (!isRecord(first)) throw new Error("expected a leading input message");
		expect(first.role === "system" || first.role === "developer").toBe(true);
		expect(first.content).toBe(expectedSystemPrompt);
	});

	it("openai-codex-responses puts the flattened prompt in instructions", async () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const payload = await capturePayload(
			(options) => streamOpenAICodexResponses(model, makeContext(), options),
			fakeCodexToken,
		);

		if (!isRecord(payload)) throw new Error("expected codex payload");
		expect(payload.instructions).toBe(expectedSystemPrompt);
	});

	it("google-generative-ai puts the flattened prompt in config.systemInstruction", async () => {
		const model = getModel("google", "gemini-2.5-flash");
		const payload = await capturePayload((options) => streamGoogle(model, makeContext(), options));

		if (!isRecord(payload) || !isRecord(payload.config)) throw new Error("expected google config");
		expect(payload.config.systemInstruction).toBe(expectedSystemPrompt);
	});

	it("google-vertex puts the flattened prompt in config.systemInstruction", async () => {
		const model = getModel("google-vertex", "gemini-2.5-flash");
		const payload = await capturePayload((options) => streamGoogleVertex(model, makeContext(), options));

		if (!isRecord(payload) || !isRecord(payload.config)) throw new Error("expected vertex config");
		expect(payload.config.systemInstruction).toBe(expectedSystemPrompt);
	});

	it("mistral-conversations puts the flattened prompt in the leading system message", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const payload = await capturePayload((options) => streamMistral(model, makeContext(), options));

		if (!isRecord(payload) || !Array.isArray(payload.messages)) throw new Error("expected mistral messages");
		const first = payload.messages[0];
		if (!isRecord(first)) throw new Error("expected a leading mistral message");
		expect(first.role).toBe("system");
		expect(first.content).toBe(expectedSystemPrompt);
	});

	it("bedrock-converse-stream puts the flattened prompt in the leading system block", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const payload = await capturePayload((options) => streamBedrock(model, makeContext(), options));

		if (!isRecord(payload) || !Array.isArray(payload.system)) throw new Error("expected bedrock system blocks");
		const first = payload.system[0];
		if (!isRecord(first)) throw new Error("expected a leading bedrock system block");
		expect(first.text).toBe(expectedSystemPrompt);
	});
});
