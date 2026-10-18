# secret-box

A Claude Code mod that lets Claude use a secret without ever seeing it. When Claude needs an API key, it calls a `request_secret` tool, a masked box opens, you paste the key, and the mod saves it to the macOS Keychain or Windows Credential Manager (or, with `backend: dotenv`, to `.env`). A key already there is loaded with `use_secret`. The vault parts work on macOS and Windows; elsewhere the box writes `.env` as it always did. Claude gets a placeholder like `[REDACTED-SECRET-3f9a1c2e]` instead of the value, and the placeholder turns into the real key whenever a tool runs. Any key a tool prints comes back to Claude as a placeholder, and committing `.env` is refused.

![secret-box: on the left Claude calls secret-box - request_secret for STRIPE_SECRET_KEY and waits; on the right the secret box pane asks for STRIPE_SECRET_KEY with the reason, and the value field shows only dots; below, the four steps: Claude calls a tool, you paste into a masked box, the mod writes .env and .gitignore (the dotenv backend, shown here; on macOS the default saves to the Keychain instead), Claude gets a placeholder that turns into the key when a tool runs](screenshot.png)

A key that reaches the conversation is in the transcript for good. It is sent to the model on every turn after, kept in the session file on disk, and replayed into every fork of the session. You can't take it back afterwards, so the only fix is to never send it. Keys get in two ways: you paste one, or a tool prints one (a `cat .env`, a config file, an API answer). secret-box closes both, and still lets Claude run the code that needs the key.

- **A tool to ask with.** `request_secret` takes a variable name and a one-line reason. Its description tells Claude to use it instead of asking you to paste.
- **A masked box.** A pane opens beside the transcript with the field already focused. It only ever draws dots and a character count.
- **A placeholder to use.** The mod saves the value to the Keychain (with `backend: dotenv`, it writes `NAME=value` to `.env` and makes sure `.gitignore` covers it), then tells Claude the name and a placeholder. Claude puts the placeholder in a command: `curl -u [REDACTED-SECRET-3f9a1c2e]: https://api.stripe.com/v1/balance` runs with the real key. A file Claude writes gets the real key too, but see the file-history tip under Keychain backend before relying on that.
- **Placeholders on the way out.** Every tool result is scanned before Claude sees it. About 70 vendor key shapes (`sk_live_`, `ghp_`, `AKIA`, `xoxb-` and more), any key shaped like a short lowercase prefix and a long random body (`imp_` and 40 hex), passwords on CLI flags and in connection strings, base64 that decodes to a key, high-entropy tokens, every `.env` value with a secret name, and every value the mod already knows come back as placeholders. `cat .env` still shows `PORT=3000`.
- **Placeholders on the way in.** A key you paste into the prompt by mistake is swapped for a placeholder before Claude reads it.
- **Never committed.** `git add .env` and a `git commit` that would carry a `.env` file are refused, because a pushed key can't be taken back.

![Using a key without seeing it: Claude writes the placeholder into a Bash command, the shell runs it with the real key, and Claude reads back length 27 and first 8 characters sk_test_](images/use.png)

![On the way out: cat .env shows PORT=3000 and placeholders for STRIPE_SECRET_KEY and DB_PASSWORD, echo of the password comes back as the placeholder, and a git commit with .env staged is refused](images/guard.png)

## Install

```
claude plugin marketplace add ray-amjad/claude-code-mods
claude plugin install secret-box@claude-code-mods
```

Or inside Claude Code: `/plugin marketplace add ray-amjad/claude-code-mods`, then `/plugin install secret-box@claude-code-mods`.

## Usage

Ask for something that needs a secret, such as `billing.js needs the Stripe secret key, get it set up`. Claude calls `secret-box - request_secret`.

- **Paste** the value into the box. It shows dots and a character count.
- **Enter** saves it. A toast says where it went, and Claude gets the placeholder.
- **Esc** cancels. Claude is told you cancelled and nothing is written.

Then ask Claude to use it: `check the key works`. It writes the placeholder into a command and the real key is used. A tool row says `secret-box: hid 1 value(s)` whenever something was swapped on the way out.

