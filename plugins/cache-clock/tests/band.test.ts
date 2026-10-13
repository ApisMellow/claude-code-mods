import { expect, test } from 'claude-code/testing'

import { pickAction } from '../hooks/register'

test('the band draws one line', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.render', () => null)
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any)
  expect(await ui.find({ type: 'Text', text: /cache/ } as any)).toBeDefined()
})

test('the warning action comes from the env var, then the old switch, then the setting', async () => {
  expect(pickAction(undefined, undefined, undefined)).toBe('handoff')
  expect(pickAction(undefined, undefined, 'compact')).toBe('compact')
  expect(pickAction(undefined, '0', 'compact')).toBe('off')
  expect(pickAction('compact', '0', 'off')).toBe('compact')
  expect(pickAction('nonsense', undefined, undefined)).toBe('handoff')
})
