import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";

/** Shape of the Anthropic request payload fields asserted by these tests. */
interface CapturedAnthropicPayload {
	system?: Array<{ text?: string; cache_control?: { type: string; ttl?: string } }>;
}

describe("createAgentSession cacheRetention wiring", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalCacheRetentionEnv: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-cache-retention-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	});

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureStreamOptions(
		sessionCacheRetention?: CacheRetention,
	): Promise<SimpleStreamOptions | undefined> {
		const model: Model<Api> = {
			id: "capture-test-model",
			name: "Capture Test Model",
			api: "openai-completions",
			provider: "capture-provider",
			baseUrl: "https://capture.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider("capture-provider", {
			api: "openai-completions",
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			cacheRetention: sessionCacheRetention,
		});

		try {
			await session.agent.streamFn(model, { messages: [] }, undefined);
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("capture-provider");
		}
	}

	async function captureAnthropicPayload(
		sessionCacheRetention?: CacheRetention,
	): Promise<CapturedAnthropicPayload | undefined> {
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
			cacheRetention: sessionCacheRetention,
		});

		let capturedPayload: CapturedAnthropicPayload | undefined;
		try {
			const stream = await session.agent.streamFn(
				model,
				{
					systemPrompt: "You are a test assistant.",
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
			for await (const event of stream) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected: no reachable endpoint behind the fake base URL.
		}
		return capturedPayload;
	}

	describe("stream options threading", () => {
		it("defaults to long cache retention", async () => {
			const options = await captureStreamOptions();
			expect(options?.cacheRetention).toBe("long");
		});

		it("uses the cacheRetention option when provided", async () => {
			const options = await captureStreamOptions("short");
			expect(options?.cacheRetention).toBe("short");
		});

		it("honors PI_CACHE_RETENTION when no option is set", async () => {
			process.env.PI_CACHE_RETENTION = "short";
			const options = await captureStreamOptions();
			expect(options?.cacheRetention).toBe("short");
		});

		it("honors PI_CACHE_RETENTION=none when no option is set", async () => {
			process.env.PI_CACHE_RETENTION = "none";
			const options = await captureStreamOptions();
			expect(options?.cacheRetention).toBe("none");
		});

		it("prefers the cacheRetention option over PI_CACHE_RETENTION", async () => {
			process.env.PI_CACHE_RETENTION = "short";
			const options = await captureStreamOptions("long");
			expect(options?.cacheRetention).toBe("long");
		});

		it("ignores invalid PI_CACHE_RETENTION values", async () => {
			process.env.PI_CACHE_RETENTION = "forever";
			const options = await captureStreamOptions();
			expect(options?.cacheRetention).toBe("long");
		});
	});

	describe("Anthropic payload", () => {
		it("emits a 1h cache TTL for a default session", async () => {
			const payload = await captureAnthropicPayload();
			expect(payload).toBeDefined();
			expect(payload?.system?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("emits the default 5m cache TTL (no ttl field) for a short session", async () => {
			const payload = await captureAnthropicPayload("short");
			expect(payload).toBeDefined();
			expect(payload?.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
		});

		it("emits no cache_control when cacheRetention is none", async () => {
			const payload = await captureAnthropicPayload("none");
			expect(payload).toBeDefined();
			expect(payload?.system?.[0]?.cache_control).toBeUndefined();
		});
	});
});
