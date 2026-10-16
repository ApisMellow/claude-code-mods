// ownApproval: the permission check of a call secret-box filled with real
// values is answered on the call as Claude wrote it (placeholders), by core,
// the user's rules or the person, never by secret-box's own judgment.
import { expect, mock, test } from 'claude-code/testing'

import { SECURITY } from '../hooks/keychain'
import { call, hex, security, TAG, USE, type Item } from './fake-mac'

type Decision = 'allow' | 'ask' | 'deny'
type Verdict = { decision: Decision; reason?: string; rule?: string }

// Stand in for Claude Code beneath the mod. A restore tool's call runs the
// permission check (tool.check, with the call's tool_use_id) on the input as
// it will run, the way core's tool.call does, and runs only on allow.
type World = {
  items?: Item[]
  core?: Decision // core's verdict on the call as it will run
  rules?: Decision | 'throws' // a query's verdict: the user's rules on the call as written
  answer?: string // what the person picks; 'dismiss' closes the dialog
  surfaces?: string[]
  verdicts?: Verdict[] // what each real call's check came to
  ids?: string[] // each real call's tool_use_id
  coreSaw?: unknown[] // the input core's check was given
  queries?: unknown[] // the input each query was given
  asked?: string[] // the questions put to the person
  ran?: unknown[] // the input of each call that ran
}
const RESTORE = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world($: any, on: any, w: World) {
  const items = (w.items ??= [])
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === '/usr/bin/uname' || e.argv[0] === '/bin/uname') return ok('Darwin\n')
    if (e.argv[0] === SECURITY) return { value: { ...security(items, e.argv), isStdoutTruncated: false, isStderrTruncated: false } }
    return ok()
  })
  on('tool.call', async (_$: unknown, e: Record<string, any>) => {
    if (e.tool === 'AskUserQuestion') {
      const questions = e.questions as { question: string }[]
      w.asked?.push(...questions.map((q) => q.question))
      if (w.answer === 'dismiss') return { deny: 'The user dismissed the question.' }
      return { result: { questions, answers: Object.fromEntries(questions.map((q) => [q.question, w.answer ?? 'Deny'])) } }
    }
    if (RESTORE.has(e.tool)) {
      const { tool, tool_use_id, agentId, requestMeta, ...input } = e
      w.ids?.push(tool_use_id)
      const v = (await $.tool.check({ tool, input, tool_use_id })) as Verdict
      w.verdicts?.push(v)
      if (v.decision !== 'allow') return { deny: `not run: ${v.decision}` }
      w.ran?.push(input)
    }
    return { result: 'ran' }
  })
  on('tool.check', (_$: unknown, e: { input: unknown; tool_use_id?: string }) => {
    if (e.tool_use_id !== undefined) {
      w.coreSaw?.push(e.input)
      return { decision: w.core ?? 'ask' }
    }
    w.queries?.push(e.input)
    if (w.rules === 'throws') throw new Error('rules unreadable')
    return { decision: w.rules ?? 'ask', ...(w.rules === 'allow' ? { rule: 'Bash(curl:*)' } : {}) }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  mock.env(on, { USER: 'tester', HOME: '/Users/tester' })
}

// A Keychain item loaded with use_secret: its placeholder
const VALUE = hex(21)
async function loaded($: any, on: any, w: World) {
  w.items = [{ s: 'openai', a: 'tester', value: VALUE }]
  world($, on, w)
  return String((await call($, { tool: USE, service: 'openai' })).result).match(TAG)![0]
}
const curl = (tag: string) => `curl -H "Authorization: Bearer ${tag}" https://api.example.com/v1/models`

test('core allow stands: no query, no prompt, and the call runs with the real value', async ($, on) => {
  const w: World = { core: 'allow', verdicts: [], queries: [], asked: [], ran: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['allow'])
  expect(w.queries).toEqual([])
  expect(w.asked).toEqual([])
  expect(JSON.stringify(w.ran)).toContain(VALUE)
})

test('core deny stands: no query, no prompt', async ($, on) => {
  const w: World = { core: 'deny', rules: 'allow', answer: 'Allow', verdicts: [], queries: [], asked: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['deny'])
  expect(w.queries).toEqual([])
  expect(w.asked).toEqual([])
})

test("on ask, the user's rules on the call as written allow it, and the query never holds the real value", async ($, on) => {
  const w: World = { core: 'ask', rules: 'allow', verdicts: [], coreSaw: [], queries: [], asked: [], ran: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['allow'])
  expect(w.verdicts![0]!.rule).toBe('Bash(curl:*)')
  // Core checked the call as it runs; the rules were asked about it as written
  expect(JSON.stringify(w.coreSaw)).toContain(VALUE)
  expect(w.queries).toEqual([{ command: curl(tag) }])
  expect(JSON.stringify(w.queries)).not.toContain(VALUE)
  expect(w.asked).toEqual([])
  expect(JSON.stringify(w.ran)).toContain(VALUE)
})

test("on ask, the user's rules on the call as written deny it", async ($, on) => {
  const w: World = { core: 'ask', rules: 'deny', answer: 'Allow', verdicts: [], asked: [], ran: [] }
  const tag = await loaded($, on, w)
  const r = await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['deny'])
  expect(w.asked).toEqual([])
  expect(w.ran).toEqual([])
  expect(JSON.stringify(r)).not.toContain(VALUE)
})

