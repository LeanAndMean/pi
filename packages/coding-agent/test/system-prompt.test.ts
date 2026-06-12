import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { getDocsPath, getExamplesPath, getReadmePath } from "../src/config.js";
import { formatSkillsForPrompt, type Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	buildSystemPromptSections,
} from "../src/core/system-prompt.js";

function makeSkill(name: string, disableModelInvocation = false): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
		disableModelInvocation,
	};
}

/**
 * Verbatim copy of buildSystemPrompt as it was before the sectioned refactor
 * (commit 3f9b7266). Used as the oracle for byte-identity: the refactored
 * builder must produce exactly the same string for every option combination.
 */
function legacyBuildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});

describe("buildSystemPromptSections", () => {
	const contextFiles = [{ path: "AGENTS.md", content: "Project instructions here." }];
	const skills = [makeSkill("alpha"), makeSkill("beta")];

	test("minimal options produce core and volatile sections only", () => {
		const sections = buildSystemPromptSections({ cwd: "/tmp/project" });

		expect(sections.map((s) => s.id)).toEqual(["core", "volatile"]);
	});

	test("all optional content produces the full section order", () => {
		const sections = buildSystemPromptSections({
			appendSystemPrompt: "Appended text.",
			contextFiles,
			skills,
			cwd: "/tmp/project",
		});

		expect(sections.map((s) => s.id)).toEqual(["core", "append", "context-files", "skills", "volatile"]);
	});

	test("volatile section is last, marked cacheRetention none, and holds date/cwd", () => {
		const sections = buildSystemPromptSections({
			appendSystemPrompt: "Appended text.",
			contextFiles,
			skills,
			cwd: "/tmp/project",
		});

		const volatile = sections[sections.length - 1];
		expect(volatile.id).toBe("volatile");
		expect(volatile.cacheRetention).toBe("none");
		expect(volatile.text).toContain("Current date: ");
		expect(volatile.text).toContain("Current working directory: /tmp/project");

		for (const section of sections.slice(0, -1)) {
			expect(section.cacheRetention).toBeUndefined();
		}
	});

	test("customPrompt replaces the default core text", () => {
		const sections = buildSystemPromptSections({
			customPrompt: "You are a test assistant.",
			cwd: "/tmp/project",
		});

		const core = sections[0];
		expect(core.id).toBe("core");
		expect(core.text).toBe("You are a test assistant.");
		expect(core.text).not.toContain("expert coding assistant");
	});

	test("skills section is omitted when the read tool is not selected", () => {
		const sections = buildSystemPromptSections({
			selectedTools: ["bash"],
			skills,
			cwd: "/tmp/project",
		});

		expect(sections.map((s) => s.id)).not.toContain("skills");
	});

	test("skills section is omitted when all skills are hidden from the model", () => {
		const sections = buildSystemPromptSections({
			skills: [makeSkill("hidden", true)],
			cwd: "/tmp/project",
		});

		expect(sections.map((s) => s.id)).not.toContain("skills");
	});

	test("sections carry their own leading separators", () => {
		const sections = buildSystemPromptSections({
			appendSystemPrompt: "Appended text.",
			contextFiles,
			skills,
			cwd: "/tmp/project",
		});

		const byId = new Map(sections.map((s) => [s.id, s.text]));
		expect(byId.get("append")).toBe("\n\nAppended text.");
		expect(byId.get("context-files")?.startsWith("\n\n# Project Context\n\n")).toBe(true);
		expect(byId.get("skills")?.startsWith("\n\n")).toBe(true);
		expect(byId.get("volatile")?.startsWith("\nCurrent date: ")).toBe(true);
	});
});

describe("buildSystemPrompt byte-identity with pre-refactor output", () => {
	// Oracle and builder each call new Date(); freeze time so a run spanning
	// midnight can't produce different dates in the two strings.
	beforeAll(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 5, 12, 12, 0, 0));
	});

	afterAll(() => {
		vi.useRealTimers();
	});

	const contextFiles = [{ path: "AGENTS.md", content: "Project instructions here." }];
	const skills = [makeSkill("alpha"), makeSkill("beta")];

	const corePrompts: Array<Pick<BuildSystemPromptOptions, "customPrompt">> = [
		{},
		{ customPrompt: "You are a test assistant." },
	];
	const appendVariants: Array<Pick<BuildSystemPromptOptions, "appendSystemPrompt">> = [
		{},
		{ appendSystemPrompt: "Appended text." },
	];
	const contextVariants: Array<Pick<BuildSystemPromptOptions, "contextFiles">> = [{}, { contextFiles }];
	const skillsVariants: Array<Pick<BuildSystemPromptOptions, "skills">> = [{}, { skills }];

	for (const core of corePrompts) {
		for (const append of appendVariants) {
			for (const context of contextVariants) {
				for (const skillsVariant of skillsVariants) {
					const options: BuildSystemPromptOptions = {
						...core,
						...append,
						...context,
						...skillsVariant,
						toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
						cwd: "/tmp/project",
					};
					const label = [
						core.customPrompt ? "custom" : "default",
						append.appendSystemPrompt ? "append" : "no-append",
						context.contextFiles ? "context" : "no-context",
						skillsVariant.skills ? "skills" : "no-skills",
					].join(" + ");

					test(label, () => {
						expect(buildSystemPrompt(options)).toBe(legacyBuildSystemPrompt(options));
					});
				}
			}
		}
	}

	test("custom prompt + selected tools with read + visible skills", () => {
		const options: BuildSystemPromptOptions = {
			customPrompt: "You are a test assistant.",
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "Read file contents" },
			skills,
			cwd: "/tmp/project",
		};

		expect(buildSystemPrompt(options)).toBe(legacyBuildSystemPrompt(options));
	});

	test("custom prompt + selected tools without read + visible skills", () => {
		const options: BuildSystemPromptOptions = {
			customPrompt: "You are a test assistant.",
			selectedTools: ["bash"],
			toolSnippets: { bash: "Execute bash commands" },
			skills,
			cwd: "/tmp/project",
		};

		expect(buildSystemPrompt(options)).toBe(legacyBuildSystemPrompt(options));
	});

	test("selected tools without read + hidden skills", () => {
		const options: BuildSystemPromptOptions = {
			selectedTools: ["bash", "grep"],
			toolSnippets: { bash: "Execute bash commands" },
			promptGuidelines: ["Custom guideline."],
			skills: [makeSkill("hidden", true)],
			cwd: "C:\\Users\\test\\project",
		};

		expect(buildSystemPrompt(options)).toBe(legacyBuildSystemPrompt(options));
	});
});
