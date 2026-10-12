import { expect, mock, test } from 'claude-code/testing'

import { diff, lastExchange, parseOps } from '../hooks/register'

test('diff names added, updated and deleted memories', async () => {
  const before = new Map([['a.md', '1:10'], ['b.md', '1:10'], ['c.md', '1:10']])
  const after = new Map([['a.md', '1:10'], ['b.md', '2:12'], ['d.md', '3:5']])

  expect(diff(before, after)).toEqual([
    { name: 'b.md', kind: 'updated' },
    { name: 'd.md', kind: 'added' },
    { name: 'c.md', kind: 'deleted' },
  ])
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