test('still ask: the person sees the call as written and the secret names, never the value, and Allow runs it', async ($, on) => {
  const w: World = { core: 'ask', rules: 'ask', answer: 'Allow', verdicts: [], asked: [], ran: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.asked).toHaveLength(1)
  const question = w.asked![0]!
  expect(question).toContain(curl(tag))
  expect(question).toContain(`uses a secret: the Keychain item openai as ${tag}.`)
  expect(question).not.toContain(VALUE)
  expect(question).toEndWith('?')
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['allow'])
  expect(JSON.stringify(w.ran)).toContain(VALUE)
})

test('still ask: Deny refuses the call, and the refusal holds no real value', async ($, on) => {
  const w: World = { core: 'ask', rules: 'ask', answer: 'Deny', verdicts: [], asked: [], ran: [] }
  const tag = await loaded($, on, w)
  const r = await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.asked).toHaveLength(1)
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['deny'])
  expect(w.verdicts![0]!.reason).toContain('did not allow')
  expect(w.ran).toEqual([])
  expect(JSON.stringify([r, w.verdicts])).not.toContain(VALUE)
})

test('still ask: a dismissed prompt is a deny', async ($, on) => {
  const w: World = { core: 'ask', rules: 'ask', answer: 'dismiss', verdicts: [], asked: [], ran: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.asked).toHaveLength(1)
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['deny'])
  expect(w.ran).toEqual([])
})

test("no interactive surface: core's verdict goes on unchanged, and no prompt opens", async ($, on) => {
  const w: World = { core: 'ask', rules: 'ask', answer: 'Allow', surfaces: [], verdicts: [], asked: [], ran: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['ask'])
  expect(w.asked).toEqual([])
  expect(w.ran).toEqual([])
})

test('a Write with a placeholder is shown as written, the file path and content in placeholder form', async ($, on) => {
  const w: World = { core: 'ask', rules: 'ask', answer: 'Allow', verdicts: [], asked: [], ran: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Write', file_path: '/repo/k.txt', content: `KEY=${tag}\n` })
  const question = w.asked![0]!
  expect(question).toContain("Claude's Write call")
  expect(question).toContain('/repo/k.txt')
  expect(question).toContain(tag)
  expect(question).not.toContain(VALUE)
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['allow'])
})

test('a value hidden from output, with no name, is listed by its placeholder', async ($, on) => {
  // Built at run time, so no key-shaped string sits in the repo
  const STRIPE = 'sk_' + 'live_' + '4eC39Hq' + 'LyjWDarjtT1zdp7dc'
  const w: World = { core: 'ask', rules: 'ask', answer: 'Deny', asked: [] }
  // Registered first, so it stands above the world's stub (first is outermost)
  on('tool.call', { tool: 'Read' }, () => ({ result: `key is ${STRIPE}` }))
  world($, on, w)
  const tag = String((await call($, { tool: 'Read', file_path: '/repo/key.txt' })).result).match(TAG)![0]
  await call($, { tool: 'Bash', command: `echo ${tag} | wc -c` })
  expect(w.asked![0]).toContain(`uses a secret: ${tag}.`)
  expect(w.asked![0]).not.toContain(STRIPE)
})

