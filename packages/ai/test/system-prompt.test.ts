import { describe, expect, it } from "vitest";
import type { SystemPromptSection } from "../src/types.js";
import { flattenSystemPrompt } from "../src/utils/system-prompt.js";

describe("flattenSystemPrompt", () => {
	it("passes string prompts through unchanged", () => {
		expect(flattenSystemPrompt("You are a helpful assistant.")).toBe("You are a helpful assistant.");
		expect(flattenSystemPrompt("")).toBe("");
	});

	it("returns undefined for undefined", () => {
		expect(flattenSystemPrompt(undefined)).toBeUndefined();
	});

	it("returns an empty string for an empty section array", () => {
		expect(flattenSystemPrompt([])).toBe("");
	});

	it("joins sections with no inserted separator", () => {
		const sections: SystemPromptSection[] = [
			{ id: "a", text: "a" },
			{ id: "b", text: "b" },
			{ id: "c", text: "c" },
		];
		expect(flattenSystemPrompt(sections)).toBe("abc");
	});

	it("is byte-identical to the single-string prompt when sections carry their own leading separators", () => {
		const core = "You are a coding assistant.";
		const append = "\n\nExtra instructions.";
		const contextFiles = "\n\n# Project context\n\nAGENTS.md contents";
		const volatile = "\nCurrent date: 2026-06-10\nCurrent working directory: /tmp/project";
		const legacy = core + append + contextFiles + volatile;

		const sections: SystemPromptSection[] = [
			{ id: "core", text: core },
			{ id: "append", text: append },
			{ id: "context-files", text: contextFiles },
			{ id: "volatile", text: volatile, cacheRetention: "none" },
		];

		expect(flattenSystemPrompt(sections)).toBe(legacy);
	});

	it("preserves section order", () => {
		const sections: SystemPromptSection[] = [
			{ id: "second", text: "2" },
			{ id: "first", text: "1" },
		];
		expect(flattenSystemPrompt(sections)).toBe("21");
	});
});
