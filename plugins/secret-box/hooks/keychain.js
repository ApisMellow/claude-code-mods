// The macOS Keychain backend: secrets live in the Keychain as generic
// passwords, not in a plaintext .env, and Claude only ever holds placeholders.
//
// Every call runs /usr/bin/security by argv through $.process.run, never a
// shell, so a service name can't run as code. The full path, not `security`:
// a `security` earlier on PATH would be handed the key. Nothing here touches
// the vault; the caller hands what it reads to keepSecret, as the box does.

export const SECURITY = '/usr/bin/security'

// What `security find-*-password` exits with when no item matches
export const NOT_FOUND = 44

// The vault can only find a value again where it turns up when it is at least
// this long (detect.ts indexes values by their first 8 characters)
export const MIN_HIDDEN = 8

// The redactor's rule (redact.ts SHELL_ACTIVE) for a value it won't put into
// a Bash command, since it could run there as code. A test pins the two together.
export const SHELL_ACTIVE = /[\s$`"'\\;&|<>()*?[\]{}#~]|[\x00-\x1f\x7f]/

// Whether this is a Mac: 'mac', 'other', or 'unknown' when it can't be told.
// The mods API has no platform call: Windows says so in OS; anything else
// answers uname, run by its full path so nothing on PATH stands in for it.
export async function platformOf($) {
  try {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'other'
  } catch {}
  for (const uname of ['/usr/bin/uname', '/bin/uname']) {
    try {
      const r = await $.process.run([uname, '-s'])
      const name = r.exitCode === 0 ? r.stdout.trim() : ''
      if (name) return name === 'Darwin' ? 'mac' : 'other'
    } catch {}
  }
  return 'unknown'
}

// Where the box saves: keychain, dotenv, or unknown when `auto` (and any value
// that is neither) meets a platform that can't be told. The box saves nowhere then.
export function boxBackend(choice, platform) {
  if (choice === 'keychain' || choice === 'dotenv') return choice
  return platform === 'mac' ? 'keychain' : platform === 'other' ? 'dotenv' : 'unknown'
}

// A service or account goes into argv and into a command you paste into a
// shell: one line of printable text, and not huge.
const MAX_NAME = 256
export function badName(label, value) {
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return `The ${label} holds a control character.`
  if (value.length > MAX_NAME) return `The ${label} is longer than ${MAX_NAME} characters.`
  return ''
}

// -U updates the item when it is already there. The value sits in argv while
// the command runs, where `ps` and any mod hooked on process.run can see it.
export function addArgv(service, account, value) {
  return [SECURITY, 'add-generic-password', '-U', '-s', service, '-a', account, '-w', value]
}

// The command you run to add an item by hand. With -w last, `security`
// prompts for the value, so the key never lands in your shell history; -U
// replaces an item that is already there.
export function addHint(service, account) {
  return `security add-generic-password -U -s ${shellWord(service)} -a ${account ? shellWord(account) : '"$USER"'} -w`
}

// What Claude writes in a Bash command for a value it can't hold as a
// placeholder: the shell reads the item as the command runs, so the value
// never enters the command text. -w prints a printable value as it is.
export function readCommand(service, account) {
  return `"$(${SECURITY} find-generic-password -s ${shellWord(service)}${account ? ` -a ${shellWord(account)}` : ''} -w)"`
}

function shellWord(s) {
  return /^[A-Za-z0-9_.,:@%+=\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

// The account the box saves under: the keychainAccount setting, else your
// macOS user name, as `security add-generic-password -a "$USER"` would.
export async function defaultAccount($, options) {
  return String((options && options.keychainAccount) || '').trim() || (await $.env.get('USER')) || ''
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

// ------------------------------------------------------------- reading an item

// A read is the subcommand's kind, its match options in the order given, as
// [flag, value] pairs, and the keychain files it searches. use_secret reads by
// service, and by account when one is given: without -a an item matches by its
// service alone, the way the items you already have were saved.
export function serviceRead(service, account) {
  return { kind: 'generic', criteria: [['-s', service], ...(account ? [['-a', account]] : [])], keychains: [] }
}

// Always -g, whatever a command used: it says plainly how the password is
// written, where -w prints plain text and hex alike.
export function findArgv(read) {
  return [SECURITY, `find-${read.kind}-password`, ...read.criteria.flat(), '-g', ...read.keychains]
}

// `security -g` prints the password on stderr in one of three shapes:
//   password: "text"                       every byte printable, no " or \
//   password: 0x6C696E65310A  "line1\012"   anything else: hex, then an escaped copy
//   password:                              an empty password
// `-w` prints the text and a newline, or, when any byte is not printable
// ASCII, the bytes as lowercase hex and a newline.
const PASSWORD = /^password: (?:"(.*)"|0x((?:[0-9A-F]{2})*) {2}".*"|)$/m

// Reads one item: { value, printed }, or { exitCode } when security found no
// item or could not read it. `printed` is every way security can print the
// password, so each can be hidden; `value` is its text, undefined when the
// bytes are not UTF-8. Nothing security prints goes anywhere else.
export async function readKeychain($, read) {
  const r = await run($, findArgv(read))
  if (r.exitCode !== 0) return { exitCode: r.exitCode }
  // A cut-off answer could hold half a password
  if (r.isStdoutTruncated || r.isStderrTruncated) throw new Error("security's answer was cut off")
  const m = String(r.stderr).match(PASSWORD)
  if (!m) throw new Error('security printed no password line')
  if (m[2] === undefined) return { value: m[1] ?? '', printed: m[1] ? [m[1]] : [] }
  return { value: utf8(m[2]), printed: printedForms(m[2]) }
}

// The ways a password security shows as hex can turn up: the text, each of its
// lines long enough to hide (a command may print one line of a PEM), -w's
// lowercase hex, -g's uppercase hex, and -g's escaped copy, where \ and every
// byte that is not printable ASCII is written \ooo in octal.
function printedForms(hex) {
  const bytes = (hex.match(/../g) || []).map((b) => parseInt(b, 16))
  const escaped = bytes.map((n) => (n >= 0x20 && n < 0x7f && n !== 0x5c ? String.fromCharCode(n) : '\\' + n.toString(8).padStart(3, '0'))).join('')
  const text = utf8(hex)
  const lines = text && text.includes('\n') ? text.split(/\r?\n/).filter((l) => l.length >= MIN_HIDDEN) : []
  return [...new Set([text, ...lines, hex.toLowerCase(), hex, escaped])].filter(Boolean)
}

// Bytes to text by way of %XX, since the hooks run with no TextDecoder
function utf8(hex) {
  try {
    return decodeURIComponent(hex.replace(/../g, '%$&'))
  } catch {
    return undefined
  }
}

// ---------------------------------------------- Keychain reads in a Bash command

// The variables a read may name that the hook can know. $.env only reads
// names spelled in the source, so these are the ones it fetches.
export const READ_ENV = ['USER', 'LOGNAME', 'HOME']

// The match options of each subcommand: the flags that take a value. -g and -w
// take none; any other flag (-h) is one we don't follow.
const MATCH = { generic: 'acCDGjls', internet: 'acCdDjlpPrst' }
const READS = ['find-generic-password', 'find-internet-password']
const MENTION = /find-(?:generic|internet)-password|dump-keychain/g

// The Keychain reads a Bash command makes, each a read for readKeychain, or
// { unknown: why } where we can't know exactly which item it reads or what it
// prints: a word only the shell can know ($VAR, a glob, $(...)), a prefix
// (sudo, env, VAR=x) that could change whose Keychain it reads, a relative
// keychain file, `security -i` or `dump-keychain`, or a read that isn't a
// command of its own (inside quotes for `sh -c`). `env` holds READ_ENV's values.
export function keychainReads(cmd, env = {}) {
  const text = String(cmd || '')
  const ctx = { text, env, commands: [], comments: [] }
  lex(text, 0, '', ctx)
  const reads = new Map()
  const add = (read) => reads.set(JSON.stringify(read), read)
  let seen = 0
  for (const words of ctx.commands) {
    seen += words.filter((w) => READS.includes(w) || w === 'dump-keychain').length
    const read = readOf(words)
    if (read) add(read)
  }
  // A mention outside a comment that isn't a word of its own: inside quotes, or glued to others
  let code = ''
  let from = 0
  for (const [start, end] of ctx.comments) {
    code += text.slice(from, start)
    from = end
  }
  code += text.slice(from)
  if ((code.match(MENTION) || []).length > seen) add({ unknown: 'part of it could not be parsed' })
  return [...reads.values()]
}

// What one simple command reads from the Keychain: nothing (undefined), a
// read, or { unknown }. A read is `security [-lqv] [-p prompt]
// find-*-password [options] [keychain...]`, its options read as getopt does:
// bundled (`-wa NAME`), attached (`-sNAME`), and ended by the first word that
// is not one, which starts the keychain files.
function readOf(command) {
  // A keyword that starts a command inside if, for or while is not the command
  let words = command
  while (['do', 'then', 'else', 'elif', '!', 'time'].includes(words[0])) words = words.slice(1)
  const unknown = (why) => ({ unknown: why })
  const unknowable = unknown('a word in it is only known when it runs')
  const at = words.findIndex((w) => READS.includes(w) || w === 'dump-keychain')
  const runsSecurity = typeof words[0] === 'string' && /(?:^|\/)security$/.test(words[0])
  if (at < 0 && !runsSecurity) return undefined
  if (words[0] !== 'security' && words[0] !== SECURITY) {
    // sudo security, env security, $SEC find-...: security run in a way we can't
    // follow. `grep find-generic-password` only names the subcommand.
    const before = words.slice(0, Math.max(at, 1))
    return before.some((w) => w === null || /(?:^|\/)security$/.test(w)) ? unknown('something other than security runs it') : undefined
  }
  let k = 1
  for (; k < words.length; k++) {
    if (words[k] === '-p') k++
    else if (/^-[hilqv]+$/.test(words[k] ?? '')) {
      if (words[k].includes('i')) return unknown('it runs security interactively')
    } else break
  }
  // No command: security reads its commands from its input
  if (k >= words.length) return unknown('it runs security without a command')
  if (words[k] === null) return unknowable
  if (k !== at) return undefined // another command (add-generic-password ...)
  if (words[at] === 'dump-keychain') return unknown('it dumps the keychain')
  const kind = words[at].slice('find-'.length, -'-password'.length)
  const args = words.slice(at + 1)
  const criteria = []
  for (k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === null) return unknowable
    if (a === '--') {
      k++
      break
    }
    if (a[0] !== '-' || a === '-') break
    for (let p = 1; p < a.length; p++) {
      if (a[p] === 'g' || a[p] === 'w') continue
      if (!MATCH[kind].includes(a[p])) return unknown(`it uses -${a[p]}`)
      const value = p + 1 < a.length ? a.slice(p + 1) : args[++k]
      if (value === undefined) return unknown(`its -${a[p]} has no value`)
      if (value === null) return unknowable
      criteria.push([`-${a[p]}`, value])
      break
    }
  }
  const keychains = args.slice(k)
  if (keychains.includes(null)) return unknowable
  // A relative path is found from the shell's folder, which the hook can't see
  if (keychains.some((f) => !f.startsWith('/'))) return unknown('it names a keychain file by a relative path')
  return { kind, criteria, keychains }
}

