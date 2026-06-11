import type { MessageCreateParamsStreaming, TextBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, StreamOptions, SystemPromptSection } from "../src/types.js";
import { flattenSystemPrompt } from "../src/utils/system-prompt.js";

/**
 * Payload-shape tests for sectioned system prompts on the Anthropic adapter.
 * Requests are captured via onPayload, which fires while building the request;
 * the fake base URL has no reachable endpoint, so nothing leaves the machine.
 */

const sections: SystemPromptSection[] = [
	{ id: "core", text: "You are pi, a helpful coding assistant." },
	{ id: "append", text: "\n\nAlways answer in haiku." },
	{ id: "volatile", text: "\nCurrent date: 2026-01-01\nCurrent working directory: /tmp", cacheRetention: "none" },
];

function makeContext(systemPrompt: Context["systemPrompt"]): Context {
	return {
		systemPrompt,
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	context: Context,
	options?: Partial<StreamOptions> & { apiKey?: string },
): Promise<MessageCreateParamsStreaming> {
	const model = { ...getModel("anthropic", "claude-haiku-4-5"), baseUrl: "https://my-proxy.example.com/v1" };
	let captured: MessageCreateParamsStreaming | null = null;

	try {
		const s = streamAnthropic(model, context, {
			apiKey: "fake-key",
			...options,
			onPayload: (payload) => {
				captured = payload as MessageCreateParamsStreaming;
			},
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}
	} catch {
		// Expected to fail: no reachable endpoint behind the fake base URL
	}

	expect(captured).not.toBeNull();
	if (captured === null) throw new Error("unreachable");
	return captured;
}

function systemBlocks(payload: MessageCreateParamsStreaming): TextBlockParam[] {
	if (!Array.isArray(payload.system)) throw new Error("expected system to be a block array");
	return payload.system;
}

function countBreakpoints(payload: MessageCreateParamsStreaming): number {
	let count = 0;
	for (const block of systemBlocks(payload)) {
		if (block.cache_control) count++;
	}
	for (const tool of payload.tools ?? []) {
		if ("cache_control" in tool && tool.cache_control) count++;
	}
	for (const message of payload.messages) {
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if ("cache_control" in block && block.cache_control) count++;
			}
		}
	}
	return count;
}

describe("Anthropic sectioned system blocks", () => {
	it("keeps the legacy string prompt as a single cached block", async () => {
		const payload = await capturePayload(makeContext("You are a helpful assistant."));

		const blocks = systemBlocks(payload);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("You are a helpful assistant.");
		expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("folds stable sections into one cached block and trails volatile sections uncached", async () => {
		const payload = await capturePayload(makeContext(sections));

		const blocks = systemBlocks(payload);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toBe("You are pi, a helpful coding assistant.\n\nAlways answer in haiku.");
		expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
		expect(blocks[1].text).toBe("\nCurrent date: 2026-01-01\nCurrent working directory: /tmp");
		expect(blocks[1].cache_control).toBeUndefined();
	});

	it("keeps the OAuth identity block first with a single system breakpoint, under the 4-breakpoint budget", async () => {
		const context = makeContext(sections);
		context.tools = [
			{
				name: "get_weather",
				description: "Get the weather",
				parameters: Type.Object({ city: Type.String() }),
			},
		];
		const payload = await capturePayload(context, { apiKey: "sk-ant-oat-fake" });

		const blocks = systemBlocks(payload);
		expect(blocks).toHaveLength(3);
		expect(blocks[0].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(blocks[0].cache_control).toBeUndefined();
		expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
		expect(blocks[2].cache_control).toBeUndefined();
		expect(blocks.filter((b) => b.cache_control).length).toBe(1);
		// system(1) + last tool(1) + last user message(1)
		expect(countBreakpoints(payload)).toBeLessThanOrEqual(4);
		expect(countBreakpoints(payload)).toBe(3);
	});

	it("keeps the legacy string + OAuth shape unchanged: identity and prompt blocks both cached", async () => {
		const payload = await capturePayload(makeContext("You are pi."), { apiKey: "sk-ant-oat-fake" });

		const blocks = systemBlocks(payload);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
		expect(blocks[1].text).toBe("You are pi.");
		expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
	});

	it("caches the OAuth identity block when no stable sections exist", async () => {
		const volatileOnly = sections.filter((s) => s.cacheRetention === "none");
		const payload = await capturePayload(makeContext(volatileOnly), { apiKey: "sk-ant-oat-fake" });

		const blocks = systemBlocks(payload);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
		expect(blocks[1].cache_control).toBeUndefined();
	});

	it("applies ttl 1h to the stable block when cacheRetention is long", async () => {
		const payload = await capturePayload(makeContext(sections), { cacheRetention: "long" });

		const blocks = systemBlocks(payload);
		expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(blocks[1].cache_control).toBeUndefined();
	});

	it("emits no breakpoints when cacheRetention is none", async () => {
		const payload = await capturePayload(makeContext(sections), { cacheRetention: "none" });

		const blocks = systemBlocks(payload);
		expect(blocks).toHaveLength(2);
		expect(countBreakpoints(payload)).toBe(0);
	});

	it("omits the system field entirely for an empty section array", async () => {
		const payload = await capturePayload(makeContext([]));

		expect(payload.system).toBeUndefined();
	});

	it("preserves array order for interleaved stable and volatile sections", async () => {
		const interleaved: SystemPromptSection[] = [
			{ id: "core", text: "You are pi." },
			{ id: "ext-volatile", text: "\n\nPer-turn context", cacheRetention: "none" },
			{ id: "ext-stable", text: "\n\nLate stable directives" },
			{ id: "volatile", text: "\nCurrent date: 2026-01-01", cacheRetention: "none" },
		];
		const payload = await capturePayload(makeContext(interleaved));

		const blocks = systemBlocks(payload);
		expect(blocks.map((b) => b.text)).toEqual([
			"You are pi.",
			"\n\nPer-turn context",
			"\n\nLate stable directives",
			"\nCurrent date: 2026-01-01",
		]);
		// Only the leading stable run is cached; everything from the first
		// volatile section onward trails uncached in array order.
		expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
		expect(blocks.slice(1).every((b) => b.cache_control === undefined)).toBe(true);
		// Concatenated block text matches what every other provider sends.
		expect(blocks.map((b) => b.text).join("")).toBe(flattenSystemPrompt(interleaved));
	});

	it("emits only uncached blocks when the first section is volatile", async () => {
		const volatileFirst: SystemPromptSection[] = [
			{ id: "ext-volatile", text: "Per-turn context", cacheRetention: "none" },
			{ id: "late-stable", text: "\n\nStable directives" },
		];
		const payload = await capturePayload(makeContext(volatileFirst));

		const blocks = systemBlocks(payload);
		expect(blocks.map((b) => b.text)).toEqual(["Per-turn context", "\n\nStable directives"]);
		expect(blocks.every((b) => b.cache_control === undefined)).toBe(true);
		expect(blocks.map((b) => b.text).join("")).toBe(flattenSystemPrompt(volatileFirst));
	});

	it("skips empty-text sections", async () => {
		const withEmpty: SystemPromptSection[] = [
			{ id: "core", text: "You are pi." },
			{ id: "append", text: "" },
			{ id: "volatile", text: "", cacheRetention: "none" },
		];
		const payload = await capturePayload(makeContext(withEmpty));

		const blocks = systemBlocks(payload);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("You are pi.");
		expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
	});
});