If you'd rather not wait for Claude to think of the tool, say `use the secret box to ask me for STRIPE_SECRET_KEY`.

### Try it on the example

The [`example`](example) folder is a tiny app whose `billing.js` reads `STRIPE_SECRET_KEY`, with a `.env.example` beside it.

```
cp -R example /tmp/shop && cd /tmp/shop && git init
claude
```

Accept the trust prompt (mods don't load in an untrusted folder). Tell Claude `billing.js needs the Stripe secret key`, paste a fake key such as `sk_test_123`, and press Enter. Then ask `prove the key is in .env without showing it to me`, and `cat .env` to see the placeholder.

## Keychain backend (macOS)

On macOS the box saves a key to the Keychain as a generic password by default (`backend: auto`): the name Claude asked for is the service, and your macOS user name is the account (set `keychainAccount` to change it). Nothing is written to `.env` or `.gitignore`. Set `backend` to `dotenv` for the `.env` behavior. `use_secret` and the masking of direct reads below are on whenever the Mac is, whatever `backend` says. On other systems they don't exist and `auto` means `dotenv`. The mod asks `/usr/bin/uname` (or `/bin/uname`) which system it is on. Where there is no uname (NixOS, Termux), it looks for macOS's `/System/Library/CoreServices/SystemVersion.plist`. If even that can't be checked, `use_secret` stays on, a toast says so, and with `auto` the box saves nothing until you set `backend` to `keychain` or `dotenv`. `.env` files are still learned in both modes, so projects that keep one stay covered.

**Adding a key by hand.** In a terminal:

```
security add-generic-password -s OPENAI_API_KEY -a "$USER" -w
```

With `-w` last, `security` prompts for the value, so the key never lands in your shell history. Add `-U` to replace an item that is already there.

**How Claude asks for it.** Claude calls `secret-box - use_secret` with the service name, and the account when several items share that service. The mod runs `/usr/bin/security find-generic-password -s NAME -g` itself, by argv with no shell, and never hands Claude the value. Usually Claude gets a placeholder. A value with a space or a shell character (`$`, `&`, `#`, quotes, common in website passwords) can't go into a command as a placeholder, so Claude gets `"$(/usr/bin/security find-generic-password -s NAME -w)"` to put where the value goes. Inside a string that is already in double quotes, it uses the `$(…)` part alone (`-H "Authorization: Bearer $(…)"`), so the value stays one word. The shell reads the item as the command runs, so the value never appears in the command text, and the mod hides what the command prints. Either way, Claude is told never to write the value into a file. The items you already have work as they are, with no required prefix. If the item is missing, Claude gets the `security add-generic-password -U` command above to pass on to you; if the keychain is locked or access was refused, it asks you to unlock it or allow access. Ask for it by name if Claude doesn't think of it: `use_secret OPENAI_API_KEY and check the key works`.

**A direct read is masked too.** If Claude runs `security find-generic-password … -w` (or `-g`, or `find-internet-password`) in Bash anyway, the mod first reads the item that command reads, with the same match options (`-s`, `-a`, `-l` and the rest) and keychain files, and hides every form `security` prints it in. For a value with a newline, a tab or any non-ASCII character, `-w` prints hex instead of the text, and that is hidden as well, along with each line of 8 characters or more. `$USER`, `$LOGNAME`, `$HOME` and `~/` are resolved unless the command could change them. Every Bash command is checked, however it spells the read. This turns the usual accident into a harmless one; it isn't a wall.

Some reads can't be pinned to one item or hidden. By default these run as written, and only the detector scans their output, which doesn't hide bare hex. Set `refuseUnmaskable` to refuse them instead. They are:

- a variable the mod doesn't hold, or one the command sets
- `sudo` or another prefix
- a keychain file given by a relative path
- a read inside a quoted `sh -c` script
- `security -i`
- `dump-keychain`
- a value under 8 characters
- a failed fetch or a locked keychain

**Multi-line values.** A value with a newline (a PEM key, say) can't be put into a Bash command: the redactor won't restore it, and `-w` prints it as hex, so the read-it command above won't work either. `use_secret` says so and hands out nothing for Bash. Writing it to a file with Write would put a copy in file history (below). Instead, save it base64-encoded, `security add-generic-password -U -s NAME -a "$USER" -w "$(base64 -i key.pem)"`, and decode it straight into what needs it: `printf '%s' [REDACTED-SECRET-…] | base64 -d | ssh-add -`. Don't let the decoded text print. The vault knows the base64 form, not the decoded one.

**Threat model.** The goal is to keep keys out of anything written to disk under `~/.claude/` (transcripts, file history) and out of plaintext files in your projects. The concern is an attacker on the machine, an exfiltrated transcript, or device-management/DLP software finding a key on disk. It is not a sandbox against the agent: deliberate exfiltration is out of scope (see Limits).

**Tip: file history.** Claude Code copies a file to `~/.claude/file-history/` before Write or Edit changes it, so a key Claude writes into a file is copied there in plaintext. Keep keys out of files (use the placeholder in Bash commands), or set `"fileCheckpointingEnabled": false` in that project's `.claude/settings.json`. That costs `/rewind`'s code restore in that project.

- The box hands the value to `security add-generic-password` in its argv, so `ps` can see it while that command runs. The mod writes it nowhere else. But `$.process.run` is a hookable event, so any other mod you have installed can see the argv of the save, and the output of each Keychain read the mod makes.
- An item another app created may make macOS ask whether `security` can read it. Allow it, or the read fails and Claude is told the item could not be read.
- A Keychain value under 8 characters is restored into commands, but it can't be hidden where it turns up later. A direct `-w` read of such a value prints it in the clear, into the transcript (the same limit as `.env`).

## Credential Manager backend (Windows)

On Windows the same flow runs on Windows Credential Manager, which every Windows 10 and 11 has: nothing to install but [Git for Windows](https://gitforwindows.org), which Claude Code's Bash tool already needs. With `backend: auto` the box saves a key there as a generic credential: the name Claude asked for is the credential's target name (the service), your Windows user name is its user name (the account), and the comment `secret-box` tags it for `list_key_names`. `.env` pointers, `keychain-env`, `use_secret`, `list_key_names`, `migrate_env_to_keychain`, the commit guard and the masking of direct reads all work as on macOS, and the pointer syntax is the same `keychain:` on both, so one `.env` file serves a team on both systems. The mod knows it is on Windows from the `OS` variable.

The mod reads and writes items with [`bin/credman.ps1`](bin/credman.ps1), run under Windows PowerShell 5.1 by its full path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, so no `powershell.exe` earlier on `PATH` is handed a key), with `-ExecutionPolicy Bypass` for that one process. The service, the account and the value go in on stdin as hex, never in the command line, where any process of yours could read them. Each call takes about a third of a second.

**Use the Bash tool.** A placeholder becomes the real value only in the Bash tool, which on Windows is Git Bash: the redactor's rules for what may safely go into a command are Bash's. A PowerShell command that holds a placeholder is refused, with a note to Claude to run it in Bash instead; left to run, it would use the placeholder's own text. PowerShell output is still masked, `.env` files it reads are still learned, and `git add .env` from PowerShell is still refused.

**Adding a key by hand.** In your own terminal window (not at Claude's prompt with `!`, which has no terminal to prompt in):

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\secret-box\bin\credman.ps1" add -Service OPENAI_API_KEY
```

It prompts for the value with the typing hidden, saves it under your Windows user name and tags it. Add `-Account NAME` for another account. `cmdkey /generic:OPENAI_API_KEY /user:%USERNAME% /pass` works too (it prompts when `/pass` has no value), but leaves the item untagged, so `list_key_names` shows it only through `listPrefixes`. `credman.ps1 delete -Service NAME` removes one. Claude gives you the exact path.

**How Claude asks for it.** `use_secret NAME` reads the item and answers with a placeholder. For a value with a space or a shell character, Claude gets `"$(C:/path/to/secret-box/bin/credman get -s NAME)"` to put where the value goes: [`bin/credman`](bin/credman) is a Git Bash script that runs `credman.ps1 get`, which prints a printable value as it is and refuses anything else. If Claude runs `bin/credman get` (or `credman.ps1 get`) itself, in Bash or PowerShell, the mod reads the same item first and hides what the command prints, as with `security` on macOS. Reads it can't pin down follow `refuseUnmaskable`.

**Differences from the Keychain:**

- **No access prompt.** macOS asks before an app reads an item another app made. Credential Manager asks no one: any process running as you can read every generic credential. This fits the threat model (keys out of transcripts and plaintext files, not a wall against the agent or your own programs), but it is weaker than the Keychain.
- **One account per service.** A target name is unique, so variants of one key (personal, work) need different services (`openai`, `openai/work`), not different accounts. Saving a service that is held under another account is refused rather than overwritten; a pointer's `?account=` must match the item's user name.
- **2560 bytes per value** (Credential Manager's limit). The mod stores UTF-16LE as `cmdkey` does, or UTF-8 for an ASCII value too long for that, and reads both, so items other tools wrote in either encoding read as they are.
- **Line endings.** `bin/keychain-env` and `bin/credman` are bash scripts; `.gitattributes` keeps them LF on a checkout with `core.autocrlf` on, which Git for Windows sets by default.
- **Managed machines.** Where device policy (AppLocker, WDAC) puts PowerShell in Constrained Language Mode, `credman.ps1` can't load its Credential Manager calls, and where Group Policy sets the execution policy, `-ExecutionPolicy Bypass` is overridden and the script won't run. Either way every read fails with a plain error; set `backend` to `dotenv` there.
- Paths Claude is given use forward slashes (`C:/Users/…/bin/keychain-env`), which Git Bash takes and a backslash path would not survive. The allow rule for the runner is `Bash(C:/path/to/secret-box/bin/keychain-env:*)`.

## .env pointers and keychain-env (macOS and Windows)

A `.env` file can name Keychain items (on Windows, Credential Manager items) instead of holding keys. A pointer is the value `keychain:SERVICE`, or `keychain:SERVICE?account=ACCOUNT`:

```
# .env: safe to commit, it holds no key
OPENAI_API_KEY=keychain:openai
STRIPE_SECRET_KEY=keychain:myapp/STRIPE_SECRET_KEY?account=work
DATABASE_PASSWORD=keychain:myapp/DATABASE_PASSWORD
PORT=3000
```

Pointers are printable ASCII. Percent-encode anything outside `A-Z a-z 0-9 . _ ~ : @ / + , ; = ! * -` (a space is `%20`). Without `?account=`, the first item with that service is used. Add the items by hand with `security add-generic-password -U -s myapp/STRIPE_SECRET_KEY -a work -j secret-box -w` (it prompts for the value), or let Claude ask for them with the box.

Nothing reads a pointer at session start. They are resolved only when needed:

- **`keychain-env`**, a runner in the plugin's `bin/` folder, runs an app with its pointers set: `/path/to/secret-box/bin/keychain-env -- npm start`. It reads `./.env` (or each `--env-file PATH`), reads every pointer from the Keychain with `/usr/bin/security`, exports it, then runs the command in its place. It never prints a value, and it stops before the app starts if a pointer can't be read. Lines that aren't pointers are left to the app's own `.env` loader; most loaders don't override a variable that is already set. When Claude runs it, the mod first reads every pointer the runner will read, so whatever the app prints of them comes back hidden. A runner call the mod can't pin down (a `cd` before it, an `--env-file` from a variable) goes to `refuseUnmaskable`. Claude is given the runner's absolute path in `use_secret` and `list_key_names`.
- **`use_secret NAME`** accepts a variable name. With no account given, a variable in the project's `.env` files whose value is a pointer names the item, ahead of a service of the same name. If the files point one name at different items, it asks which. With an account given, the name is always a service.

Pointers stay readable. The detector would otherwise take `OPENAI_API_KEY=keychain:openai` for a password, so the mod puts pointer text back wherever it was hidden. A `.env` file whose keys are all pointers may be staged and committed. The commit guard allows it only when all of these hold:

- the file holds at least one pointer
- the Keychain holds the item each pointer names
- every secret-named value is a pointer or empty
- every quote closes on its own line
- the detector finds no key anywhere else in the file

The guard checks for each item with `security find-generic-password -s SERVICE [-a ACCOUNT]`, attributes only, so no password is read and nothing prompts. A missing item refuses the commit, and so does a check that can't run. Any other `.env` file is refused as before.

Some names can't be told apart from a key: 16 or more hex digits, a UUID, or 20 or more letters and digits mixed with no `/ . - _` or space between them. Datadog, Algolia and Twilio keys and UUID API keys look like this, and the detector leaves those shapes alone on purpose. A pointer whose service or account looks like that is treated as a key: it stays hidden and can't be committed. Name items the usual way instead (`myapp/STRIPE_SECRET_KEY`, `openai`).

A key under 8 characters that the mod never handled itself can't be told from a short service name, so after `keychain:` it shows. Claude can't write a placeholder after `keychain:`; that write is refused.

Names: a key one project uses gets service `PROJECTDIR/ENV_NAME`. A key shared across projects gets a short name (`openai`). Variants of one key (personal, work) share a service and differ by account. The default account is your login name.

`keychain-env` handles single-line values only. A value `security -w` prints as hex (one with a newline, a tab or a non-ASCII character) is refused; store such a value base64-encoded, as under Keychain backend.

## list_key_names (macOS and Windows)

`list_key_names` returns key names only and never fetches or returns any key's value. It lists:

- the pointers in the project's `.env` files (variable, service, account)
- the Keychain items secret-box saved: the box and `migrate_env_to_keychain` tag each item with the comment `secret-box`
- the Keychain items whose service starts with one of the `listPrefixes` you set (`myapp/,openai`)

It never lists the whole keychain. It reads the names with `security dump-keychain` (without `-d`, which would include passwords), filters them inside the mod, and never returns the raw output. To make an existing item show up, re-save it with the tag (`security add-generic-password -U -s SERVICE -a ACCOUNT -j secret-box -w`, which prompts for the value again), or set `listPrefixes` to its service's prefix.

## migrate_env_to_keychain (macOS and Windows)

`migrate_env_to_keychain` moves plaintext keys from one `.env` file into the Keychain. By default it moves every secret-named entry; give `names` to choose. It works on one entry at a time:

1. It saves the value as service `PROJECTDIR/NAME`, account `$USER` (or `keychainAccount`), tagged for `list_key_names`.
2. It reads the value back and compares it.
3. Only then does it rewrite that line as a pointer.

Any failure leaves the line as it was, including an item that already holds a different value, which it never overwrites. It rewrites the file with the mod's own file access, not the Write tool, so no copy of the old values lands in `~/.claude/file-history/`. It writes no backup. It never returns a value.

A tool a mod answers itself gets no approval prompt from Claude Code, so the mod asks you in a dialog before it changes anything. A permission rule that allows or denies `mcp__secret-box__migrate_env_to_keychain` is honored instead.

## Approving calls that use a key

Claude Code checks a call's permission after secret-box has put the real values in. Left alone, its approval dialog would show the key, and in auto mode its classifier would read the key and often refuse the call. So for a call it filled with real values, secret-box answers the permission check on the call as Claude wrote it (`ownApproval`, on by default):

1. Claude Code's own verdict comes first. If your rules, the mode or a hook allow or deny the call, that stands.
2. If Claude Code would ask, secret-box asks your permission rules about the call as written, placeholders and all. A rule that allows or denies it decides.
3. In plan mode, secret-box refuses the call, so Claude Code's own dialog never opens with the key in it. Claude is told the step waits until plan mode ends and to put it in the plan instead.
4. With no one to ask (`claude -p`), Claude Code's verdict goes on unchanged. In dontAsk mode it does too, and the mode refuses the call as it would any other, with no dialog. secret-box never allows a call there.
5. Otherwise secret-box allows the call, so you aren't asked about every command that uses a key. The key is filled in only while the call runs, and nothing you or Claude see shows it.
6. With `ownPrompt` on, secret-box asks you instead, in its own short prompt: the call as written, with placeholders, and the keys it uses, never their values. Anything but Allow, closing the prompt included, refuses the call. It also asks, whatever `ownPrompt` says, if it hasn't yet learned which permission mode the session is in.

The tradeoff of step 5: in auto mode the classifier doesn't review a call secret-box allows, so it skips the rest of that command too, not only the key. Turn `ownPrompt` on if you'd rather approve each one. Calls with no placeholder put back are untouched. Set `ownApproval` to `false` to have Claude Code check the call with the real values in it, as before.

**A placeholder from before a reload.** The vault lives in memory, so when secret-box reloads (a new session, or an edit to the mod while it runs) every placeholder it handed out stops standing for anything. A call that still uses one is refused before it runs, and Claude is told to load the key again with `use_secret`. Left alone, the command would run with the placeholder's own text. A placeholder that already sits in a file as text can still be edited out of it.

**An allow rule for running an app.** A command that runs an app through `keychain-env` holds no placeholder, so Claude Code checks it as usual, and auto mode's classifier may refuse it as credential access. Add one allow rule for the runner in the project's `.claude/settings.local.json` (not committed: the runner's path is this machine's):

```json
{ "permissions": { "allow": ["Bash(/path/to/secret-box/bin/keychain-env:*)"] } }
```

Claude gives you the exact line, with the runner's absolute path filled in. The rule covers every command run through the runner, so you aren't asked again for each one.

## How Claude finds all this

Installing the plugin is enough. Once per session, at the first sign of keys in play, the mod adds a short note to what Claude reads, and you don't see it. Those signs are: the session starts in a folder with `.env` files, Claude touches a `.env` file, or a key is hidden from a tool's result. The note says secret-box is installed, gives the pointer syntax and the runner's path, and tells Claude to load the `secret-box:secrets` skill. When a `.env` file holds plaintext keys, it also offers `migrate_env_to_keychain`.

The skill teaches the rules: never ask for a key in chat, find keys with `list_key_names`, use exactly what `use_secret` returns, run apps through `keychain-env`, and write pointers, never values. Run it yourself as `/secret-box:secrets setup` to set up a project: Claude writes the `.env` pointers and hands you one `security add-generic-password … -w` line per missing key, so the values go from your keyboard straight into the Keychain. Run those lines in your own terminal window, not at Claude's prompt with `!`. Claude Code runs `!` commands without terminal input, so `security` can't prompt and saves an empty value.

## Settings

Set them with `/plugin configure secret-box@claude-code-mods`, or under `pluginConfigs` in your user settings.

| Option | Default | What it does |
| :- | :- | :- |
| `backend` | `auto` | Where the box saves: `auto` (the Keychain on macOS, Credential Manager on Windows, `.env` elsewhere), `keychain` (that vault; refused elsewhere rather than falling back to a plaintext file) or `dotenv` (the project `.env`) |
| `keychainAccount` | empty | The account the box saves Keychain (or Credential Manager) items under. Empty means your macOS user name, or on Windows `%USERNAME%` |
| `listPrefixes` | empty | macOS and Windows: service prefixes, comma separated, whose Keychain items `list_key_names` shows beside the ones secret-box saved |
| `refuseUnmaskable` | `false` | macOS and Windows: refuse a Bash command that reads the Keychain (or Credential Manager) in a way the mod can't pin to one item or hide (listed under Keychain backend), instead of letting it run |
| `secrets` | `true` | Hide secrets in tool output and prompts |
| `pii` | `false` | Hide email addresses and public IP addresses |
| `hideEmails` | `true` | With `pii` on, also hide emails; turn off to hide only IPs |
| `redactPrivateIps` | `false` | With `pii` on, also hide private and reserved IPs recognized by the detector |
| `restoreInToolInputs` | `true` | Turn placeholders back into real values before a tool runs |
| `restoreTools` | `Bash,Write,Edit,MultiEdit,NotebookEdit` | The tools that may receive a real value. Tools that send data off the machine are left out on purpose |
| `ownApproval` | `true` | Decide the approval of a call that got real values on the call as written: your rules first, then an allow, or secret-box's own prompt with `ownPrompt` on (see Approving calls that use a key). In plan mode it refuses the call; in dontAsk mode Claude Code's verdict stands. Off, Claude Code checks the call with the real values in it |
| `ownPrompt` | `false` | With `ownApproval` on, ask you in secret-box's own prompt before a call that uses a key, when your rules don't decide it. Off, such a call is allowed, and auto mode's classifier skips the whole command |
| `notify` | `true` | A count on the tool row, a toast on a prompt |
| `minEntropy` | `3.6` | Bits per character for the high-entropy test |
| `minLength` | `24` | Shortest token the high-entropy test looks at |
| `contextMinEntropy` | `3.0` | The floor when `API_KEY=`, `"token":` or `Bearer` sits in front |
| `allow` | empty | Exact strings never to hide, comma separated |
| `allowEmails` | empty | Addresses or `@domain.com` never to hide |
| `allowPrefixes` | empty | Extra id prefixes to treat as public |
| `allowUrlHosts` | empty | Hosts (`app.todoist.com`, `localhost:3000`, `*.example.com`) whose link paths are kept as written. A host covers itself only; `*.` covers its subdomains. The query string and fragment are still scanned, and a vendor-shaped key in the path is still hidden. Don't list a host that puts credentials in the path (Slack webhooks, Telegram bot links, presigned links): a random-looking secret there would be kept too |
| `denyPrefixes` | empty | Prefixes to test even though they look like a public id |

Stripe object ids (`price_`, `prod_`, `cus_`, `pk_live_` and so on) are public and are never hidden. Neither are git SHAs, file paths or names written in code.

## How it works

- `session.start` registers the tool with `isDeferred: false`, so Claude sees it on every turn, and reads `.env` in the working directory to learn which values are secret.
- The box is a pane opened with `$.ui.open` and an `Input`. The element has no password mode, so the mod masks it itself: the field draws `•` repeated, and `onInput` works out what was typed, pasted or deleted and keeps the real value in a module variable. A hook may only run for 10 seconds of its own time, but time inside a mods API call doesn't count, so it waits for you in short `$.process.run(['sleep', '0.3'])` calls (on Windows, which has no `sleep`, a 300 ms `node -e` wait, or a `ping` of 1 second where node is not installed).
- On Enter the mod writes `.env` with `$.fs` and hands the value to the vault, which answers with the placeholder. The vault maps each value to a random placeholder that stays stable within the session, and lives in memory only.
- The redaction is [transcript-redactor](../transcript-redactor), in `hooks/redact.ts` and `hooks/detect.ts`. `register.jsx` calls its `register` and adds only what secret-box needs. Its hooks hide keys in your prompt, CLAUDE.md, tool results, `@` files, the engine's own attachments and subagent tasks, and put real values back into `Bash`, `Write` and `Edit`. A value restored into a command is hidden again if the command prints it. `redact.ts` adds one thing to the redactor: its `tool.call` hook records each call it filled (by `tool_use_id`, the call as written and the placeholders used) until the call ends, and a `tool.check` hook answers those calls' permission check as described under Approving calls that use a key.
- secret-box's own tools answer you in one short line (`Loaded openai from the Keychain as [REDACTED-SECRET-1a2b3c4d].`). The instructions for Claude ride in the answer's context, which Claude reads and you don't see. A refusal can't carry context, so a `ui.render` hook on `ToolResult` draws each of secret-box's refusals as one calm line in your view instead; Claude reads the full text.
- Before a tool reads a `.env` file, a `tool.call` hook reads it too and gives every value whose name says secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD` and the like) to the vault. So even a weak value the detector would miss, like a word password, comes back as a placeholder.
- A `tool.call` hook on `Bash` refuses `git add` of a `.env` file and runs `git diff --cached --name-only` before any `git commit`. A `prompt.mention` hook refuses `@.env`, which would attach the raw file.
- Every hook that guards has a `.catch` that fails closed: if a scan breaks, the output is withheld or the call is refused.

## Limits

- **It hides what Claude reads, not what Claude does.** With a placeholder Claude can still run a command that transforms the key (`base64`, `rev`) or sends it somewhere, and the transformed output isn't recognized. This stops keys from landing in the transcript by accident. It is not a sandbox against a model that is trying to leak one.
- **In auto mode, Claude Code's classifier blocks `cat .env`** and `source .env` as credential access before secret-box sees them. In default mode, approve the read and it comes back masked. Without `ownApproval`, a placeholder command is no sure way through either: in testing the classifier read the command with the real key in it, took about 25 s, allowed it once and then refused it as credential materialization. A command that reads a key by name (`"$(security … -w)"`) was refused the same way. In auto mode, keep `ownApproval` on (see Approving calls that use a key) and add the allow rule for `keychain-env`.
- **Terminals under 144 columns.** Claude Code won't place a pane the user didn't open, so the box draws in the band above the prompt instead, and you press Ctrl+X then Tab to type in it. Wider, or with fullscreen rendering, it docks beside the transcript.
- **The masking is the mod's.** A paste can show for one frame before it is redrawn as dots. Editing in the middle of the field with the arrow keys isn't tracked.
- **No restore when publishing.** A command that runs `git commit` or `gh issue`, `gh pr` (and the like) gets no real values, so a commit message keeps the placeholder. A step that needs the key has to be its own command.
- **Files Claude writes get the real value.** A placeholder in a file Claude writes with `Write` or `Edit` lands on disk as the key.
- **A `.env` value under 8 characters** is hidden in `.env` reads, but not wherever else it turns up.
- **The vault is memory only.** Placeholders from an earlier session mean nothing in a new one. The mod relearns `.env` at the start of each session, so those values are hidden again.
- **Only the working directory's `.env` is learned** at session start. Other `.env` files are masked by name when they are read.
- `claude -p` has no one to type, so the tool answers that it needs an interactive session.
- If your CLAUDE.md says secrets go somewhere else (a vault, a secrets manager), Claude follows that and may not offer the box. Ask for it by name.
- Mods only load in a folder you have trusted. In a brand new repo, accept the trust prompt first.

## Develop

```
claude --plugin-dir ./secret-box
claude plugin validate .
claude plugin test .
node --experimental-strip-types tests/detect.test.mts
```

`tests/secret-box.test.ts` covers the guard, `.env` values and the round trip from placeholder to value. `tests/keychain.test.ts` covers `use_secret`, the parser for Keychain reads in Bash (including two items sharing a service), both backends of the box and both platforms. `tests/keychain-v2.test.ts` covers pointers, `keychain-env`'s pre-load, the commit guard, `list_key_names`, `migrate_env_to_keychain` and the once-per-session note. `tests/own-approval.test.ts` covers each branch of the permission check for calls the mod filled, under both `ownPrompt` settings and in each permission mode. `tests/keychain-v3.test.ts` covers placeholders from before a reload, errored answers, the one-line answers of secret-box's tools and the rows drawn for its refusals. The keychain tests use `tests/fake-mac.ts`, a fake `security` that prints what the real one does. `bin/keychain-env` is checked against the real Keychain. `tests/detect.test.mts` is transcript-redactor's detector test: 174 values that must be hidden and 114 that must be kept.

`tests/credman.test.ts` covers the Windows backend through `tests/fake-win.ts`, a fake Windows whose fake `credman.ps1` answers with the real one's exit codes and output shapes: the tools and their wording, use_secret and the box with nothing but hex on stdin and no value or name in argv, the `bin/credman get` read form, list_key_names, migration (the service from a `C:` folder), the commit guard, the PowerShell guard, and the pre-load of a `credman get` in Bash or PowerShell, with a table for the Windows command parser. `bin/credman.ps1` and `bin/keychain-env` are checked against the real Credential Manager. On Windows, run the suite from Git Bash with `claude plugin test .`.

Tested with Claude Code 2.1.296 on macOS, and 2.1.303 on Windows 11 (Windows PowerShell 5.1, Git for Windows 2.55).

## Original redactor contributions

Random placeholder tags were contributed by [Ben Ellis (@benissimo)](https://github.com/ray-amjad/claude-code-mods/pull/1). The `hideEmails` option was contributed by [Cody Harris (@VibeCodyH)](https://github.com/ray-amjad/claude-code-mods/pull/2). Both implementations are adapted to this mod's current vault and hooks.

To keep emails readable while hiding public IPs, set `pii: true` and `hideEmails: false`. PII hiding remains off by default. The restored IP detector recognizes IPv4 and full-form IPv6; compressed IPv6 is not comprehensively covered.
