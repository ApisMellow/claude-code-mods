import { expect, test } from 'claude-code/testing'

// Fake keys, built at run time so no key-shaped string sits in the repo
const STRIPE = 'sk_' + 'live_' + 'A1b2C3d4E5f6G7h8J9k0L1m2'
const WEAK = 'hunter' + '2hunter2' // a short password the detector alone would miss

type Answer = { deny?: string; result?: unknown }
const call = async ($: any, input: Record<string, unknown>) => (await $.tool.call(input as never)) as Answer

// Stand in for Claude Code beneath the mod: the tool "prints" `output`,
// git reports `staged`, and .env holds `dotenv`.
function stubs(on: any, opts: { output?: string; staged?: string; dotenv?: string; seen?: string[] } = {}) {
  on('tool.call', (_$: unknown, e: Record<string, unknown>) => {
    opts.seen?.push(String(e.command ?? ''))
    return { result: opts.output ?? 'ran' }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: opts.staged ?? '', stderr: '' } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: opts.dotenv !== undefined }))
  on('fs.read', () => ({ value: opts.dotenv ?? '' }))
}

// What is blocked, and what now runs (with its output hidden instead)
const GUARD: [string, string, boolean][] = [
  ['cat .env runs', 'cat .env', false],
  ['source .env runs', 'source .env && node app.js', false],
  ['git add -f .env', 'git add -f .env', true],
  ['git add .env.local', 'git add .env.local', true],
  ['git add .env.example', 'git add .env.example', false],
  ['git status', 'git status', false],
]
for (const [name, command, isBlocked] of GUARD) {
  test(name, async ($, on) => {
    stubs(on)
    expect(Boolean((await call($, { tool: 'Bash', command })).deny)).toBe(isBlocked)
  })
}

for (const [staged, isBlocked] of [['src/app.ts\n.env\n', true], ['src/app.ts\n', false]] as const) {
  test(`git commit with staged ${JSON.stringify(staged)}`, async ($, on) => {
    stubs(on, { staged })
    expect(Boolean((await call($, { tool: 'Bash', command: 'git commit -m "wip"' })).deny)).toBe(isBlocked)
  })
}

for (const options of [{}, { pii: false }, { pii: true }, { pii: true, hideEmails: false }]) {
  test(`email visibility follows pii ${JSON.stringify(options)} while secrets stay hidden`, { options }, async ($, on) => {
    const address = 'dana.whitfield@northwind-labs.io'
    const publicIp = '8.8.8.8'
    stubs(on, { output: `contact ${address}, origin ${publicIp}, token ${STRIPE}` })
    const result = String((await call($, { tool: 'Bash', command: 'cat output.txt' })).result)
    if (options.pii) {
      expect(result).not.toContain(publicIp)
      expect(result).toMatch(/\[REDACTED-IP-[0-9a-f]{8}\]/)
    } else {
      expect(result).toContain(publicIp)
    }
    expect(result).not.toContain(STRIPE)
    expect(result).toMatch(/\[REDACTED-SECRET-[0-9a-f]{8}\]/)
    if (options.pii && options.hideEmails !== false) {
      expect(result).not.toContain(address)
      expect(result).toMatch(/\[REDACTED-EMAIL-[0-9a-f]{8}\]/)
    } else {
      expect(result).toContain(address)
    }
  })
}

test('a key in any tool output comes back as a placeholder', async ($, on) => {
  stubs(on, { output: `charged with ${STRIPE}` })
  const r = await call($, { tool: 'Bash', command: 'node pay.js' })
  expect(String(r.result)).not.toContain(STRIPE)
  expect(String(r.result)).toMatch(/\[REDACTED-SECRET-[0-9a-f]{8}\]/)
})

test('reading .env hides secret-named values and keeps the rest', async ($, on) => {
  const dotenv = `PORT=3000\nNODE_ENV=production\nDB_PASSWORD=${WEAK}\n`
  stubs(on, { output: dotenv, dotenv })
  const out = String((await call($, { tool: 'Read', file_path: '/repo/.env' })).result)
  expect(out).toContain('PORT=3000')
  expect(out).toContain('NODE_ENV=production')
  expect(out).not.toContain(WEAK)
})

test('a known .env value is hidden anywhere, even when it does not look like a key', async ($, on) => {
  stubs(on, { output: `connected as admin / ${WEAK}`, dotenv: `DB_PASSWORD=${WEAK}\n` })
  await call($, { tool: 'Read', file_path: '/repo/.env' })
  const out = String((await call($, { tool: 'Bash', command: 'node db.js' })).result)
  expect(out).not.toContain(WEAK)
})

test('a placeholder in a command becomes the real value when it runs', async ($, on) => {
  const seen: string[] = []
  stubs(on, { output: `key is ${STRIPE}`, seen })
  const tag = String((await call($, { tool: 'Bash', command: 'cat key.txt' })).result).match(/\[REDACTED-SECRET-[0-9a-f]{8}\]/)![0]
  await call($, { tool: 'Bash', command: `curl -u ${tag}: https://api.stripe.com/v1/balance` })
  expect(seen.at(-1)).toContain(STRIPE)
  expect(seen.at(-1)).not.toContain(tag)
})

test('a key is still hidden when .env cannot be read', async ($, on) => {
  on('tool.call', () => ({ result: `key is ${STRIPE}` }))
  const out = String((await call($, { tool: 'Read', file_path: '/repo/.env' })).result)
  expect(out).not.toContain(STRIPE)
})

test('a weak value in another .env file is hidden when that file is read', async ($, on) => {
  const plain = 'correct' + 'horsebattery' // letters only: no detector rule fires on it
  stubs(on, { output: `PORT=3000\nADMIN_PASS=${plain}\n`, dotenv: `PORT=3000\nADMIN_PASS=${plain}\n` })
  const out = String((await call($, { tool: 'Bash', command: 'cat config/.env.production' })).result)
  expect(out).not.toContain(plain)
  expect(out).toContain('PORT=3000')
})

test('a .env file that cannot be checked still runs, and is scanned', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => { throw new Error('disk gone') })
  // learnDotenv swallows a read error, so the call still runs and is scanned
  expect((await call($, { tool: 'Read', file_path: '/repo/.env' })).result).toBe('ran')
})
