# AGENTS.md

Notes for an agent working in this repo. Read this before you write code.

## Layout

- `.claude-plugin/marketplace.json` lists every mod. A new mod is not installable until it has an entry here.
- `plugins/<name>/` is one mod: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming the hooks module, `tsconfig.json`, `README.md`, and its tests. A mod that keeps values in `$.state` also has `types/index.d.ts`, its state contract, named in `plugin.json` as `"types"`.
- `LICENSE` at the root covers every mod. Mods have no LICENSE or `.gitignore` of their own.

## Get the types first

Claude Code writes each mod's type declarations into `plugins/<name>/.claude-plugin/types/` when it loads the mod from a folder (`claude --plugin-dir plugins/<name>`, or a hot-reloaded mods folder). Every release rewrites them, so they are gitignored. Never write them by hand and never commit them. Once they are there, `tsc -p plugins/<name>` type-checks the mod; each `tsconfig.json` extends `./.claude-plugin/types/tsconfig.json`.

vercel-deploy-status is older and the exception: its `tsconfig.json` includes `../../types`, and its tests run on bare Node with `node --experimental-strip-types plugins/vercel-deploy-status/test/queue.test.mts`.

## Rules

1. **Check before you push.** For the mod you changed:

   ```bash
   claude plugin validate plugins/<name>
   claude plugin test plugins/<name>
   tsc -p plugins/<name>
   gitleaks dir . --config .gitleaks.toml
   ```

2. **Bump two versions together.** A mod's `version` lives in its `plugin.json` and in its entry in `.claude-plugin/marketplace.json`. They must match.
3. **Keep defaults neutral.** This is a public repo. No personal domains, emails, API keys or machine paths in a default value, a test or a screenshot.
4. **Install lines name this repo.** Every README installs with `/plugin install <name> --marketplace ray-amjad/claude-code-mods`, and option keys read `<name>@claude-code-mods`.

## Secret detectors

transcript-redactor and secret-box share one detector: secret-box carries transcript-redactor's `hooks/redact.ts` and `hooks/detect.ts` unchanged. Change it in transcript-redactor and copy the two files across, so they never drift.

The detectors' tests hold fake keys on purpose, and `hooks/detect.ts` has example tokens in its comments. `.gitleaks.toml` allowlists those paths. Every value there is invented. **Never put a real value in a test.** The allowlist would let a real key through in silence.

If you run a session with either mod active, the fake keys read as placeholders in your context. Copy those files with `cp` and edit them with targeted replacements. Never rewrite one whole from what you see, or you write a placeholder into git.

## vercel-deploy-status

`hooks/queue.ts` holds everything with no UI in it, and `test/queue.test.mts` covers it. Four runtime facts it ran into:

1. `$.clock.after` returns a `Timer` with `.cancel()`, not a bare function.
2. A `.map()` array is not a valid `Box` child. Wrap it in a Fragment (`<>…</>`).
3. `key` is a `Button` prop only. A `key` on a `Box` fails validation and the render falls back in silence.
4. Options are read from user settings only, under `pluginConfigs["<name>@<marketplace>"].options`.
