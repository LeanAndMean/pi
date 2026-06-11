import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheRetention, Context, Model, SystemPromptSection } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, flattenSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

/** Shape of the Anthropic request payload fields asserted by these tests. */
interface CapturedAnthropicPayload {
	system?: Array<{ text: string; cache_control?: { type: string; ttl?: string } }>;
}

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

async function promptForSections(harness: Harness): Promise<SystemPromptSection[]> {
	const captured = captureSystemPrompt(harness);
	await harness.session.prompt("hello");
	expect(Array.isArray(captured.current)).toBe(true);
	return captured.current as SystemPromptSection[];
}

describe("regression #1: sectioned / cache-aware system prompt", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("builds ordered sections with the volatile environment tail isolated last", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const sections = await promptForSections(harness);

		expect(sections.length).toBeGreaterThanOrEqual(2);
		expect(sections[0]!.id).toBe("core");

		const volatile = sections[sections.length - 1]!;
		expect(volatile.id).toBe("volatile");
		expect(volatile.cacheRetention).toBe("none");
		expect(volatile.text).toContain("Current date:");
		expect(volatile.text).toContain("Current working directory:");

		for (const section of sections.slice(0, -1)) {
			expect(section.cacheRetention).not.toBe("none");
			expect(section.text).not.toContain("Current date:");
			expect(section.text).not.toContain("Current working directory:");
		}
	});

	it("flattens the provider sections to the legacy string surface", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const sections = await promptForSections(harness);

		expect(typeof harness.session.systemPrompt).toBe("string");
		expect(harness.session.systemPrompt).toBe(flattenSystemPrompt(sections));
	});

	it("keeps the legacy extension string replacement working", async () => {
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

	it("places an extension-contributed section immediately before the volatile tail", async () => {
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

		const sections = await promptForSections(harness);

		const extIndex = sections.findIndex((section) => section.id === "ext-base");
		const volatileIndex = sections.findIndex((section) => section.id === "volatile");
		expect(extIndex).toBeGreaterThan(-1);
		expect(volatileIndex).toBe(sections.length - 1);
		expect(extIndex).toBe(volatileIndex - 1);
		expect(sections[extIndex]!.cacheRetention).not.toBe("none");
	});
});

describe("regression #1: Anthropic payload cache tiers", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalCacheRetentionEnv: string | undefined;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-regression-1-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		originalCacheRetentionEnv = process.env.PI_CACHE_RETENTION;
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalCacheRetentionEnv === undefined) {
			delete process.env.PI_CACHE_RETENTION;
		} else {
			process.env.PI_CACHE_RETENTION = originalCacheRetentionEnv;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/**
	 * Captures the Anthropic request payload for a session's system prompt via
	 * onPayload with a fake key; the request never reaches a real endpoint.
	 * Returns the payload plus the sections the session sent.
	 */
	async function captureAnthropicPayload(options?: {
		cacheRetention?: CacheRetention;
		systemPromptOverride?: SystemPromptSection[];
	}): Promise<{ payload: CapturedAnthropicPayload; sections: SystemPromptSection[] }> {
		const model: Model<"anthropic-messages"> = {
			id: "anthropic-test-model",
			name: "Anthropic Test Model",
			api: "anthropic-messages",
			provider: "anthropic-test",
			baseUrl: "https://my-proxy.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 4096,
		};

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			cacheRetention: options?.cacheRetention,
		});

		let capturedPayload: CapturedAnthropicPayload | undefined;
		try {
			const statePrompt = session.agent.state.systemPrompt;
			expect(Array.isArray(statePrompt)).toBe(true);
			const sections = options?.systemPromptOverride ?? (statePrompt as SystemPromptSection[]);

			const stream = await session.agent.streamFn(
				model,
				{
					systemPrompt: sections,
					messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
				},
				{
					onPayload: (payload) => {
						capturedPayload = payload as CapturedAnthropicPayload;
					},
				},
			);
			// The request fails (fake key, unreachable proxy), but onPayload fires
			// while building the request, before any network access.
			try {
				for await (const event of stream) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected: no reachable endpoint behind the fake base URL.
			}
			expect(capturedPayload).toBeDefined();
			if (capturedPayload === undefined) throw new Error("unreachable");
			return { payload: capturedPayload, sections };
		} finally {
			session.dispose();
		}
	}

	it("caches the stable prefix for 1h and leaves the volatile tail uncached by default", async () => {
		const { payload, sections } = await captureAnthropicPayload();

		const blocks = payload.system;
		expect(blocks).toBeDefined();
		if (blocks === undefined) throw new Error("unreachable");
		expect(blocks).toHaveLength(2);

		const [stable, volatile] = blocks;
		expect(stable!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(stable!.text).not.toContain("Current date:");
		expect(volatile!.cache_control).toBeUndefined();
		expect(volatile!.text).toContain("Current date:");
		expect(volatile!.text).toContain("Current working directory:");

		// The concatenated blocks are byte-identical to the legacy flattened prompt.
		expect(blocks.map((block) => block.text).join("")).toBe(flattenSystemPrompt(sections));
	});

	it("uses the 5m tier (no ttl) when the session passes cacheRetention short", async () => {
		const { payload } = await captureAnthropicPayload({ cacheRetention: "short" });

		const blocks = payload.system;
		expect(blocks).toBeDefined();
		if (blocks === undefined) throw new Error("unreachable");
		expect(blocks).toHaveLength(2);
		expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
		expect(blocks[1]!.cache_control).toBeUndefined();
	});

	it("keeps an extension-contributed volatile section in the uncached tail, in array order", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						systemPromptSection: {
							id: "ext-volatile",
							text: "\n\nPer-turn extension context",
							cacheRetention: "none" as const,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const captured = captureSystemPrompt(harness);
		await harness.session.prompt("hello");
		const splicedSections = captured.current as SystemPromptSection[];

		const { payload } = await captureAnthropicPayload({ systemPromptOverride: splicedSections });

		const blocks = payload.system;
		expect(blocks).toBeDefined();
		if (blocks === undefined) throw new Error("unreachable");

		// The contributed volatile section lands in the uncached trailing blocks.
		const extBlock = blocks.find((block) => block.text.includes("Per-turn extension context"));
		expect(extBlock).toBeDefined();
		expect(extBlock!.cache_control).toBeUndefined();
		// Exactly one breakpoint, on the folded stable prefix.
		expect(blocks.filter((block) => block.cache_control).length).toBe(1);
		expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		// Payload text order is byte-identical to the flattened prompt.
		expect(blocks.map((block) => block.text).join("")).toBe(flattenSystemPrompt(splicedSections));
	});

	it("includes an extension-contributed section in the cached stable prefix", async () => {
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
		const splicedSections = captured.current as SystemPromptSection[];

		const { payload } = await captureAnthropicPayload({ systemPromptOverride: splicedSections });

		const blocks = payload.system;
		expect(blocks).toBeDefined();
		if (blocks === undefined) throw new Error("unreachable");
		expect(blocks).toHaveLength(2);

		const [stable, volatile] = blocks;
		expect(stable!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(stable!.text).toContain("Extension directives");
		expect(volatile!.cache_control).toBeUndefined();
		expect(volatile!.text).not.toContain("Extension directives");
	});
});
