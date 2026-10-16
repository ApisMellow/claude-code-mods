import { expect, mock, test } from 'claude-code/testing'

import { boxBackend, keychainReads, SECURITY } from '../hooks/keychain'
import { unmaskable } from '../hooks/register'

const USE = 'mcp__secret-box__use_secret'
const BOX = 'mcp__secret-box__request_secret'
const TAG = /\[REDACTED-SECRET-[0-9a-f]{8}\]/
const HOME = '/Users/tester'
const LOGIN = `${HOME}/Library/Keychains/login.keychain-db`
const OTHER = `${HOME}/Library/Keychains/other.keychain-db`

// Fake Keychain values, built at run time: 48 hex characters, the shape of
// `openssl rand -hex 24`. Bare hex is a shape the detector leaves alone (it
// could be a hash), so only the vault can hide it.
const hex = (seed: number) => Array.from({ length: 48 }, (_, i) => ((i * 7 + seed * 5) % 16).toString(16)).join('')

// ------------------------------------------------- a `security` that answers like the real one

// What /usr/bin/security prints, from its real output on macOS (pinned below):
// -w prints the text, or lowercase hex when any byte is not printable ASCII;
// -g prints `password: "text"`, or hex and an escaped copy when any byte is
// not printable or is " or \, or `password: ` for an empty one.
const utf8 = (v: string) => (encodeURIComponent(v).match(/%..|./g) || []).map((c) => (c.length === 3 ? parseInt(c.slice(1), 16) : c.charCodeAt(0)))
const hexOf = (v: string) => utf8(v).map((b) => b.toString(16).padStart(2, '0')).join('')
const isPrintable = (v: string) => utf8(v).every((b) => b >= 0x20 && b < 0x7f)
const wOutput = (v: string) => (isPrintable(v) ? v : hexOf(v)) + '\n'
function gLine(v: string) {
  if (v === '') return 'password: \n'
  if (isPrintable(v) && !/["\\]/.test(v)) return `password: "${v}"\n`
  const escaped = utf8(v).map((b) => (b >= 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0'))).join('')
  return `password: 0x${hexOf(v).toUpperCase()}  "${escaped}"\n`
}

test('the fake prints exactly what the real security printed for the same values', async () => {
  expect(wOutput('plainvalue123')).toBe('plainvalue123\n')
  expect(gLine('plainvalue123')).toBe('password: "plainvalue123"\n')
  expect(wOutput('line1\nline2')).toBe('6c696e65310a6c696e6532\n')
  expect(gLine('line1\nline2')).toBe('password: 0x6C696E65310A6C696E6532  "line1\\012line2"\n')
  expect(wOutput('abc\n')).toBe('6162630a\n')
  expect(gLine('a\tb')).toBe('password: 0x610962  "a\\011b"\n')
  expect(wOutput('caf\u00e9-\u00fc')).toBe('636166c3a92dc3bc\n')
  expect(gLine('caf\u00e9-\u00fc')).toBe('password: 0x636166C3A92DC3BC  "caf\\303\\251-\\303\\274"\n')
  expect(wOutput('he said "hi" \\ back')).toBe('he said "hi" \\ back\n')
  expect(gLine('he said "hi" \\ back')).toBe('password: 0x686520736169642022686922205C206261636B  "he said "hi" \\134 back"\n')
  expect(wOutput('')).toBe('\n')
  expect(gLine('')).toBe('password: \n')
})

// An item, keyed by everything a read can match on: its kind, the match
// options by flag letter (s service or server, a account, l label, r protocol,
// P port, ...) and the keychain file it lives in.
type Item = { kind?: 'generic' | 'internet'; keychain?: string; value: string } & Record<string, string | undefined>

// Answers one `security find-*-password` argv the way the real one does:
// getopt over the options, then the keychain files (none means the search
// list, here the login keychain); the first item matching every option.
function security(items: Item[], argv: string[]) {
  const kind = argv[1] === 'find-internet-password' ? 'internet' : 'generic'
  const criteria: [string, string][] = []
  let g = false
  let w = false
  let k = 2
  for (; k < argv.length && argv[k]!.startsWith('-'); k++) {
    if (argv[k] === '-g') g = true
    else if (argv[k] === '-w') w = true
    else criteria.push([argv[k]!.slice(1), argv[++k]!])
  }
  const keychains = argv.slice(k)
  const item = items.find(
    (it) =>
      (it.kind ?? 'generic') === kind &&
      criteria.every(([f, v]) => it[f] === v) &&
      (keychains.length ? keychains : [LOGIN]).includes(it.keychain ?? LOGIN),
  )
  if (!item) return { exitCode: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n' }
  if (w) return { exitCode: 0, stdout: wOutput(item.value), stderr: '' }
  const attributes = `keychain: "${item.keychain ?? LOGIN}"\nclass: "${kind === 'generic' ? 'genp' : 'inet'}"\nattributes:\n    "acct"<blob>="${item.a ?? ''}"\n`
  return { exitCode: 0, stdout: attributes, stderr: g ? gLine(item.value) : '' }
}

type Answer = { deny?: string; result?: unknown }
const call = async ($: any, input: Record<string, unknown>) => (await $.tool.call(input as never)) as Answer

type Opts = {
  items?: Item[]
  platform?: 'Darwin' | 'Linux'
  fail?: { exitCode: number; stdout: string; stderr: string } // every security call answers this instead
  deny?: string // every security call is refused (it could not start, or timed out)
  truncated?: boolean // security's answer was cut off
  argvs?: string[][]
  log?: string[]
  seen?: Record<string, unknown>[]
  output?: string
  writes?: { path: string; text: string }[]
  opened?: string[]
  clock?: { sleep: (ms: number) => Promise<void> }
}

// Stand in for the Mac beneath the mod: uname, `security` over `items`,
// a tool that "prints" `output`, `sleep` on the test's clock.
function mac(on: any, opts: Opts = {}) {
  on('process.run', async (_$: unknown, e: { argv: string[] }) => {
    opts.argvs?.push([...e.argv])
    opts.log?.push(`process.run ${e.argv.slice(0, 2).join(' ')}`)
    const answer = (r: { exitCode: number; stdout: string; stderr: string }) => ({
      value: { isStdoutTruncated: false, isStderrTruncated: Boolean(opts.truncated), ...r },
    })
    if (e.argv[0] === 'uname') return answer({ exitCode: 0, stdout: `${opts.platform ?? 'Darwin'}\n`, stderr: '' })
    if (e.argv[0] === 'sleep') await opts.clock?.sleep(300)
    if (e.argv[0] !== SECURITY) return answer({ exitCode: 0, stdout: '', stderr: '' })
    if (opts.deny) return { deny: opts.deny }
    if (opts.fail) return answer(opts.fail)
    if (e.argv[1] === 'add-generic-password') return answer({ exitCode: 0, stdout: '', stderr: '' })
    return answer(security(opts.items ?? [], e.argv))
  })
  on('tool.call', (_$: unknown, e: Record<string, unknown>) => {
    opts.seen?.push({ ...e })
    opts.log?.push(`tool ${String(e.tool)}`)
    return { result: opts.output ?? 'ran' }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    opts.writes?.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.open', (_$: unknown, e: { id: string }) => {
    opts.opened?.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  mock.env(on, { USER: 'tester', HOME })
}

const securityCalls = (argvs: string[][]) => argvs.filter((a) => a[0] === SECURITY)

// use_secret's tag for `service`, then what a Write of that tag hands the tool
async function restored($: any, seen: Record<string, unknown>[], input: Record<string, unknown>) {
  const tag = String((await call($, { tool: USE, ...input })).result).match(TAG)![0]
  await call($, { tool: 'Write', file_path: '/repo/k.txt', content: tag })
  return seen.at(-1)!.content
}

// ------------------------------------------------------------------ use_secret

test('use_secret answers with a placeholder, never the value', async ($, on) => {
  const VALUE = hex(1)
  const argvs: string[][] = []
  mac(on, { items: [{ s: 'OPENAI_API_KEY', a: 'tester', value: VALUE }], argvs })
  const r = await call($, { tool: USE, service: 'OPENAI_API_KEY' })
  expect(JSON.stringify(r)).not.toContain(VALUE)
  expect(String(r.result)).toMatch(TAG)
  // No account given: -a is left out, so an item matches by its service alone
  expect(securityCalls(argvs)).toEqual([[SECURITY, 'find-generic-password', '-s', 'OPENAI_API_KEY', '-g']])
})

test('use_secret with an account loads that item, not the first one with the service', async ($, on) => {
  const argvs: string[][] = []
  const seen: Record<string, unknown>[] = []
  mac(on, { items: [{ s: 'shared', a: 'first', value: hex(2) }, { s: 'shared', a: 'second', value: hex(3) }], argvs, seen })
  expect(await restored($, seen, { service: 'shared', account: 'second' })).toBe(hex(3))
  expect(securityCalls(argvs)[0]).toEqual([SECURITY, 'find-generic-password', '-s', 'shared', '-a', 'second', '-g'])
})

test('the placeholder from use_secret becomes the value in Bash, and comes back hidden', async ($, on) => {
  const VALUE = hex(4)
  const seen: Record<string, unknown>[] = []
  mac(on, { items: [{ s: 'svc', value: VALUE }], seen, output: VALUE })
  const tag = String((await call($, { tool: USE, service: 'svc' })).result).match(TAG)![0]
  const r = await call($, { tool: 'Bash', command: `printf '%s' ${tag} | tee out.txt` })
  // The command that ran got the real value: the tag is live and the vault is the redactor's
  expect(String(seen.at(-1)!.command)).toBe(`printf '%s' ${VALUE} | tee out.txt`)
  expect(String(r.result)).toBe(tag)
})

// Each shape security really prints, decoded back to the exact value
const VALUES: [string, string][] = [
  ['plain', 'plain-' + hex(5)],
  ['a newline inside', 'line1-' + hex(6) + '\nline2'],
  ['a trailing newline', hex(7) + '\n'],
  ['a tab', 'a\t' + hex(8)],
  ['UTF-8', 'caf\u00e9-\u00fc-' + hex(9)],
  ['a quote and a backslash', 'he said "hi" \\ ' + hex(10)],
]
for (const [name, VALUE] of VALUES) {
  test(`use_secret restores a value with ${name} exactly`, async ($, on) => {
    const seen: Record<string, unknown>[] = []
    mac(on, { items: [{ s: 'svc', value: VALUE }], seen })
    expect(await restored($, seen, { service: 'svc' })).toBe(VALUE)
  })
}

test('a multi-line value from use_secret is refused by Bash, as the README says', async ($, on) => {
  mac(on, { items: [{ s: 'pem', value: 'line1-' + hex(11) + '\nline2' }] })
  const tag = String((await call($, { tool: USE, service: 'pem' })).result).match(TAG)![0]
  expect(String((await call($, { tool: 'Bash', command: `printf '%s' ${tag}` })).deny)).toContain('shell characters')
})

test('after use_secret, the hex security prints for the value comes back hidden too', async ($, on) => {
  const VALUE = 'line1-' + hex(12) + '\nline2'
  mac(on, { items: [{ s: 'pem', value: VALUE }], output: wOutput(VALUE) + gLine(VALUE) })
  await call($, { tool: USE, service: 'pem' })
  const out = String((await call($, { tool: 'Bash', command: 'cat dump.txt' })).result)
  expect(out).not.toContain(hexOf(VALUE))
  expect(out).not.toContain(hexOf(VALUE).toUpperCase())
  expect(out).not.toContain(hex(12))
})

test('a missing item answers with the command to add it, and nothing security printed', async ($, on) => {
  mac(on)
  const plain = String((await call($, { tool: USE, service: 'NEW_KEY' })).result)
  expect(plain).toContain('security add-generic-password -U -s NEW_KEY -a tester -w')
  expect(plain).not.toContain('SecKeychainSearchCopyNext')
  expect(plain).not.toMatch(TAG)
  const named = String((await call($, { tool: USE, service: "Bob's key", account: 'work' })).result)
  expect(named).toContain(`security add-generic-password -U -s 'Bob'\\''s key' -a work -w`)
})

test('an empty item asks for a value', async ($, on) => {
  mac(on, { items: [{ s: 'svc', value: '' }] })
  const r = String((await call($, { tool: USE, service: 'svc' })).result)
  expect(r).toContain('holds no value')
  expect(r).toContain('security add-generic-password -U -s svc -a tester -w')
  expect(r).not.toMatch(TAG)
})

test('a read security refuses asks to unlock or allow, and never shows what it printed', async ($, on) => {
  mac(on, { fail: { exitCode: 51, stdout: 'LEAKED-STDOUT', stderr: 'LEAKED-STDERR' } })
  const r = JSON.stringify(await call($, { tool: USE, service: 'svc' }))
  expect(r).toContain('exited 51')
  expect(r).toContain('security unlock-keychain')
  expect(r).not.toContain('add-generic-password')
  expect(r).not.toContain('LEAKED')
})

test('a cut-off answer from security is a failure, not a value', async ($, on) => {
  mac(on, { items: [{ s: 'svc', value: hex(13) }], truncated: true })
  const r = JSON.stringify(await call($, { tool: USE, service: 'svc' }))
  expect(r).toContain('cut off')
  expect(r).not.toMatch(TAG)
  expect(r).not.toContain(hex(13))
})

test('use_secret refuses a missing, multi-line or overlong name before running security', async ($, on) => {
  const argvs: string[][] = []
  mac(on, { items: [{ s: 'svc', value: hex(14) }], argvs })
  for (const input of [{}, { service: '' }, { service: 'a\nb' }, { service: 'svc', account: 'x\u0007' }, { service: 'x'.repeat(257) }]) {
    expect(String((await call($, { tool: USE, ...input })).result)).toContain('Nothing was loaded')
  }
  expect(securityCalls(argvs)).toEqual([])
})

test('use_secret says so when security cannot run at all', async ($, on) => {
  mac(on, { deny: "Command '/usr/bin/security' not found" })
  expect(await call($, { tool: USE, service: 'svc' })).toEqual({
    result: 'secret-box could not read the Keychain: /usr/bin/security is missing: the Keychain backend needs macOS. Nothing was loaded.',
  })
})

// ------------------------------------------------------- direct reads in Bash

const ENV = { USER: 'tester', HOME }
const g = (criteria: string[][], keychains: string[] = []) => ({ kind: 'generic', criteria, keychains })
const U = 'unknown'
const READS: [string, string, unknown[]][] = [
  ['bare -s', 'security find-generic-password -s OPENAI_API_KEY -w', [g([['-s', 'OPENAI_API_KEY']])]],
  ['double-quoted -s', 'security find-generic-password -s "my key" -w', [g([['-s', 'my key']])]],
  ['single-quoted -s keeps its $', "security find-generic-password -w -s 'my $key'", [g([['-s', 'my $key']])]],
  ['-a before -s, with -g', 'security find-generic-password -a david -s svc -g', [g([['-a', 'david'], ['-s', 'svc']])]],
  ['-a "$USER"', 'security find-generic-password -s svc -a "$USER" -w', [g([['-s', 'svc'], ['-a', 'tester']])]],
  ['-a ${USER}', 'security find-generic-password -s svc -a ${USER} -w', [g([['-s', 'svc'], ['-a', 'tester']])]],
  ['a label', 'security find-generic-password -s svc -l "Work token" -w', [g([['-s', 'svc'], ['-l', 'Work token']])]],
  ['every generic match option', 'security find-generic-password -a A -c aapl -C note -D kind -G gen -j "a note" -l L -s S -w', [g([['-a', 'A'], ['-c', 'aapl'], ['-C', 'note'], ['-D', 'kind'], ['-G', 'gen'], ['-j', 'a note'], ['-l', 'L'], ['-s', 'S']])]],
  ['bundled -wa NAME', 'security find-generic-password -s svc -wa acct', [g([['-s', 'svc'], ['-a', 'acct']])]],
  ['attached -sNAME', 'security find-generic-password -ssvc -w', [g([['-s', 'svc']])]],
  ['a keychain file after the options', 'security find-generic-password -s svc -w ~/Library/Keychains/other.keychain-db', [g([['-s', 'svc']], [OTHER])]],
  ['-- before a keychain file', 'security find-generic-password -s svc -- /tmp/k.keychain-db', [g([['-s', 'svc']], ['/tmp/k.keychain-db'])]],
  ['the same flag twice is passed on twice', 'security find-generic-password -s A -s B -w', [g([['-s', 'A'], ['-s', 'B']])]],
  ['a trailing comment', 'security find-generic-password -s REAL -w # was -s OTHER', [g([['-s', 'REAL']])]],
  ['a # inside a word is text', 'security find-generic-password -s a#b -w', [g([['-s', 'a#b']])]],
  ['redirections', 'security find-generic-password -s svc -w 2>/dev/null >&2 &>log | pbcopy', [g([['-s', 'svc']])]],
  ['2>&1', 'security find-generic-password -s svc -g 2>&1', [g([['-s', 'svc']])]],
  ['a line continuation', 'security find-generic-password \\\n  -s svc -w', [g([['-s', 'svc']])]],
  ['tabs', 'security find-generic-password\t-s\tsvc\t-w', [g([['-s', 'svc']])]],
  ['a ; inside quotes', 'security find-generic-password -s "a;b" -w', [g([['-s', 'a;b']])]],
  ['one word across quotes', `security find-generic-password -s "my"' 'key -w`, [g([['-s', 'my key']])]],
  ['an escaped space', 'security find-generic-password -s my\\ key -w', [g([['-s', 'my key']])]],
  ['the full path, a global option', '/usr/bin/security -q find-generic-password -s svc -w', [g([['-s', 'svc']])]],
  ['inside $( ) in double quotes', 'curl -H "Authorization: Bearer $(security find-generic-password -s svc -w)" https://api.example.com', [g([['-s', 'svc']])]],
  ['inside backticks', 'K=`security find-generic-password -s svc -w`', [g([['-s', 'svc']])]],
  ['two reads', 'security find-generic-password -s one -w; security find-generic-password -s two -w', [g([['-s', 'one']]), g([['-s', 'two']])]],
  ['the same read twice is one', 'security find-generic-password -s svc -w && security find-generic-password -s svc -w', [g([['-s', 'svc']])]],
  ['internet, protocol and port', 'security find-internet-password -s github.com -r htps -P 443 -w', [{ kind: 'internet', criteria: [['-s', 'github.com'], ['-r', 'htps'], ['-P', '443']], keychains: [] }]],
  ['no match option at all', 'security find-generic-password -w', [g([])]],
  // Reads it can't pin down to one item
  ['a variable it does not hold', 'security find-generic-password -s "$SVC" -w', [U]],
  ['a bare variable', 'security find-generic-password -s $SVC -w', [U]],
  ['$USER the command sets', 'USER=bob; security find-generic-password -s svc -a "$USER" -w', [U]],
  ['a word before -s, where getopt stops', 'security find-generic-password login.keychain -s svc -w', [U]],
  ['a relative keychain file', 'security find-generic-password -s svc -w other.keychain-db', [U]],
  ['an option the subcommand does not take', 'security find-generic-password -s svc -P 443 -w', [U]],
  ['-h', 'security find-generic-password -h', [U]],
  ['-s with nothing after it', 'security find-generic-password -s', [U]],
  ['an env prefix', 'FOO=1 security find-generic-password -s svc -w', [U]],
  ['sudo', 'sudo security find-generic-password -s svc -w', [U]],
  ['inside sh -c', "sh -c 'security find-generic-password -s svc -w'", [U]],
  ['inside an echo', 'echo "security find-generic-password -s svc -w"', [U]],
  ['zsh =cmd', 'security find-generic-password -s =ls -w', [U]],
  ['~name', 'security find-generic-password -s ~svc -w', [U]],
  ['a brace', 'security find-generic-password -s {a,b} -w', [U]],
  ['a glob', 'security find-generic-password -s svc* -w', [U]],
  ["$'...'", "security find-generic-password -s $'svc' -w", [U]],
  ['an unterminated quote', 'security find-generic-password -s "svc -w', [U]],
  ['not a read', 'security add-generic-password -s svc -a me -w', []],
]
for (const [name, command, reads] of READS) {
  test(`keychainReads: ${name}`, async () => {
    expect(keychainReads(command, ENV).map((r: any) => (r.unknown ? U : r))).toEqual(reads)
  })
}

test('a direct Keychain read in Bash is loaded before it runs, and its output comes back hidden', async ($, on) => {
  const VALUE = hex(15)
  const argvs: string[][] = []
  const log: string[] = []
  mac(on, { items: [{ s: 'secret-box-test', value: VALUE }], argvs, log, output: wOutput(VALUE) })
  const r = await call($, { tool: 'Bash', command: 'security find-generic-password -s secret-box-test -w' })
  expect(String(r.result)).not.toContain(VALUE)
  expect(String(r.result)).toMatch(TAG)
  expect(securityCalls(argvs)).toEqual([[SECURITY, 'find-generic-password', '-s', 'secret-box-test', '-g']])
  // uname, then the item, then the command
  expect(log).toEqual(['process.run uname -s', `process.run ${SECURITY} find-generic-password`, 'tool Bash'])
})

// Two items share a service; the command reads the SECOND one. Each of these
// fetched the first one before the pre-load passed on every match option.
const SHARED: [string, Item[], string, string[]][] = [
  ['-a "$USER"', [{ s: 'shared', a: 'first', value: hex(16) }, { s: 'shared', a: 'tester', value: hex(17) }],
    'security find-generic-password -s shared -a "$USER" -w', ['-s', 'shared', '-a', 'tester']],
  ['a label', [{ s: 'shared', l: 'Work token', value: hex(16) }, { s: 'shared', l: 'Home token', value: hex(17) }],
    'security find-generic-password -s shared -l "Home token" -w', ['-s', 'shared', '-l', 'Home token']],
  ['bundled -wa', [{ s: 'shared', a: 'first', value: hex(16) }, { s: 'shared', a: 'second', value: hex(17) }],
    'security find-generic-password -s shared -wa second', ['-s', 'shared', '-a', 'second']],
  ['a keychain file', [{ s: 'shared', value: hex(16) }, { s: 'shared', keychain: OTHER, value: hex(17) }],
    'security find-generic-password -s shared -w ~/Library/Keychains/other.keychain-db', ['-s', 'shared', OTHER]],
  ['a comment naming the other account', [{ s: 'shared', a: 'first', value: hex(16) }, { s: 'shared', a: 'second', value: hex(17) }],
    'security find-generic-password -s shared -a second -w # -a first', ['-s', 'shared', '-a', 'second']],
  ['an internet port', [{ kind: 'internet', s: 'github.com', r: 'htps', P: '443', value: hex(16) }, { kind: 'internet', s: 'github.com', r: 'htps', P: '8443', value: hex(17) }],
    'security find-internet-password -s github.com -r htps -P 8443 -w', ['-s', 'github.com', '-r', 'htps', '-P', '8443']],
]
for (const [name, items, command, args] of SHARED) {
  test(`two items share a service: a direct read by ${name} hides the second`, async ($, on) => {
    const argvs: string[][] = []
    const second = items[1]!
    mac(on, { items, argvs, output: wOutput(second.value) })
    const r = String((await call($, { tool: 'Bash', command })).result)
    expect(r).not.toContain(second.value)
    expect(r).toMatch(TAG)
    const fetched = securityCalls(argvs)[0]!
    expect(fetched.filter((a) => a !== '-g').slice(2)).toEqual(args)
  })
}

// Whatever form security prints the value in (text, -w hex, -g hex and its
// escaped copy), none of it comes back, not even the hex run inside the value
for (const [name, VALUE] of VALUES.slice(1)) {
  for (const flag of ['-w', '-g']) {
    test(`a direct ${flag} read of a value with ${name} comes back hidden`, async ($, on) => {
      mac(on, { items: [{ s: 'svc', value: VALUE }], output: flag === '-w' ? wOutput(VALUE) : gLine(VALUE) })
      const r = String((await call($, { tool: 'Bash', command: `security find-generic-password -s svc ${flag}` })).result)
      for (const shown of [VALUE, hexOf(VALUE), hexOf(VALUE).toUpperCase(), VALUE.match(/[0-9a-f]{48}/)![0]]) expect(r).not.toContain(shown)
      expect(r).toMatch(TAG)
    })
  }
}

test('bare hex is left alone by the detector, so the pre-load is what hides a direct read', async ($, on) => {
  const VALUE = hex(19)
  mac(on, { output: VALUE + '\n' })
  expect(String((await call($, { tool: 'Bash', command: 'cat digest.txt' })).result)).toContain(VALUE)
})

test('the policy for reads it cannot pin down lets them run (REFUSE_UNMASKABLE is false)', async () => {
  expect(unmaskable('a word in it is only known when it runs')).toBeUndefined()
})

test('a read it cannot pin down runs as written, without a fetch', async ($, on) => {
  const argvs: string[][] = []
  mac(on, { argvs })
  expect(await call($, { tool: 'Bash', command: 'security find-generic-password -s "$SVC" -w' })).toEqual({ result: 'ran' })
  expect(securityCalls(argvs)).toEqual([])
})

test('a pre-load that fails still lets the command run', async ($, on) => {
  mac(on, { deny: 'timed out' })
  expect(await call($, { tool: 'Bash', command: 'security find-generic-password -s svc -w' })).toEqual({ result: 'ran' })
})

test('a locked keychain still lets the command run', async ($, on) => {
  mac(on, { fail: { exitCode: 36, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' } })
  expect(await call($, { tool: 'Bash', command: 'security find-generic-password -s svc -w' })).toEqual({ result: 'ran' })
})

// ------------------------------------------------------------------ platforms

const UPSTREAM_DESCRIPTION =
  'Ask the user for a secret (API key, token, password) without it ever entering the conversation. ' +
  'The user pastes it into a masked box and the mod saves it to the project .env. You get back the ' +
  'variable name and a placeholder like [REDACTED-SECRET-1a2b3c4d]. Write that placeholder in a command ' +
  'or file and it becomes the real value when the tool runs. Use this INSTEAD of asking the user to ' +
  'paste a secret into chat.'

async function registered($: any, on: any, opts: Opts) {
  const specs: Record<string, any>[] = []
  mac(on, opts)
  on('tool.register', (_$: unknown, e: Record<string, any>) => {
    specs.push(e)
    return { value: { tool: `mcp__secret-box__${e.name}` } }
  })
  on('session.start', () => ({ cwd: '/repo' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return specs
}

test('off macOS only request_secret is registered, exactly as upstream', async ($, on) => {
  const specs = await registered($, on, { platform: 'Linux' })
  expect(specs.map((s) => s.name)).toEqual(['request_secret'])
  expect(specs[0]!.description).toBe(UPSTREAM_DESCRIPTION)
  expect(specs[0]!.inputSchema.properties.name.description).toBe('Environment variable name, e.g. STRIPE_SECRET_KEY')
})

test('on macOS use_secret is registered too, in the prompt', async ($, on) => {
  const specs = await registered($, on, {})
  expect(specs.map((s) => [s.name, s.isDeferred])).toEqual([['request_secret', false], ['use_secret', false]])
  expect(specs[0]!.description).toContain('macOS Keychain')
})

test('on macOS with backend dotenv, use_secret is still registered and the box is upstream', { options: { backend: 'dotenv' } }, async ($, on) => {
  const specs = await registered($, on, {})
  expect(specs.map((s) => s.name)).toEqual(['request_secret', 'use_secret'])
  expect(specs[0]!.description).toBe(UPSTREAM_DESCRIPTION)
})

test('off macOS the pre-load does nothing and use_secret says it needs macOS', async ($, on) => {
  const argvs: string[][] = []
  mac(on, { platform: 'Linux', argvs, items: [{ s: 'svc', value: hex(20) }] })
  expect(await call($, { tool: 'Bash', command: 'security find-generic-password -s svc -w' })).toEqual({ result: 'ran' })
  expect(String((await call($, { tool: USE, service: 'svc' })).result)).toContain('needs macOS')
  expect(securityCalls(argvs)).toEqual([])
})

test('boxBackend: auto and unknown values follow the platform; a named backend is kept', async () => {
  expect([boxBackend('auto', true), boxBackend('auto', false)]).toEqual(['keychain', 'dotenv'])
  expect([boxBackend(undefined, true), boxBackend('Keychain ', true), boxBackend('weird', false)]).toEqual(['keychain', 'keychain', 'dotenv'])
  expect([boxBackend('keychain', false), boxBackend('dotenv', true)]).toEqual(['keychain', 'dotenv'])
})

// ------------------------------------------------------------------- the box

// Claude calls request_secret, the box opens, the person types `value` and
// presses Enter. Resolves with what Claude is answered.
async function fillBox($: any, on: any, value: string, opts: Opts) {
  const clock = mock.clock(on)
  mac(on, { ...opts, clock })
  const answer = call($, { tool: BOX, name: 'STRIPE_SECRET_KEY', reason: 'billing.js needs it' })
  await clock.settle()
  const pane = await $.ui.mount({
    plugin: 'secret-box',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'secret-box',
    props: { title: 'secret-box', isFocused: true, bodyColumns: 80, placement: 'dock' },
  })
  await pane.input({ key: 'secret', text: value, kind: 'change' })
  await pane.input({ key: 'secret', text: '•'.repeat(value.length) })
  await clock.advance(300)
  return answer
}

test('on macOS the box saves to the Keychain by default, and leaves .env alone', async ($, on) => {
  const VALUE = hex(21)
  const argvs: string[][] = []
  const writes: { path: string; text: string }[] = []
  const r = await fillBox($, on, VALUE, { argvs, writes })
  expect(securityCalls(argvs)).toEqual([[SECURITY, 'add-generic-password', '-U', '-s', 'STRIPE_SECRET_KEY', '-a', 'tester', '-w', VALUE]])
  expect(writes).toEqual([])
  expect(JSON.stringify(r)).not.toContain(VALUE)
  expect(String(r.result)).toMatch(TAG)
  expect(String(r.result)).toContain('call use_secret with service STRIPE_SECRET_KEY and account tester')
})

test('the box saves under the keychainAccount setting', { options: { keychainAccount: 'work' } }, async ($, on) => {
  const argvs: string[][] = []
  await fillBox($, on, hex(22), { argvs })
  expect(securityCalls(argvs)[0]!.slice(0, 7)).toEqual([SECURITY, 'add-generic-password', '-U', '-s', 'STRIPE_SECRET_KEY', '-a', 'work'])
})

test('a Keychain save that fails says so, and hands out no placeholder', async ($, on) => {
  const r = await fillBox($, on, hex(23), { fail: { exitCode: 45, stdout: '', stderr: 'LEAKED-STDERR' } })
  expect(r).toEqual({ result: 'Saving STRIPE_SECRET_KEY failed: security exited 45' })
})

// Upstream's box: .env and .gitignore written, upstream's answer word for word
async function expectUpstreamBox($: any, on: any, opts: Opts) {
  const VALUE = hex(24)
  const argvs: string[][] = []
  const writes: { path: string; text: string }[] = []
  const r = await fillBox($, on, VALUE, { ...opts, argvs, writes })
  expect(securityCalls(argvs)).toEqual([])
  expect(writes).toEqual([
    { path: '/repo/.env', text: `STRIPE_SECRET_KEY=${VALUE}\n` },
    { path: '/repo/.gitignore', text: '.env\n' },
  ])
  const tag = String(r.result).match(TAG)![0]
  expect(r.result).toBe(
    `The user entered STRIPE_SECRET_KEY. It was saved to .env (and added .env to .gitignore). You can't see the value. To use it in a command or a file, write ${tag}: it becomes the real value when the tool runs and is hidden again in the output. Code should read it from the environment.`,
  )
}

test('backend dotenv on macOS is the upstream box', { options: { backend: 'dotenv' } }, async ($, on) => {
  await expectUpstreamBox($, on, {})
})

test('off macOS the box defaults to dotenv: the upstream box', async ($, on) => {
  await expectUpstreamBox($, on, { platform: 'Linux' })
})

test('backend keychain off macOS is refused before the box opens', { options: { backend: 'keychain' } }, async ($, on) => {
  const opened: string[] = []
  mac(on, { platform: 'Linux', opened })
  const r = String((await call($, { tool: BOX, name: 'STRIPE_SECRET_KEY', reason: 'x' })).result)
  expect(r).toContain('needs macOS')
  expect(opened).toEqual([])
})
