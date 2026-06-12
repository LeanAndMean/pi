/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createExtensionRuntime, discoverAndLoadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner, spliceContributedSections } from "../src/core/extensions/runner.js";
import type { ExtensionActions, ExtensionContextActions, ProviderConfig } from "../src/core/extensions/types.js";
import { KeybindingsManager, type KeyId } from "../src/core/keybindings.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("ExtensionRunner", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	const defaultKeybindings = new KeybindingsManager().getEffectiveConfig();

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const providerModelConfig: ProviderConfig = {
		baseUrl: "https://provider.test/v1",
		apiKey: "PROVIDER_TEST_KEY",
		api: "openai-completions",
		models: [
			{
				id: "instant-model",
				name: "Instant Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		dispatchUserInput: async () => {},
	};

	describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it("allows a shortcut when the reserved set no longer contains the default key", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+p", {
						description: "Uses freed default",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebinding.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.model.cycleForward": "ctrl+n" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(shortcuts.has("ctrl+p")).toBe(true);
			expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));

			warnSpy.mockRestore();
		});

		it("warns but allows when extension uses non-reserved built-in shortcut", async () => {
			const pasteImageKey = Array.isArray(defaultKeybindings["app.clipboard.pasteImage"])
				? (defaultKeybindings["app.clipboard.pasteImage"][0] ?? "")
				: defaultKeybindings["app.clipboard.pasteImage"];
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("${pasteImageKey}", {
						description: "Overrides non-reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has(pasteImageKey as KeyId)).toBe(true);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts for reserved actions even when rebound", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+x", {
						description: "Conflicts with rebound reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebound-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.interrupt": "ctrl+x" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+x")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved key is also bound to non-reserved actions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+p", {
						description: "Conflicts with shared reserved default",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "shared-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+p")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved action has multiple keys", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+y", {
						description: "Conflicts with multi-key reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clear": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+y")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns but allows when non-reserved action has multiple keys", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+y", {
						description: "Overrides multi-key non-reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clipboard.pasteImage": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has("ctrl+y")).toBe(true);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						handler: async () => {},
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

	describe("tool collection", () => {
		it("collects tools from multiple extensions", async () => {
			const toolCode = (name: string) => `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "${name}",
						label: "${name}",
						description: "Test tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), toolCode("tool_a"));
			fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), toolCode("tool_b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools.length).toBe(2);
			expect(tools.map((t) => t.definition.name).sort()).toEqual(["tool_a", "tool_b"]);
		});

		it("keeps first tool when two extensions register the same name", async () => {
			const first = `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "shared",
						label: "shared",
						description: "first",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			const second = `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "shared",
						label: "shared",
						description: "second",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools).toHaveLength(1);
			expect(tools[0]?.definition.description).toBe("first");
		});
	});

	describe("command collection", () => {
		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export default function(pi) {
					pi.registerCommand("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map((c) => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
			expect(commands.map((c) => c.invocationName).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by invocation name", async () => {
			const cmdCode = `
				export default function(pi) {
					pi.registerCommand("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd.ts"), cmdCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.invocationName).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("suffixes duplicate extension commands in insertion order", async () => {
			const cmdCode = (description: string) => `
				export default function(pi) {
					pi.registerCommand("shared-cmd", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("First command"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("Second command"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();
			const diagnostics = runner.getCommandDiagnostics();

			expect(commands).toHaveLength(2);
			expect(commands.map((command) => command.name)).toEqual(["shared-cmd", "shared-cmd"]);
			expect(commands.map((command) => command.invocationName)).toEqual(["shared-cmd:1", "shared-cmd:2"]);
			expect(commands.map((command) => command.description)).toEqual(["First command", "Second command"]);
			expect(diagnostics).toEqual([]);
			expect(runner.getCommand("shared-cmd:1")?.description).toBe("First command");
			expect(runner.getCommand("shared-cmd:2")?.description).toBe("Second command");
		});
	});

	describe("context creation", () => {
		it("exposes the current abort signal on ExtensionContext", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const controller = new AbortController();

			runner.bindCore(extensionActions, {
				...extensionContextActions,
				getSignal: () => controller.signal,
			});

			const ctx = runner.createContext();
			expect(ctx.signal).toBe(controller.signal);
			expect(ctx.signal?.aborted).toBe(false);

			controller.abort();
			expect(ctx.signal?.aborted).toBe(true);
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError((err) => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});
	});

	describe("message renderers", () => {
		it("gets message renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMessageRenderer("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "renderer.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});
	});

	describe("flags", () => {
		it("collects flags from extensions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("my-flag", {
						description: "My flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const flags = runner.getFlags();

			expect(flags.has("my-flag")).toBe(true);
		});

		it("keeps first flag when two extensions register the same name", async () => {
			const first = `
				export default function(pi) {
					pi.registerFlag("shared-flag", {
						description: "first",
						type: "boolean",
						default: true,
					});
				}
			`;
			const second = `
				export default function(pi) {
					pi.registerFlag("shared-flag", {
						description: "second",
						type: "boolean",
						default: false,
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const flags = runner.getFlags();

			expect(flags.get("shared-flag")?.description).toBe("first");
			expect(result.runtime.flagValues.get("shared-flag")).toBe(true);
		});

		it("can set flag values", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("test-flag", {
						description: "Test flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "flag.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			// Setting a flag value should not throw
			runner.setFlagValue("--test-flag", true);

			// The flag values are stored in the shared runtime
			expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
		});
	});

	describe("before_agent_start", () => {
		it("keeps ctx.getSystemPrompt() in sync with chained system prompt updates", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nfirst",
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nsecond",
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(2);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));
			runner.bindCore(extensionActions, extensionContextActions);

			const chained = await runner.emitBeforeAgentStart("hello", undefined, [{ id: "core", text: "base" }], {
				cwd: tempDir,
			});

			expect(errors).toEqual([]);

			expect(chained).toEqual({
				messages: undefined,
				systemPrompt: "base\nfirst\nsecond",
				systemPromptSections: undefined,
			});
		});

		it("accumulates contributed sections in load order and exposes the base sections on the event", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_agent_start", async (event) => {
						return {
							systemPromptSection: {
								id: "ext-one",
								text: "\\n\\none (saw " + event.systemPromptSections.map((s) => s.id).join(",") + ")",
							},
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPromptSection: { id: "ext-two", text: "\\n\\ntwo", cacheRetention: "none" },
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-sections-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-sections-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(2);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));
			runner.bindCore(extensionActions, extensionContextActions);

			const combined = await runner.emitBeforeAgentStart(
				"hello",
				undefined,
				[
					{ id: "core", text: "base" },
					{ id: "volatile", text: "\ndate", cacheRetention: "none" },
				],
				{ cwd: tempDir },
			);

			expect(errors).toEqual([]);

			expect(combined).toEqual({
				messages: undefined,
				systemPrompt: undefined,
				systemPromptSections: [
					{ id: "ext-one", text: "\n\none (saw core,volatile)" },
					{ id: "ext-two", text: "\n\ntwo", cacheRetention: "none" },
				],
			});
		});

		it("rejects a malformed section and reports the extension", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPromptSection: { id: 42, text: "not validated" },
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "malformed-section.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ extensionPath: string; error: string }> = [];
			runner.onError((error) => errors.push({ extensionPath: error.extensionPath, error: error.error }));
			runner.bindCore(extensionActions, extensionContextActions);

			const combined = await runner.emitBeforeAgentStart("hello", undefined, [{ id: "core", text: "base" }], {
				cwd: tempDir,
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].extensionPath).toContain("malformed-section.ts");
			expect(errors[0].error).toBe("Ignoring systemPromptSection: `id` and `text` must be strings");
			expect(combined).toBeUndefined();
		});

		it("rejects a section with an invalid cacheRetention and reports the extension", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPromptSection: { id: "ext-bad", text: "\\n\\ndirectives", cacheRetention: "short" },
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "bad-retention.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ extensionPath: string; error: string }> = [];
			runner.onError((error) => errors.push({ extensionPath: error.extensionPath, error: error.error }));
			runner.bindCore(extensionActions, extensionContextActions);

			const combined = await runner.emitBeforeAgentStart("hello", undefined, [{ id: "core", text: "base" }], {
				cwd: tempDir,
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].extensionPath).toContain("bad-retention.ts");
			expect(errors[0].error).toBe(
				'Ignoring systemPromptSection "ext-bad": `cacheRetention` must be "none" or omitted, got "short"',
			);
			expect(combined).toBeUndefined();
		});

		it("warns when a stable section is contributed after a volatile one but keeps both", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPromptSection: { id: "ext-volatile", text: "\\n\\nper-turn", cacheRetention: "none" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPromptSection: { id: "ext-stable", text: "\\n\\nlate stable" },
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "order-1-volatile.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "order-2-stable.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ extensionPath: string; error: string }> = [];
			runner.onError((error) => errors.push({ extensionPath: error.extensionPath, error: error.error }));
			runner.bindCore(extensionActions, extensionContextActions);

			const combined = await runner.emitBeforeAgentStart("hello", undefined, [{ id: "core", text: "base" }], {
				cwd: tempDir,
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].extensionPath).toContain("order-2-stable.ts");
			expect(errors[0].error).toBe(
				'Stable systemPromptSection "ext-stable" was contributed after a volatile one; ' +
					"it will sit after that section and be excluded from the cached prefix",
			);
			// The warning is advisory: both sections are still contributed.
			expect(combined?.systemPromptSections).toEqual([
				{ id: "ext-volatile", text: "\n\nper-turn", cacheRetention: "none" },
				{ id: "ext-stable", text: "\n\nlate stable" },
			]);
		});

		it("reports contributed sections dropped by a string replacement, attributed to the replacing extension", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPromptSection: { id: "ext-dropped", text: "\\n\\ncontributed" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPrompt: "authoritative replacement",
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "drop-1-contributor.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "drop-2-replacer.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ extensionPath: string; error: string }> = [];
			runner.onError((error) => errors.push({ extensionPath: error.extensionPath, error: error.error }));
			runner.bindCore(extensionActions, extensionContextActions);

			const combined = await runner.emitBeforeAgentStart("hello", undefined, [{ id: "core", text: "base" }], {
				cwd: tempDir,
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].extensionPath).toContain("drop-2-replacer.ts");
			expect(errors[0].error).toBe(
				"Contributed system prompt section(s) ext-dropped were dropped: this extension replaced the system prompt with a string, which is authoritative for the turn",
			);
			expect(combined?.systemPrompt).toBe("authoritative replacement");
		});

		it("keeps a contribution made after a string replacement out of the chained prompt and attributes the drop to the replacer", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPrompt: "authoritative replacement",
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPromptSection: { id: "ext-late", text: "\\n\\nlate contribution" },
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "late-1-replacer.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "late-2-contributor.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ extensionPath: string; error: string }> = [];
			runner.onError((error) => errors.push({ extensionPath: error.extensionPath, error: error.error }));
			runner.bindCore(extensionActions, extensionContextActions);

			const combined = await runner.emitBeforeAgentStart("hello", undefined, [{ id: "core", text: "base" }], {
				cwd: tempDir,
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].extensionPath).toContain("late-1-replacer.ts");
			expect(errors[0].error).toBe(
				"Contributed system prompt section(s) ext-late were dropped: this extension replaced the system prompt with a string, which is authoritative for the turn",
			);
			// The late contribution is accepted but never folded into the chained prompt.
			expect(combined?.systemPrompt).toBe("authoritative replacement");
			expect(combined?.systemPromptSections).toEqual([{ id: "ext-late", text: "\n\nlate contribution" }]);
		});

		it("lets the string win when one extension returns both systemPrompt and systemPromptSection, attributing the drop to itself", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("before_agent_start", async () => {
						return {
							systemPrompt: "replacement from both",
							systemPromptSection: { id: "ext-own", text: "\\n\\nown section" },
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "both-fields.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ extensionPath: string; error: string }> = [];
			runner.onError((error) => errors.push({ extensionPath: error.extensionPath, error: error.error }));
			runner.bindCore(extensionActions, extensionContextActions);

			const combined = await runner.emitBeforeAgentStart("hello", undefined, [{ id: "core", text: "base" }], {
				cwd: tempDir,
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].extensionPath).toContain("both-fields.ts");
			expect(errors[0].error).toBe(
				"Contributed system prompt section(s) ext-own were dropped: this extension replaced the system prompt with a string, which is authoritative for the turn",
			);
			expect(combined?.systemPrompt).toBe("replacement from both");
			expect(combined?.systemPromptSections).toEqual([{ id: "ext-own", text: "\n\nown section" }]);
		});
	});

	describe("spliceContributedSections", () => {
		it("prefixes contributed text that lacks a leading newline so it cannot glue onto the previous section", () => {
			const base = [
				{ id: "core", text: "You are pi." },
				{ id: "volatile", text: "\ndate", cacheRetention: "none" as const },
			];
			const spliced = spliceContributedSections(base, [{ id: "ext", text: "Extension directives" }]);

			expect(spliced.map((s) => s.id)).toEqual(["core", "ext", "volatile"]);
			expect(spliced[1].text).toBe("\n\nExtension directives");
		});

		it("leaves contributed text that already starts with a newline untouched", () => {
			const base = [{ id: "core", text: "You are pi." }];
			const spliced = spliceContributedSections(base, [{ id: "ext", text: "\n\nAlready separated" }]);

			expect(spliced.map((s) => s.id)).toEqual(["core", "ext"]);
			expect(spliced[1].text).toBe("\n\nAlready separated");
		});
	});

	describe("emitError fallback", () => {
		it("logs to console.error when no listeners are registered", () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			runner.emitError({
				extensionPath: "/tmp/broken.ts",
				event: "before_agent_start",
				error: "boom",
				stack: "fake stack",
			});

			expect(errorSpy).toHaveBeenCalledWith("Extension error [/tmp/broken.ts] (before_agent_start): boom");
			expect(errorSpy).toHaveBeenCalledWith("fake stack");

			errorSpy.mockClear();
			const errors: string[] = [];
			const unsubscribe = runner.onError((error) => errors.push(error.error));
			runner.emitError({ extensionPath: "/tmp/broken.ts", event: "before_agent_start", error: "boom" });

			expect(errorSpy).not.toHaveBeenCalled();
			expect(errors).toEqual(["boom"]);

			unsubscribe();
			errorSpy.mockRestore();
		});
	});

	describe("unbound handler defaults", () => {
		it("rejects dispatchUserInput when no input pipeline is bound", async () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);

			await expect(runner.createContext().dispatchUserInput("hello")).rejects.toThrow(
				"dispatchUserInput is not available in this session mode (no input pipeline bound)",
			);
		});

		it("rejects newSession when no command context is bound", async () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);

			await expect(runner.createContext().newSession()).rejects.toThrow(
				"newSession is not available in this session mode (no command context bound)",
			);
		});

		it("rejects newSession again after the command context is unbound", async () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);

			runner.bindCommandContext({
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			});
			await expect(runner.createContext().newSession()).resolves.toEqual({ cancelled: false });

			runner.bindCommandContext(undefined);
			await expect(runner.createContext().newSession()).rejects.toThrow(
				"newSession is not available in this session mode (no command context bound)",
			);
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-2",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("provider registration", () => {
		it("bindCore ignores invalid queued registrations and reports extension error", () => {
			const runtime = createExtensionRuntime();
			runtime.registerProvider(
				"broken-provider",
				{
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				},
				"/tmp/broken-extension.ts",
			);

			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(`${error.extensionPath}: ${error.error}`));

			expect(() => runner.bindCore(extensionActions, extensionContextActions)).not.toThrow();
			expect(errors).toEqual([
				'/tmp/broken-extension.ts: Provider broken-provider: "api" is required when registering streamSimple.',
			]);
			expect(() => modelRegistry.refresh()).not.toThrow();
		});

		it("pre-bind unregister removes all queued registrations for a provider", () => {
			const runtime = createExtensionRuntime();

			runtime.registerProvider("queued-provider", providerModelConfig);
			runtime.registerProvider("queued-provider", {
				...providerModelConfig,
				models: [
					{
						id: "instant-model-2",
						name: "Instant Model 2",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(runtime.pendingProviderRegistrations).toHaveLength(2);

			runtime.unregisterProvider("queued-provider");
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
		});

		it("post-bind register and unregister take effect immediately", () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);

			runner.bindCore(extensionActions, extensionContextActions);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);

			runtime.registerProvider("instant-provider", providerModelConfig);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
			expect(modelRegistry.find("instant-provider", "instant-model")).toBeDefined();

			runtime.unregisterProvider("instant-provider");
			expect(modelRegistry.find("instant-provider", "instant-model")).toBeUndefined();
		});
	});

	describe("command context", () => {
		it("passes fork options through to the bound handler", async () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const fork = vi.fn(async () => ({ cancelled: false }));

			runner.bindCommandContext({
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: false }),
				fork,
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			});

			const commandContext = runner.createCommandContext();
			await commandContext.fork("entry-1");
			expect(fork).toHaveBeenCalledWith("entry-1", undefined);

			await commandContext.fork("entry-2", { position: "at" });
			expect(fork).toHaveBeenLastCalledWith("entry-2", { position: "at" });
		});
	});

	describe("hasHandlers", () => {
		it("returns true when handlers exist for event type", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async () => undefined);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "handler.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.hasHandlers("tool_call")).toBe(true);
			expect(runner.hasHandlers("agent_end")).toBe(false);
		});
	});
});