// Splits a command into the words of each simple command, the way zsh and
// bash hand them over, as far as we can know them: a word is its text, or
// null where the shell turns it into something we don't hold. The commands
// inside $( ) and backticks are read as commands too. Returns where it stopped.
function lex(s, i, stop, ctx) {
  let words = []
  let word // undefined: none started; null: one we can't know
  let drop = false // the next word is a redirection's target, not an argument
  const put = (piece) => { word = word === null || piece === null ? null : (word ?? '') + piece }
  const endWord = () => {
    if (word === undefined) return
    if (drop) drop = false
    else words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length) ctx.commands.push(words)
    words = []
    drop = false
  }
  while (i < s.length) {
    const c = s[i]
    if (c === stop) {
      endCommand()
      return i + 1
    }
    if (c === '\\') {
      // A line continuation joins two lines; any other escaped character is itself
      if (s[i + 1] !== '\n') put(s[i + 1] ?? '')
      i += 2
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else if (c === '#' && word === undefined) {
      const start = i
      while (i < s.length && s[i] !== '\n') i++
      ctx.comments.push([start, i])
    } else if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      // A redirection (2>/dev/null, &>log, 2>&1): its fd and its target aren't arguments
      if (typeof word === 'string' && /^\d+$/.test(word)) word = undefined
      endWord()
      drop = true
      i++
      while (i < s.length && '<>&|-'.includes(s[i])) i++
    } else if (';&|\n()'.includes(c)) {
      endCommand()
      i++
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1)
      put(end < 0 ? null : s.slice(i + 1, end))
      i = end < 0 ? s.length : end + 1
    } else if (c === '"') {
      i = quoted(s, i + 1, ctx, put)
    } else if (c === '$' || c === '`') {
      i = expand(s, i, ctx, put, false)
    } else if (c === '~' && word === undefined) {
      // ~ and ~/x are the home folder, unless the command changes HOME; ~name is someone else's
      const tilde = /^~[\w.+-]*/.exec(s.slice(i))[0]
      put(tilde === '~' && !isSet('HOME', ctx.text) ? (ctx.env.HOME ?? null) : null)
      i += tilde.length
    } else if ('*?[]{}'.includes(c) || (c === '=' && word === undefined)) {
      // Globs, braces and zsh's =cmd become text we can't know
      put(null)
      i++
    } else {
      put(c)
      i++
    }
  }
  endCommand()
  return i
}

