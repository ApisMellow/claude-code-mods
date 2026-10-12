import { expect, mock, test } from 'claude-code/testing'

import { diff, lastExchange, lineDiff, parseOps, totals } from '../hooks/register'

test('diff names added, updated and deleted memories with their line counts', async () => {
  const before = new Map([['a.md', 'one\ntwo\n'], ['b.md', 'one\ntwo\nthree\n'], ['c.md', 'gone\nalso gone\n']])
  const after = new Map([['a.md', 'one\ntwo\n'], ['b.md', 'one\n2\nthree\nfour\n'], ['d.md', 'new\n']])

  expect(diff(before, after)).toEqual([
    { name: 'b.md', kind: 'updated', added: 2, removed: 1 },
    { name: 'd.md', kind: 'added', added: 1, removed: 0 },
    { name: 'c.md', kind: 'deleted', added: 0, removed: 2 },
  ])
  expect(totals(diff(before, after))).toEqual({ added: 3, removed: 3 })
})

test('lineDiff counts a moved line as one removed and one added', async () => {
  expect(lineDiff('a\nb\nc', 'b\nc\na')).toEqual({ added: 1, removed: 1 })
  expect(lineDiff('', '')).toEqual({ added: 0, removed: 0 })
  expect(lineDiff('same\n', 'same')).toEqual({ added: 0, removed: 0 })
})

test('lastExchange starts at the latest typed prompt', async () => {
  const text = lastExchange([
    { role: 'user', text: 'old prompt', toolUses: [] },
    { role: 'assistant', text: 'old answer', toolUses: [] },
    { role: 'user', text: 'remember I prefer bun', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'x', isError: false } as never] },
    { role: 'assistant', text: 'Noted.', toolUses: [] },
  ])

  expect(text).toBe('USER: remember I prefer bun\nTOOL: Read\nASSISTANT: Noted.')
})

test('the main session may not write the memory folder', async ($, on) => {
  mock.env(on, { HOME: '/home/r' })
  on('session.cwd', () => ({ value: '/w/proj' }))
  on('tool.call', () => ({ result: 'written' }) as never)

  const blocked = await $.tool.call({ tool: 'Write', file_path: '/home/r/.claude/projects/-w-proj/memory/x.md', content: 'x' })
  const allowed = await $.tool.call({ tool: 'Write', file_path: '/w/proj/x.md', content: 'x' })

  expect(blocked.deny ?? blocked.text).toContain('memory-fork')
  expect(allowed.deny).toBeUndefined()
})

test('parseOps keeps bare memory names and never deletes the index', async () => {
  const ops = parseOps(`Here: {"write": [{"name": "a.md", "content": "x"}, {"name": "../evil.md", "content": "x"}, {"name": "b.txt", "content": "x"}], "delete": ["MEMORY.md", "c.md", "/etc/d.md"]}`)

  expect(ops).toEqual({ write: [{ name: 'a.md', content: 'x' }], delete: ['c.md'] })
})
