# Development Rules

## Fork Scope

This is a fork of the pi monorepo. Four packages are published under `@leanandmean/` in lockstep: `pi-tui`, `pi-ai`, `pi-agent-core`, `pi-coding-agent`. The sole consumer is the `scramjet` package.

- All four packages share the same version (`<upstream>-scramjet.<N>`).
- Source always uses `@earendil-works/` names; the release workflow renames to `@leanandmean/` at publish time.
- `packages/web-ui` is **not** published and is **never** needed for building, checking, or testing.
- When modifying CI workflows, scope build/check steps to only the published packages: `tui`, `ai`, `agent`, `coding-agent`. Never use the root `npm run build` or `npm run check` — they include `web-ui` and the full upstream test suite, which may have stale upstream type references.
- The root `npm run check` also type-checks upstream test files (e.g., `packages/ai/test/`) which reference model names that drift with upstream changes. Use per-package `tsgo -p <pkg>/tsconfig.build.json --noEmit` instead.
- Internal dependency ranges between published packages must use prerelease-compatible versions (e.g., `^0.74.0-scramjet.4`), not bare `^0.74.0`. Semver treats prereleases as incompatible with the base range, causing npm to install from the registry instead of linking the workspace.
- The upstream lockfile is generated on macOS and lacks linux native bindings. CI uses `npm install` (not `npm ci`) to resolve platform-specific optional deps at install time.
- npm does not allow republishing a version that was previously published and unpublished. Always increment the scramjet number if a publish is retracted.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")
- When the user asks a question, answer it first before making edits or running implementation commands.

## Code Quality

- Read files in full before making wide-ranging changes, before editing files you have not already fully inspected, and when the user asks you to investigate or audit something. Do not rely only on search snippets for broad changes.
- No `any` types unless absolutely necessary
- Single-line helper functions with a single call site are forbidden; inline them instead.
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it
- Never hardcode key checks with, eg. `matchesKey(keyData, "ctrl+x")`. All keybindings must be configurable. Add default to matching object (`DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`)
- NEVER modify `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` instead.

## Commands

- After code changes (not documentation changes): run the scoped check that the pre-commit hook uses (biome + per-package tsgo). Do NOT use `npm run check` — it runs the root check which includes web-ui and stale upstream test types. The pre-commit hook handles this automatically on commit.
- Note: `npm run check` does not run tests.
- NEVER run: `npm run dev`, `npm test`, or the root `npm run build` (builds web-ui which fails without macOS native deps). Workspace-scoped builds are fine: `npm run build -w packages/ai` etc.
- Only run specific tests if user instructs: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- Run tests from the package root, not the repo root.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` plus the faux provider. Do not use real provider APIs, real API keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` and name them `<issue-number>-<short-slug>.test.ts`.
- NEVER commit unless user asks

## Contribution Gate

- New issues from new contributors are auto-closed by `.github/workflows/issue-gate.yml`
- New PRs from new contributors without PR rights are auto-closed by `.github/workflows/pr-gate.yml`
- Maintainer approval comments are handled by `.github/workflows/approve-contributor.yml`
- Maintainers review auto-closed issues daily
- Issues that do not meet the quality bar in `CONTRIBUTING.md` are not reopened and do not receive a reply
- `lgtmi` approves future issues
- `lgtm` approves future issues and rights to submit PRs

When creating issues:

- Add `pkg:*` labels to indicate which package(s) the issue affects
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`, `pkg:web-ui`
- If an issue spans multiple packages, add all relevant labels

When posting issue/PR comments:

- Write the full comment to a temp file and use `gh issue comment --body-file` or `gh pr comment --body-file`
- Never pass multi-line markdown directly via `--body` in shell commands
- Preview the exact comment text before posting
- Post exactly one final comment unless the user explicitly asks for multiple comments
- If a comment is malformed, delete it immediately, then post one corrected comment
- Keep comments concise, technical, and in the user's tone

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## PR Workflow

- Analyze PRs without pulling locally first
- If the user approves: create a feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR, and leave a comment in the user's tone
- You never open PRs yourself. We work in feature branches until everything is according to the user's requirements, then merge into main, and push.

## Testing pi Interactive Mode with tmux

To test pi's TUI in a controlled terminal environment:

```bash
# Create tmux session with specific dimensions
tmux new-session -d -s pi-test -x 80 -y 24

# Start pi from source
tmux send-keys -t pi-test "cd /Users/badlogic/workspaces/pi-mono && ./pi-test.sh" Enter

# Wait for startup, then capture output
sleep 3 && tmux capture-pane -t pi-test -p

# Send input
tmux send-keys -t pi-test "your prompt here" Enter

# Send special keys
tmux send-keys -t pi-test Escape
tmux send-keys -t pi-test C-o  # ctrl+o