// The inside of "...": $ and backticks expand, a backslash escapes only
// $ ` " \ and a newline. An unterminated quote can't be known.
function quoted(s, i, ctx, put) {
  let piece = ''
  const add = (p) => { piece = piece === null || p === null ? null : piece + p }
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && '$`"\\\n'.includes(s[i + 1] ?? 'x')) {
      if (s[i + 1] !== '\n') add(s[i + 1])
      i += 2
    } else if (s[i] === '$' || s[i] === '`') {
      i = expand(s, i, ctx, add, true)
    } else {
      add(s[i])
      i++
    }
  }
  put(i < s.length ? piece : null)
  return i + 1
}

// Whether the command could change a variable: its name as a word of its own
// anywhere (`USER=x`, `for USER in`, `read USER`, `unset USER`), not as $NAME
// or ${NAME}. A name that only appears in some other sense makes it unknown too.
function isSet(name, text) {
  return new RegExp(`(?<![\\w$]|\\$\\{)${name}(?!\\w)`).test(text)
}

// $NAME, ${NAME}, $( ) and backticks. Only READ_ENV's names are known, and
// only while the command can't change them. The command inside $( ) or
// backticks is read too; what it prints can't be known.
function expand(s, i, ctx, put, isQuoted) {
  if (s[i] === '`') {
    put(null)
    return lex(s, i + 1, '`', ctx)
  }
  const next = s[i + 1]
  if (next === '(') {
    put(null)
    return lex(s, i + 2, ')', ctx)
  }
  if (next === "'") {
    // $'...' turns escapes into bytes
    put(null)
    const end = s.indexOf("'", i + 2)
    return end < 0 ? s.length : end + 1
  }
  if (next === '"') {
    // $"..." is translated text
    put(null)
    return quoted(s, i + 2, ctx, () => {})
  }
  const m = /^\$(?:\{(\w+)\}|([A-Za-z_]\w*))/.exec(s.slice(i, i + 130))
  if (m) {
    const name = m[1] || m[2]
    const end = i + m[0].length
    // zsh changes an unbraced $USER:u (modifiers) and $USER[1] (subscripts)
    const isChanged = m[2] !== undefined && (s[end] === '[' || (s[end] === ':' && /[A-Za-z]/.test(s[end + 1] ?? '')))
    let value = READ_ENV.includes(name) && !isChanged && !isSet(name, ctx.text) ? ctx.env[name] : undefined
    // Unquoted, bash splits a value on IFS and globs it, and zsh does neither
    if (value !== undefined && !isQuoted && (/[\s*?[\]]/.test(value) || /IFS/.test(ctx.text))) value = undefined
    put(value ?? null)
    return end
  }
  if (next === '{') {
    put(null)
    const end = s.indexOf('}', i)
    return end < 0 ? s.length : end + 1
  }
  if (/[\w?$!#*@-]/.test(next ?? '')) {
    put(null)
    return i + 2
  }
  // A $ before a space, a quote or the end is itself
  put('$')
  return i + 1
}
