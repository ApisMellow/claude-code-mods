// The macOS Keychain backend: secrets live in the Keychain as generic
// passwords, not in a plaintext .env, and Claude only ever holds placeholders.
//
// Every call runs /usr/bin/security by argv through $.process.run, never a
// shell, so a service name can't run as code. The full path, not `security`:
// a `security` earlier on PATH would be handed the key. Nothing here touches
// the vault; the caller hands what it reads to keepSecret, as the box does.

export const SECURITY = '/usr/bin/security'

// What `security find-generic-password` exits with when no item matches
export const NOT_FOUND = 44

// A service or account goes into argv and into a command you paste into a
// shell: one line of printable text, and not huge.
const MAX_NAME = 256
export function badName(label, value) {
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return `The ${label} holds a control character.`
  if (value.length > MAX_NAME) return `The ${label} is longer than ${MAX_NAME} characters.`
  return ''
}

// -a is left out when no account is given, so an item matches by its service
// alone, the way the items you already have were saved.
export function findArgv(service, account, kind = 'generic') {
  return [SECURITY, `find-${kind}-password`, '-s', service, ...(account ? ['-a', account] : []), '-w']
}

// -U updates the item when it is already there. The value sits in argv while
// the command runs: `ps` can see it then, but it is never written to disk.
export function addArgv(service, account, value) {
  return [SECURITY, 'add-generic-password', '-U', '-s', service, '-a', account, '-w', value]
}

// The command you run to add an item by hand. With -w last, `security`
// prompts for the value, so the key never lands in your shell history.
export function addHint(service, account) {
  return `security add-generic-password -s ${shellWord(service)} -a ${account ? shellWord(account) : '"$USER"'} -w`
}

function shellWord(s) {
  return /^[A-Za-z0-9_.,:@%+=\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

// The account the box saves under: the keychainAccount setting, else your
// macOS user name, as `security add-generic-password -a "$USER"` would.
export async function defaultAccount($, options) {
  return String((options && options.keychainAccount) || '').trim() || (await $.env.get('USER')) || ''
}

// Reads one item: { value }, or { exitCode } when `security` found none or
// could not read it. `-w` ends the value with a newline of its own; only that
// one is taken off. Its stdout and stderr go nowhere else.
export async function readKeychain($, { service, account, kind }) {
  const r = await run($, findArgv(service, account, kind))
  if (r.exitCode !== 0) return { exitCode: r.exitCode }
  return { value: r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout }
}

export async function saveToKeychain($, service, account, value) {
  const r = await run($, addArgv(service, account, value))
  if (r.exitCode !== 0) throw new Error(`security exited ${r.exitCode}`)
}

// A rejected $.process.run may quote its command, and the command may hold
// the key, so the reason is put in words of our own.
async function run($, argv) {
  try {
    return await $.process.run(argv)
  } catch (err) {
    throw new Error(/ENOENT|not found/i.test(String((err && err.message) || err))
      ? `${SECURITY} is missing: the Keychain backend needs macOS`
      : 'security did not finish')
  }
}

// ---------------------------------------------- reads written in a Bash command

// Each `security find-generic-password` (or find-internet-password) in a
// command, up to the next shell separator, and the -s and -a it was given.
const READ = /\bfind-(generic|internet)-password\b([^;&|\n()<>`]*)/g
// A quoted word must end at a space, so `"a"b` is taken whole and judged unknown
const WORD = /"([^"]*)"(?=\s|$)|'([^']*)'(?=\s|$)|(\S+)/g
// The flags of find-*-password that take a value, so a value is not read as a flag
const TAKES_VALUE = new Set(['-a', '-c', '-C', '-d', '-D', '-G', '-j', '-l', '-p', '-P', '-r', '-s', '-t'])

// The text the shell hands `security` for one word, or null where the shell
// would change it ($VAR, `cmd`, a backslash, a glob) and we can't know it.
function literal(m) {
  if (m[1] !== undefined) return /[$`\\]/.test(m[1]) ? null : m[1]
  if (m[2] !== undefined) return m[2]
  return /^[A-Za-z0-9_.,:@%+=\/-]+$/.test(m[3]) ? m[3] : null
}

// The Keychain items a Bash command reads, so they can be loaded into the
// vault before it runs. A read whose -s we can't know is skipped (the detector
// still scans the output); an -a we can't know is dropped, so the service
// alone matches. Flags run together (`-ws name`, `-sname`) are not split.
export function keychainReads(cmd) {
  const reads = new Map()
  for (const m of String(cmd || '').matchAll(READ)) {
    const words = [...m[2].matchAll(WORD)].map(literal)
    let service
    let account
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '-s') service = words[++i]
      else if (words[i] === '-a') account = words[++i]
      else if (TAKES_VALUE.has(words[i])) i++
    }
    if (!service) continue
    const read = { kind: m[1], service, ...(account ? { account } : {}) }
    reads.set(JSON.stringify(read), read)
  }
  return [...reads.values()]
}