# Cleanup
tmux kill-session -t pi-test
```

## Changelog

Only `packages/coding-agent/CHANGELOG.md` is maintained for this fork.

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- Add changelog entries during pre-merge or at merge time (not reserved for maintainers in this fork)
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/LeanAndMean/pi/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/LeanAndMean/pi/pull/456) by [@username](https://github.com/username))`

## Adding a New LLM Provider (packages/ai)

Adding a new provider requires changes across multiple files:

### 1. Core Types (`packages/ai/src/types.ts`)

- Add API identifier to `Api` type union (e.g., `"bedrock-converse-stream"`)
- Create options interface extending `StreamOptions`
- Add mapping to `ApiOptionsMap`
- Add provider name to `KnownProvider` type union

### 2. Provider Implementation (`packages/ai/src/providers/`)

Create provider file exporting:

- `stream<Provider>()` function returning `AssistantMessageEventStream`
- `streamSimple<Provider>()` for `SimpleStreamOptions` mapping
- Provider-specific options interface
- Message/tool conversion functions
- Response parsing emitting standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

### 3. Provider Exports and Lazy Registration

- Add a package subpath export in `packages/ai/package.json` pointing at `./dist/providers/<provider>.js`
- Add `export type` re-exports in `packages/ai/src/index.ts` for provider option types that should remain available from the root entry
- Register the provider in `packages/ai/src/providers/register-builtins.ts` via lazy loader wrappers, do not statically import provider implementation modules there
- Add credential detection in `packages/ai/src/env-api-keys.ts`

### 4. Model Generation (`packages/ai/scripts/generate-models.ts`)

- Add logic to fetch/parse models from provider source
- Map to standardized `Model` interface

### 5. Tests (`packages/ai/test/`)

- Always add the provider to `stream.test.ts` with at least one representative model, even if it reuses an existing API implementation such as `openai-completions`.
- Add the provider to the broader provider matrix where applicable: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.
- For non-standard auth, create utility (e.g., `bedrock-utils.ts`) with credential detection.

### 6. Coding Agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: Add default model ID to `defaultModelPerProvider`
- `src/core/provider-display-names.ts`: Add API-key login display name so `/login` and related UI show the provider for built-in API-key auth.
- `src/cli/args.ts`: Add env var documentation
- `README.md`: Add provider setup instructions
- `docs/providers.md`: Add setup instructions, env var, and `auth.json` key

### 7. Documentation

- `packages/ai/README.md`: Add to providers table, document options/auth, add env vars
- `packages/ai/CHANGELOG.md`: Add entry under `## [Unreleased]`

## Releasing

This fork publishes four packages to npm under `@leanandmean/` in lockstep:
- `@leanandmean/pi-tui`
- `@leanandmean/pi-ai`
- `@leanandmean/pi-agent-core`
- `@leanandmean/pi-coding-agent`

All four share the same version. The release workflow renames them from `@earendil-works/` to `@leanandmean/` and rewrites inter-package deps at publish time. Source always uses `@earendil-works/` names for workspace resolution.

### Version scheme

`<upstream-base>-scramjet.<N>` — e.g. `0.74.0-scramjet.1`, `0.74.0-scramjet.4`.

Increment `<N>` for fork-only changes within the same upstream base. When merging a
new upstream version, carry the current `<N>` forward (e.g., `0.74.0-scramjet.4` →
`0.75.0-scramjet.4`). This keeps the scramjet number monotonically reflecting the
fork's patch generation, independent of upstream.

### Steps

1. **Ensure the scoped check passes** (pre-commit hook runs this automatically).

2. **Bump the version** in all four packages:
   ```bash
   npm version 0.74.0-scramjet.4 --no-git-tag-version \
     -w packages/tui -w packages/ai -w packages/agent -w packages/coding-agent
   ```

3. **Do NOT rename packages.** Source must keep `@earendil-works/` names for workspace resolution.
   The release workflow renames to `@leanandmean/` at publish time.

4. **Commit and push**:
   ```bash
   git add packages/tui/package.json packages/ai/package.json \
     packages/agent/package.json packages/coding-agent/package.json
   git commit -m "Release @leanandmean/pi-*@0.74.0-scramjet.4"
   git push
   ```

5. **Create the release** (triggers CI publish via `.github/workflows/release.yml`):
   ```bash
   gh release create v0.74.0-scramjet.4 --title "v0.74.0-scramjet.4" --notes "<release notes>"
   ```
   CI builds all four packages, renames them to `@leanandmean/`, rewrites inter-package
   deps to exact versions, and publishes in dependency order with `--tag scramjet`.

