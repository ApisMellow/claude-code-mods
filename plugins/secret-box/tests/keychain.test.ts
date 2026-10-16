import { expect, mock, test } from 'claude-code/testing'

import { keychainReads, SECURITY } from '../hooks/keychain'

const USE = 'mcp__secret-box__use_secret'
const BOX = 'mcp__secret-box__request_secret'
const TAG = /\[REDACTED-SECRET-[0-9a-f]{8}\]/

// Fake Keychain values, built at run time: 48 hex characters, the shape of
// `openssl rand -hex 24`. Bare hex is a shape the detector leaves alone (it
// could be a hash), so only the vault can hide it.
const hex = (seed: number) => Array.from({ length: 48 }, (_, i) => ((i * 7 + seed * 5) % 16).toString(16)).join('')

type Answer = { deny?: string; result?: unknown }
const call = async ($: any, input: Record<string, unknown>) => (await $.tool.call(input as never)) as Answer

type Opts = {
  items?: Record<string, string> // service -> value, as stored
  fail?: { exitCode: number; stdout: string; stderr: string } // what every security call answers instead
  deny?: string // every security call is refused (it could not start, or timed out)
  argvs?: string[][]
  log?: string[]
  seen?: Record<string, unknown>[]
  output?: string
  writes?: { path: string; text: string }[]
  clock?: { sleep: (ms: number) => Promise<void> }
}