// The hard rule: an allow comes only from core, the user's rules or the
// person. A placeholder call that no rule allows and no person allows is
// never allowed, whatever else happens.
const NO_ALLOW: [string, World][] = [
  ['no rule, no surface', { rules: 'ask', surfaces: [] }],
  ['rules unreadable, no surface', { rules: 'throws', surfaces: [] }],
  ['no rule, the person says Deny', { rules: 'ask', answer: 'Deny' }],
  ['no rule, the person dismisses the prompt', { rules: 'ask', answer: 'dismiss' }],
  ['no rule, the person types other text', { rules: 'ask', answer: 'allow it, please' }],
  ['no rule, the person types lowercase allow', { rules: 'ask', answer: 'allow' }],
  ['rules unreadable, the person says Deny', { rules: 'throws', answer: 'Deny' }],
]
for (const [name, given] of NO_ALLOW) {
  test(`never allowed on secret-box's own judgment: ${name}`, async ($, on) => {
    const w: World = { ...given, core: 'ask', verdicts: [], ran: [] }
    const tag = await loaded($, on, w)
    await call($, { tool: 'Bash', command: curl(tag) })
    expect(w.verdicts).toHaveLength(1)
    expect(w.verdicts![0]!.decision).not.toBe('allow')
    expect(w.ran).toEqual([])
  })
}

test('a call with no placeholder put back is untouched: no query, no prompt', async ($, on) => {
  const w: World = { core: 'ask', rules: 'allow', answer: 'Allow', verdicts: [], queries: [], asked: [] }
  world($, on, w)
  await call($, { tool: 'Bash', command: 'npm test' })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['ask'])
  expect(w.queries).toEqual([])
  expect(w.asked).toEqual([])
})

test('a command that publishes keeps its placeholders, so it is untouched', async ($, on) => {
  const w: World = { core: 'ask', rules: 'allow', answer: 'Allow', verdicts: [], queries: [], asked: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: `git commit -m "rotate ${tag}"` })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['ask'])
  expect(w.queries).toEqual([])
  expect(w.asked).toEqual([])
})

test('a query (no tool_use_id) passes through, even one naming a placeholder', async ($, on) => {
  const w: World = { core: 'allow', rules: 'ask', answer: 'Allow', asked: [] }
  const tag = await loaded($, on, w)
  const v = (await $.tool.check({ tool: 'Bash', input: { command: curl(tag) } })) as Verdict
  expect(v.decision).toBe('ask')
  expect(w.asked).toEqual([])
})

test('the record is dropped once the call ends, and once it is refused', async ($, on) => {
  const w: World = { core: 'allow', rules: 'allow', answer: 'Allow', ids: [], queries: [], asked: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: curl(tag) })
  w.core = 'deny'
  await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.ids).toHaveLength(2)
  // A late check under either id is no longer one of secret-box's calls
  w.core = 'ask'
  for (const tool_use_id of w.ids!) {
    const v = (await $.tool.check({ tool: 'Bash', input: { command: curl(tag) }, tool_use_id })) as Verdict
    expect(v.decision).toBe('ask')
  }
  expect(w.queries).toEqual([])
  expect(w.asked).toEqual([])
})

test("ownApproval off: core's verdict on the call as it runs, no query, no prompt", { options: { ownApproval: false } }, async ($, on) => {
  const w: World = { core: 'ask', rules: 'allow', answer: 'Allow', verdicts: [], queries: [], asked: [] }
  const tag = await loaded($, on, w)
  await call($, { tool: 'Bash', command: curl(tag) })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['ask'])
  expect(w.queries).toEqual([])
  expect(w.asked).toEqual([])
})

test('a tool that gets no real values is untouched', { options: { restoreTools: 'Bash' } }, async ($, on) => {
  const w: World = { core: 'ask', rules: 'allow', answer: 'Allow', verdicts: [], queries: [], asked: [] }
  const tag = await loaded($, on, w)
  // Write is no restore tool here: its placeholder stays one, and its check is core's
  await call($, { tool: 'Write', file_path: '/repo/k.txt', content: tag })
  expect(w.verdicts!.map((v) => v.decision)).toEqual(['ask'])
  expect(w.queries).toEqual([])
  expect(w.asked).toEqual([])
})
