import { expect, test } from 'claude-code/testing'

test('the band draws one line', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.render', () => null)
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any)
  expect(await ui.find({ type: 'Text', text: /cache/ } as any)).toBeDefined()
})
