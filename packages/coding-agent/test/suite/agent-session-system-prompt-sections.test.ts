import type { Context, SystemPromptSection } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, flattenSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

function captureSystemPrompt(harness: Harness): { current: Context["systemPrompt"] } {
	const captured: { current: Context["systemPrompt"] } = { current: undefined };
	harness.setResponses([
		(context) => {
			captured.current = context.systemPrompt;
			return fauxAssistantMessage("done");
		},
	]);
	return captured;
}

describe("AgentSession sectioned system prompt", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("sends the provider ordered sections with the volatile tail last", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);

		await harness.session.prompt("hello");

		expect(captured.current).toBeDefined();
		expect(Array.isArray(captured.current)).toBe(true);
		const sections = captured.current as SystemPromptSection[];
		expect(sections.length).toBeGreaterThanOrEqual(2);
		expect(sections[0]!.id).toBe("core");

		const volatile = sections[sections.length - 1]!;
		expect(volatile.id).toBe("volatile");
		expect(volatile.cacheRetention).toBe("none");
		expect(volatile.text).toContain("Current date:");
		expect(volatile.text).toContain("Current working directory:");

		const stableSections = sections.slice(0, -1);
		for (const section of stableSections) {
			expect(section.cacheRetention).not.toBe("none");
		}
	});

	it("flattens sections in the session systemPrompt getter", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);

		await harness.session.prompt("hello");

		const sections = captured.current as SystemPromptSection[];
		expect(typeof harness.session.systemPrompt).toBe("string");
		expect(harness.session.systemPrompt).toBe(flattenSystemPrompt(sections));
		expect(harness.session.systemPrompt).toContain("Current working directory:");
	});

	it("keeps an extension string replacement as a plain string prompt for that turn", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPrompt: "replaced prompt",
					}));
				},
			],
		});
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);

		await harness.session.prompt("hello");

		expect(captured.current).toBe("replaced prompt");
		expect(harness.session.systemPrompt).toBe("replaced prompt");
	});

	it("resets to the base sections on the next turn after a string replacement", async () => {
		let replaceOnce = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (replaceOnce) {
							replaceOnce = false;
							return { systemPrompt: "replaced prompt" };
						}
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);

		const capturedPrompts: Array<Context["systemPrompt"]> = [];
		harness.setResponses([
			(context) => {
				capturedPrompts.push(context.systemPrompt);
				return fauxAssistantMessage("first");
			},
			(context) => {
				capturedPrompts.push(context.systemPrompt);
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("hello");
		await harness.session.prompt("again");

		expect(capturedPrompts[0]).toBe("replaced prompt");
		expect(Array.isArray(capturedPrompts[1])).toBe(true);
		const sections = capturedPrompts[1] as SystemPromptSection[];
		expect(sections[sections.length - 1]!.id).toBe("volatile");
	});
});
