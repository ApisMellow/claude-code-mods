import assert from 'node:assert/strict'

for (const relativePath of ['../hooks/detect.ts', '../../secret-box/hooks/detect.ts']) {
  const moduleUrl = new URL(relativePath, import.meta.url)
  const current = await import(moduleUrl.href)
  const next = await import(`${moduleUrl.href}?session=2`)
  const currentConfig = current.makeConfig({ pii: true })
  const nextConfig = next.makeConfig({ pii: true })
  const addresses = ['dana.whitfield@northwind-labs.io', 'lee.morgan@northwind-labs.io']
  const currentTags = addresses.map(address => current.scrubPii(address, currentConfig))
  const nextTags = addresses.map(address => next.scrubPii(address, nextConfig))

  for (const [index, address] of addresses.entries()) {
    assert.match(currentTags[index], /^\[REDACTED-EMAIL-[0-9a-f]{8}\]$/)
    assert.match(nextTags[index], /^\[REDACTED-EMAIL-[0-9a-f]{8}\]$/)
    assert.equal(current.scrubPii(address, currentConfig), currentTags[index])
    assert.equal(current.restore(currentTags[index]), address)
    assert.equal(next.restore(nextTags[index]), address)
  }

  assert.notDeepEqual(currentTags, nextTags, `${relativePath}: tags must not be linkable across sessions`)
  console.log(`ok  ${relativePath}: stable within a session, private across sessions, round trips clean`)
}
