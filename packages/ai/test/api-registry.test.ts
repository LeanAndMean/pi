import { afterEach, describe, expect, it } from "vitest";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	flattenSystemPrompt,
	registerApiProvider,
	stream,
	streamSimple,
	unregisterApiProviders,
} from "../src/index.js";
import type { Context, Model, SystemPromptSection } from "../src/types.js";

const SOURCE_ID = "api-registry-test";

function makeModel(api: string): Model<string> {
	return {
		id: "capture-model",
		name: "Capture Model",
		api,
		provider: "capture-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function registerCaptureProvider(
	api: string,
	options?: { handlesSystemPromptSections?: boolean },
): { systemPrompt: Context["systemPrompt"] } {
	const captured: { systemPrompt: Context["systemPrompt"] } = { systemPrompt: undefined };
	const captureStream = (_model: Model<string>, context: Context) => {
		captured.systemPrompt = context.systemPrompt;
		const s = createAssistantMessageEventStream();
		s.end(fauxAssistantMessage("ok"));
		return s;
	};
	registerApiProvider(
		{
			api,
			stream: captureStream,
			streamSimple: captureStream,
			handlesSystemPromptSections: options?.handlesSystemPromptSections,
		},
		SOURCE_ID,
	);
	return captured;
}

const sections: SystemPromptSection[] = [
	{ id: "core", text: "You are a helpful assistant." },
	{ id: "volatile", text: "\n\nCurrent date: 2026-06-12", cacheRetention: "none" },
];

afterEach(() => {
	unregisterApiProviders(SOURCE_ID);
});

describe("registerApiProvider system prompt sections", () => {
	it("flattens a sections array for providers that do not declare handlesSystemPromptSections", async () => {
		const captured = registerCaptureProvider("capture-legacy");
		const context: Context = { systemPrompt: sections, messages: [] };

		await streamSimple(makeModel("capture-legacy"), context).result();

		expect(captured.systemPrompt).toBe(flattenSystemPrompt(sections));
		expect(typeof captured.systemPrompt).toBe("string");
		// The caller's context is untouched; only the dispatched copy is flattened.
		expect(context.systemPrompt).toBe(sections);
	});

	it("flattens on the stream entry point as well", async () => {
		const captured = registerCaptureProvider("capture-legacy-stream");
		const context: Context = { systemPrompt: sections, messages: [] };

		await stream(makeModel("capture-legacy-stream"), context).result();

		expect(captured.systemPrompt).toBe(flattenSystemPrompt(sections));
	});

	it("passes the sections array through verbatim when handlesSystemPromptSections is true", async () => {
		const captured = registerCaptureProvider("capture-sectioned", { handlesSystemPromptSections: true });
		const context: Context = { systemPrompt: sections, messages: [] };

		await streamSimple(makeModel("capture-sectioned"), context).result();

		expect(captured.systemPrompt).toBe(sections);
	});

	it("passes string prompts through unchanged for providers without the flag", async () => {
		const captured = registerCaptureProvider("capture-string");
		const context: Context = { systemPrompt: "Be concise.", messages: [] };

		await streamSimple(makeModel("capture-string"), context).result();

		expect(captured.systemPrompt).toBe("Be concise.");
	});
});