// Stand in for the Mac beneath the mod: `security` answers from `items` the
// way the real one does (the value and a newline, or exit 44), a tool "prints"
// `output`, and `sleep` waits on the test's clock.
function mac(on: any, opts: Opts = {}) {
  on('process.run', async (_$: unknown, e: { argv: string[] }) => {
    opts.argvs?.push([...e.argv])
    opts.log?.push(`process.run ${e.argv.slice(0, 2).join(' ')}`)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'sleep') {
      await opts.clock?.sleep(300)
      return ok()
    }
    if (e.argv[0] !== SECURITY) return ok()
    if (opts.deny) return { deny: opts.deny }
    if (opts.fail) return { value: { ...opts.fail, isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[1] === 'add-generic-password') return ok()
    const value = opts.items?.[e.argv[e.argv.indexOf('-s') + 1]]
    if (value === undefined) {
      return { value: { exitCode: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return ok(value + '\n')
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
  mock.env(on, { USER: 'tester' })
}

const securityCalls = (argvs: string[][]) => argvs.filter((a) => a[0] === SECURITY)

// ------------------------------------------------------------------ use_secret

test('use_secret answers with a placeholder, never the value', async ($, on) => {
  const VALUE = hex(1)
  const argvs: string[][] = []
  mac(on, { items: { OPENAI_API_KEY: VALUE }, argvs })
  const r = await call($, { tool: USE, service: 'OPENAI_API_KEY' })
  expect(JSON.stringify(r)).not.toContain(VALUE)
  expect(String(r.result)).toMatch(TAG)
  expect(String(r.result)).toContain('OPENAI_API_KEY')
  // No account given: -a is left out, so an item matches by its service alone
  expect(securityCalls(argvs)).toEqual([[SECURITY, 'find-generic-password', '-s', 'OPENAI_API_KEY', '-w']])
})

test('use_secret passes the account when one is given', async ($, on) => {
  const argvs: string[][] = []
  mac(on, { items: { svc: hex(2) }, argvs })
  await call($, { tool: USE, service: 'svc', account: 'work' })
  expect(securityCalls(argvs)).toEqual([[SECURITY, 'find-generic-password', '-s', 'svc', '-a', 'work', '-w']])
})

test('the placeholder from use_secret becomes the value in Bash, and comes back hidden', async ($, on) => {
  const VALUE = hex(3)
  const seen: Record<string, unknown>[] = []
  mac(on, { items: { svc: VALUE }, seen, output: VALUE })
  const tag = String((await call($, { tool: USE, service: 'svc' })).result).match(TAG)![0]
  const r = await call($, { tool: 'Bash', command: `printf '%s' ${tag} | tee out.txt` })
  // The command that ran got the real value: the tag is live and the vault is the redactor's
  expect(String(seen.at(-1)!.command)).toBe(`printf '%s' ${VALUE} | tee out.txt`)
  // What the command printed comes back as the same placeholder
  expect(String(r.result)).not.toContain(VALUE)
  expect(String(r.result)).toBe(tag)
})

test('use_secret takes off exactly the one newline security adds', async ($, on) => {
  const PLAIN = hex(4)
  const ENDS_IN_NEWLINE = hex(5) + '\n'
  const seen: Record<string, unknown>[] = []
  mac(on, { items: { plain: PLAIN, newline: ENDS_IN_NEWLINE }, seen })
  for (const [service, value] of [['plain', PLAIN], ['newline', ENDS_IN_NEWLINE]]) {
    const tag = String((await call($, { tool: USE, service })).result).match(TAG)![0]
    await call($, { tool: 'Write', file_path: '/repo/k.txt', content: tag })
    expect(seen.at(-1)!.content).toBe(value)
  }
})

test('a missing item answers with the command to add it, and nothing security printed', async ($, on) => {
  mac(on)
  const plain = String((await call($, { tool: USE, service: 'NEW_KEY' })).result)
  expect(plain).toContain('security add-generic-password -s NEW_KEY -a tester -w')
  expect(plain).toContain('NEW_KEY')
  expect(plain).not.toContain('SecKeychainSearchCopyNext')
  expect(plain).not.toMatch(TAG)
  const named = String((await call($, { tool: USE, service: "Bob's key", account: 'work' })).result)
  expect(named).toContain(`security add-generic-password -s 'Bob'\\''s key' -a work -w`)
})

test('a read security refuses is reported by exit code, never by what it printed', async ($, on) => {
  mac(on, { fail: { exitCode: 51, stdout: 'LEAKED-STDOUT', stderr: 'LEAKED-STDERR' } })
  const r = JSON.stringify(await call($, { tool: USE, service: 'svc' }))
  expect(r).toContain('exited 51')
  expect(r).toContain('security add-generic-password -s svc -a tester -w')
  expect(r).not.toContain('LEAKED-STDOUT')
  expect(r).not.toContain('LEAKED-STDERR')
})

test('use_secret refuses a missing, multi-line or overlong name before running security', async ($, on) => {
  const argvs: string[][] = []
  mac(on, { items: { svc: hex(6) }, argvs })
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

const READS: [string, string, unknown[]][] = [
  ['bare -s', 'security find-generic-password -s OPENAI_API_KEY -w', [{ kind: 'generic', service: 'OPENAI_API_KEY' }]],
  ['double-quoted -s', 'security find-generic-password -s "my key" -w', [{ kind: 'generic', service: 'my key' }]],
  ['single-quoted -s', "security find-generic-password -w -s 'my $key'", [{ kind: 'generic', service: 'my $key' }]],
  ['-a before -s', 'security find-generic-password -a david -s svc -w', [{ kind: 'generic', service: 'svc', account: 'david' }]],
  ['quoted -a, -g', 'security find-generic-password -s svc -a "dev ops" -g', [{ kind: 'generic', service: 'svc', account: 'dev ops' }]],
  ['an -a from a variable is dropped', 'security find-generic-password -s svc -a "$USER" -w', [{ kind: 'generic', service: 'svc' }]],
  ['find-internet-password', 'security find-internet-password -s api.example.com -a me -w', [{ kind: 'internet', service: 'api.example.com', account: 'me' }]],
  ['a flag that takes a value is skipped', 'security find-generic-password -l mylabel -s svc -w', [{ kind: 'generic', service: 'svc' }]],
  ['in a pipeline', 'security find-generic-password -s svc -w | pbcopy', [{ kind: 'generic', service: 'svc' }]],
  ['two reads, one in $( )', 'K=$(security find-generic-password -s one -w); security find-generic-password -s two -w', [{ kind: 'generic', service: 'one' }, { kind: 'generic', service: 'two' }]],
  ['the same read twice is one', 'security find-generic-password -s svc -w && security find-generic-password -s svc -w', [{ kind: 'generic', service: 'svc' }]],
  // Can't be parsed: these run as written, and the detector scans the output
  ['-s from a quoted variable', 'security find-generic-password -s "$SVC" -w', []],
  ['-s from a bare variable', 'security find-generic-password -s $SVC -w', []],
  ['no -s', 'security find-generic-password -a david -w', []],
  ['-s run together with its value', 'security find-generic-password -ssvc -w', []],
  ['-s with nothing after it', 'security find-generic-password -s', []],
  ['-s is the value of -l', 'security find-generic-password -l -s -w', []],
  ['an unterminated quote', 'security find-generic-password -s "svc -w', []],
  ['a quote glued to text', 'security find-generic-password -s "a"b -w', []],
  ['a backslash in double quotes', 'security find-generic-password -s "a\\b" -w', []],
  ['not a read', 'security add-generic-password -s svc -a me -w', []],
]
for (const [name, command, reads] of READS) {
  test(`keychainReads: ${name}`, async () => {
    expect(keychainReads(command)).toEqual(reads)
  })
}

test('a direct Keychain read in Bash is loaded before it runs, and its output comes back hidden', async ($, on) => {
  const VALUE = hex(7)
  const argvs: string[][] = []
  const log: string[] = []
  mac(on, { items: { 'secret-box-test': VALUE }, argvs, log, output: VALUE + '\n' })
  const r = await call($, { tool: 'Bash', command: 'security find-generic-password -s secret-box-test -w' })
  expect(r.deny).toBeUndefined()
  expect(String(r.result)).not.toContain(VALUE)
  expect(String(r.result)).toMatch(TAG)
  expect(securityCalls(argvs)).toEqual([[SECURITY, 'find-generic-password', '-s', 'secret-box-test', '-w']])
  // The item was fetched before the command ran
  expect(log).toEqual([`process.run ${SECURITY} find-generic-password`, 'tool Bash'])
})

test('a -g read prints the value on stderr; it comes back hidden too', async ($, on) => {
  const VALUE = hex(8)
  mac(on, { items: { svc: VALUE }, output: `keychain: "/Users/tester/Library/Keychains/login.keychain-db"\nclass: "genp"\npassword: "${VALUE}"\n` })
  const r = String((await call($, { tool: 'Bash', command: "security find-generic-password -s 'svc' -g" })).result)
  expect(r).not.toContain(VALUE)
  expect(r).toContain('class: "genp"')
})

test('bare hex is left alone by the detector, so the pre-load is what hides a direct read', async ($, on) => {
  const VALUE = hex(9)
  mac(on, { output: VALUE + '\n' })
  expect(String((await call($, { tool: 'Bash', command: 'cat digest.txt' })).result)).toContain(VALUE)
})

test('a read it cannot parse runs as written', async ($, on) => {
  const argvs: string[][] = []
  mac(on, { argvs })
  const r = await call($, { tool: 'Bash', command: 'security find-generic-password -s "$SVC" -w' })
  expect(r).toEqual({ result: 'ran' })
  expect(securityCalls(argvs)).toEqual([])
})

test('a pre-load that fails still lets the command run', async ($, on) => {
  mac(on, { deny: 'timed out' })
  const r = await call($, { tool: 'Bash', command: 'security find-generic-password -s svc -w' })
  expect(r).toEqual({ result: 'ran' })
})

// ------------------------------------------------------------------- the box

// Claude calls request_secret, the box opens, the person types `value` and
// presses Enter. Resolves with what Claude is answered.
async function fillBox($: any, on: any, value: string, opts: Opts) {
  const clock = mock.clock(on)
  mac(on, { ...opts, clock })
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
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

test('the box saves to the Keychain by default, and leaves .env alone', async ($, on) => {
  const VALUE = hex(10)
  const argvs: string[][] = []
  const writes: { path: string; text: string }[] = []
  const r = await fillBox($, on, VALUE, { argvs, writes })
  expect(securityCalls(argvs)).toEqual([[SECURITY, 'add-generic-password', '-U', '-s', 'STRIPE_SECRET_KEY', '-a', 'tester', '-w', VALUE]])
  expect(writes).toEqual([])
  expect(JSON.stringify(r)).not.toContain(VALUE)
  expect(String(r.result)).toMatch(TAG)
  expect(String(r.result)).toContain('macOS Keychain (service STRIPE_SECRET_KEY, account tester)')
})

test('the box saves under the keychainAccount setting', { options: { keychainAccount: 'work' } }, async ($, on) => {
  const argvs: string[][] = []
  await fillBox($, on, hex(11), { argvs })
  expect(securityCalls(argvs)[0]!.slice(0, 7)).toEqual([SECURITY, 'add-generic-password', '-U', '-s', 'STRIPE_SECRET_KEY', '-a', 'work'])
})

test('a Keychain save that fails says so, and hands out no placeholder', async ($, on) => {
  const VALUE = hex(12)
  const r = await fillBox($, on, VALUE, { fail: { exitCode: 45, stdout: '', stderr: 'LEAKED-STDERR' } })
  expect(r).toEqual({ result: 'Saving STRIPE_SECRET_KEY failed: security exited 45' })
})

test('backend dotenv writes .env and .gitignore as before, and never runs security', { options: { backend: 'dotenv' } }, async ($, on) => {
  const VALUE = hex(13)
  const argvs: string[][] = []
  const writes: { path: string; text: string }[] = []
  const r = await fillBox($, on, VALUE, { argvs, writes })
  expect(securityCalls(argvs)).toEqual([])
  expect(writes).toEqual([
    { path: '/repo/.env', text: `STRIPE_SECRET_KEY=${VALUE}\n` },
    { path: '/repo/.gitignore', text: '.env\n' },
  ])
  const tag = String(r.result).match(TAG)![0]
  expect(r.result).toBe(
    `The user entered STRIPE_SECRET_KEY. It was saved to .env (and added .env to .gitignore). You can't see the value. To use it in a command or a file, write ${tag}: it becomes the real value when the tool runs and is hidden again in the output. Code should read it from the environment.`,
  )
})