6. **Update scramjet** (`~/repos/scramjet/package.json`) — all four aliases:
   ```json
   "@earendil-works/pi-tui": "npm:@leanandmean/pi-tui@0.74.0-scramjet.4",
   "@earendil-works/pi-ai": "npm:@leanandmean/pi-ai@0.74.0-scramjet.4",
   "@earendil-works/pi-agent-core": "npm:@leanandmean/pi-agent-core@0.74.0-scramjet.4",
   "@earendil-works/pi-coding-agent": "npm:@leanandmean/pi-coding-agent@0.74.0-scramjet.4"
   ```
   Scramjet directly imports from `coding-agent` and `tui`; `ai` and `agent-core` are
   aliased so that transitive imports resolve to our fork instead of upstream.

### What NOT to do

- Do NOT run `npm run release:patch` / `npm run release:minor` — those are upstream scripts
- Do NOT use the upstream `scripts/release.mjs`
- Do NOT run `npm publish` locally — CI handles it on tag push
- Do NOT rename packages in source — only the release workflow does this

## Incorporating Upstream Versions

When the upstream pi repo releases a new version, incorporate it using a merge strategy.

### Version scheme on upgrade

The version becomes `<new-upstream-version>-scramjet.<N>` where `<N>` carries forward from
the current fork version. For example, if the fork is at `0.74.0-scramjet.4` and upstream
releases `0.75.0`, the next fork version is `0.75.0-scramjet.4` (same scramjet number,
new base). Increment `<N>` only for fork-only changes within the same upstream base.

### Workflow

1. **Create an issue** (e.g., "Merge upstream v0.75.0 into fork"). Note the upstream tag and any known high-risk files from a quick `git diff` scan.

2. **Create a feature branch and merge upstream**:
   ```bash
   git fetch upstream
   git checkout -b merge/v0.75.0
   git merge upstream/v0.75.0
   ```
   Use merge (not rebase) — rebase rewrites history and requires force-push, which is
   prohibited. Merge preserves all existing SHAs and is safe for published branches.

3. **Resolve conflicts**:
   - `package-lock.json`: accept upstream's version entirely, then run `npm install` to
     regenerate with correct platform bindings. Never manually resolve lockfile conflicts.
   - `packages/web-ui/`: accept all upstream changes without modification (we don't publish it).
   - `.github/workflows/`: keep ours — upstream CI is completely different.
   - `AGENTS.md`: keep ours.
   - For semantic conflicts in high-risk files (see below), use `/mach12:issue-plan` to
     produce a structured resolution plan.

4. **After resolution**: update all four package versions to `<new-upstream>-scramjet.<N>`,
   update internal dep ranges to match (e.g., `^0.75.0-scramjet.4`), run `npm install`,
   verify the scoped build passes:
   ```bash
   npm run build -w packages/tui -w packages/ai -w packages/agent -w packages/coding-agent
   ```

5. **Open a PR, run reviews** to catch regressions: did upstream remove/rename APIs we
   depend on? Did provider behavior change in ways that break our sectioned prompt patches?
   Check `~/repos/scramjet` imports against the new types.

6. **Merge the PR, release** following the normal release steps. The new version is
   `<upstream-version>-scramjet.<N>`.

### High-risk files

These are where our fork diverges most from upstream. Expect conflicts here:

- `packages/ai/src/types.ts` — `SystemPromptSection` type
- `packages/ai/src/providers/anthropic.ts` — structured system blocks
- `packages/ai/src/utils/system-prompt.ts` — `flattenSystemPrompt` (fork-only file)
- `packages/ai/src/index.ts` — re-exports of fork additions
- `packages/agent/src/types.ts` — `systemPrompt: string | SystemPromptSection[]`
- `packages/coding-agent/src/core/extensions/types.ts` — `dispatchUserInput`, `newSession`, `systemPromptSections`
- `packages/coding-agent/src/core/extensions/runner.ts` — sectioned prompt handling, dispatch binding
- `packages/coding-agent/src/core/agent-session.ts` — sectioned prompt integration
- `packages/coding-agent/src/core/system-prompt.ts` — `buildSystemPromptSections`
- `.github/workflows/` — CI and release (ours differ completely from upstream)
- `AGENTS.md` — fork-specific docs

### Rules

- One minor/major upstream version per issue. Patch releases within the same minor can be batched (merge directly onto the latest patch).
- Use merge, not rebase. Rebase requires force-push which is prohibited and rewrites published history.
- After merge, always verify: `npm install && npm run build -w packages/tui -w packages/ai -w packages/agent -w packages/coding-agent` succeeds.
- If upstream renamed or removed an API that scramjet uses, fix it in this repo before releasing. Check `~/repos/scramjet` imports against the new types.
- For `packages/web-ui/` conflicts: always accept upstream. We do not modify or publish it.

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session
- It is always fine to include `packages/ai/src/models.generated.ts` in a commit alongside the actual files you want to commit

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work
- `git commit --no-verify` - bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

### User override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.
