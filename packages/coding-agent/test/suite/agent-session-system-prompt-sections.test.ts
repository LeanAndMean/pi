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

describe("AgentSession extension-contributed sections", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("places a contributed section before the volatile tail and inside the cached prefix", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPromptSection: { id: "ext-base", text: "\n\nExtension directives" },
					}));
				},
			],
		});
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);

		await harness.session.prompt("hello");

		expect(Array.isArray(captured.current)).toBe(true);
		const sections = captured.current as SystemPromptSection[];
		const extIndex = sections.findIndex((s) => s.id === "ext-base");
		const volatileIndex = sections.findIndex((s) => s.id === "volatile");
		expect(extIndex).toBeGreaterThan(-1);
		expect(volatileIndex).toBe(sections.length - 1);
		expect(extIndex).toBe(volatileIndex - 1);
		// Not marked volatile, so the section is part of the cached stable prefix.
		expect(sections[extIndex]!.cacheRetention).not.toBe("none");
		expect(harness.session.systemPrompt).toContain("Extension directives");
	});

	it("accumulates sections from multiple extensions in load order", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPromptSection: { id: "ext-one", text: "\n\none" },
					}));
				},
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPromptSection: { id: "ext-two", text: "\n\ntwo" },
					}));
				},
			],
		});
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);

		await harness.session.prompt("hello");

		const sections = captured.current as SystemPromptSection[];
		const ids = sections.map((s) => s.id);
		const oneIndex = ids.indexOf("ext-one");
		expect(oneIndex).toBeGreaterThan(-1);
		expect(ids[oneIndex + 1]).toBe("ext-two");
		expect(ids[ids.length - 1]).toBe("volatile");
	});

	it("drops contributed sections when another extension returns a string replacement", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPromptSection: { id: "ext-dropped", text: "\n\ndropped" },
					}));
				},
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPrompt: "authoritative replacement",
					}));
				},
			],
		});
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);

		await harness.session.prompt("hello");

		expect(captured.current).toBe("authoritative replacement");
		expect(harness.session.systemPrompt).toBe("authoritative replacement");
	});

	it("treats an empty-string replacement as authoritative over contributed sections", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPromptSection: { id: "ext-dropped", text: "\n\ndropped" },
					}));
				},
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPrompt: "",
					}));
				},
			],
		});
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);

		await harness.session.prompt("hello");

		expect(captured.current).toBe("");
		expect(harness.session.systemPrompt).toBe("");
	});

	it("exposes earlier contributed sections to later handlers via event.systemPrompt and ctx.getSystemPrompt", async () => {
		let seenEventPrompt = "";
		let seenCtxPrompt = "";
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPromptSection: { id: "ext-early", text: "\n\nEarly directives" },
					}));
				},
				(pi) => {
					pi.on("before_agent_start", async (event, ctx) => {
						seenEventPrompt = event.systemPrompt;
						seenCtxPrompt = ctx.getSystemPrompt();
					});
				},
			],
		});
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);

		await harness.session.prompt("hello");

		expect(seenEventPrompt).toContain("Early directives");
		expect(seenCtxPrompt).toContain("Early directives");
		// The chained prompt matches the flattened sections actually sent.
		expect(seenEventPrompt).toBe(flattenSystemPrompt(captured.current as SystemPromptSection[]));
	});

	it("splices into a fresh copy each turn so sections do not accumulate", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPromptSection: { id: "ext-fresh", text: "\n\nfresh" },
					}));
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

		const firstTurn = capturedPrompts[0] as SystemPromptSection[];
		const secondTurn = capturedPrompts[1] as SystemPromptSection[];
		expect(firstTurn.filter((s) => s.id === "ext-fresh")).toHaveLength(1);
		expect(secondTurn.filter((s) => s.id === "ext-fresh")).toHaveLength(1);
		expect(secondTurn.map((s) => s.id)).toEqual(firstTurn.map((s) => s.id));
	});
});
