// diagram-pane: a side pane that keeps a live picture of the work.
//
//   1. Pinned diagrams: every mermaid block or ASCII box diagram Claude writes
//      is pinned in the pane, newest first, drawn as boxes and arrows.
//   2. Live work map: every few turns (and on /diagram) a cheap Haiku gate asks
//      "did the work change shape?". Only on YES does a fork of the session
//      draw a small JSON graph of what Claude is doing right now.
//
// Output goes to the pane only. Nothing is sent back to Claude.

import { findDiagrams, parseMermaid, drawGraph, short } from './draw.js'

const PANE = 'diagrams'

// Everything the pane shows. Pins are rebuilt from the transcript; the map is also saved in $.store.
const S = {
  pins: [],          // [{ kind, code, title, graph, turn }], newest first
  seen: new Set(),   // the code of every diagram pinned so far, to skip repeats
  scanned: 0,        // how many transcript messages we already looked at
  turn: 0,           // prompts the user has sent in this session
  sinceMap: 0,       // turns since the gate last ran
  map: null,         // { title, graph, turn } from the last fork
  mapAt: 0,          // transcript length when the map was drawn
  note: 'The map is drawn after a few turns, or now with /diagram',
  busy: false,       // a gate or fork is running
}

export function register(on, options) {
  const every = Number(options?.everyTurns) || 3
  const maxPins = Number(options?.maxPins) || 5

  on('session.start', async ($, e, next) => {
    // Open the pane right away. Unasked, it is placed on a wide terminal (144+ columns);
    // /diagram opens it at any width.
    await $.ui.open({ id: PANE, title: 'Diagrams' })
    try {
      await $.command.register({ name: 'diagram', description: 'Redraw the live work map in the diagram pane', argumentHint: '[force]' })
    } catch (err) {
      $.ui.log('could not add /diagram: ' + err.message)
    }
    return next(e)
  })

  // After each main turn: pin new diagrams, and every few turns refresh the map
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.isAborted) return result
    S.sinceMap += 1
    const messages = await $.session.messages()
    S.turn = turnsIn(messages)
    if (!S.map) await loadMap($)
    pinNewDiagrams(messages, maxPins)
    if (S.pins.length && !(await $.ui.panes()).some(p => p.id === PANE)) await $.ui.open({ id: PANE, title: 'Diagrams' })
    const n = Number(await $.env.get('DIAGRAM_PANE_EVERY')) || every
    if (S.sinceMap >= n) {
      const work = refreshMap($, messages, false)
      // Headless runs exit when the hook returns, so tests can ask us to wait
      if (await $.env.get('DIAGRAM_PANE_SYNC')) await work
    }
    await redraw($)
    return result
  })

  // /diagram runs the gate now; /diagram force skips the gate and always redraws
  on('command.run', { command: 'diagram' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Diagrams' })
    const messages = await $.session.messages()
    S.turn = turnsIn(messages)
    if (!S.map) await loadMap($)
    pinNewDiagrams(messages, maxPins)
    const work = refreshMap($, messages, e.args.trim() === 'force')
    if (await $.env.get('DIAGRAM_PANE_SYNC')) await work
    return {}
  })

  // The pane itself: one Text per line, cut at the pane's width
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(Math.max(30, e.props.bodyColumns || 60))
    return h(Box, { flexDirection: 'column' },
      ...lines.map(l => h(Text, { color: l.color, bold: l.bold, dimColor: l.dim, wrap: 'truncate-end' }, l.text || ' ')))
  })
}

// ---------------------------------------------------------------------------
// Pinned diagrams
// ---------------------------------------------------------------------------

// A turn is a prompt the user typed (tool results also arrive as user messages)
function turnsIn(messages) {
  return messages.filter(m => m.role === 'user' && m.text && !m.toolResults?.length).length
}

function pinNewDiagrams(messages, maxPins) {
  if (messages.length < S.scanned) S.scanned = 0 // compacted: rescan, `seen` stops repeats
  messages.forEach((m, i) => {
    if (i < S.scanned || m.role !== 'assistant') return
    for (const d of findDiagrams(m.text)) {
      if (S.seen.has(d.code)) continue
      S.seen.add(d.code)
      // Parse mermaid flowcharts into a graph; anything else is shown as written
      const graph = d.kind === 'mermaid' ? parseMermaid(d.code) : null
      S.pins.unshift({ ...d, graph, turn: turnsIn(messages.slice(0, i)) })
    }
  })
  S.scanned = messages.length
  S.pins.length = Math.min(S.pins.length, maxPins)
}

// ---------------------------------------------------------------------------
// Live work map: the gate, then the fork
// ---------------------------------------------------------------------------

const GATE_SYSTEM = 'You watch a coding agent so a small diagram of its work stays current. Answer with exactly one word: YES or NO.'

const FORK_PROMPT = `[diagram-pane side request: not from the user. Do not continue the task and do not call tools.]
Draw a compact map of the work in this session right now: the files, components and steps involved, and how they connect.
Reply with ONLY one JSON object, no prose and no code fence:
{"title":"what the work is, max 40 chars","nodes":[{"id":"a","label":"max 20 chars","kind":"file|component|step","now":false}],"edges":[{"from":"a","to":"b","label":"optional, max 10 chars"}]}
Map the task, not the chat: steps are steps of the work ("add discount", "run tests"), never "read files" or "explain".
Rules: 3 to 8 nodes. Edges point from earlier to later, or from caller to callee, so the map reads top to bottom. At most 10 edges. Use file basenames as file labels. Set "now": true on the one node being worked on at this moment.`

async function refreshMap($, messages, force) {
  if (S.busy) return
  S.busy = true
  S.sinceMap = 0
  try {
    // 1. The cheap gate: skipped only when there is no map yet, or on /diagram force
    if (S.map && !force) {
      S.note = 'gate: checking if the work changed shape...'
      await redraw($)
      const activity = messages.slice(S.mapAt)
      const gate = await $.model.complete({
        model: 'haiku',
        system: GATE_SYSTEM,
        prompt: `CURRENT MAP: ${mapSummary()}\n\nFILES TOUCHED SINCE, NOT ON THE MAP: ${newFiles(activity).join(', ') || 'none'}\n\n` +
          `ACTIVITY SINCE THE MAP WAS DRAWN:\n${digest(activity)}\n\n` +
          'Answer YES if the map is now out of date: the work touched files or components the map lacks, added a step ' +
          '(such as tests, a new feature, a fix), or moved to a different task. Answer NO only if the map still shows the work. YES or NO?',
        maxTokens: 5,
        timeoutMs: 20000,
      })
      const yes = gate.isAnswered && /^\s*yes/i.test(gate.text)
      if (!yes) {
        S.note = `gate said same shape at turn ${S.turn}, map kept` + (gate.isAnswered ? '' : ` (${gate.reason})`)
        return
      }
    }
    // 2. The fork: the session's own context, asked for JSON. It cannot call tools.
    S.note = 'fork: drawing the work map...'
    await redraw($)
    const r = await $.model.fork({ prompt: FORK_PROMPT })
    if (!r.isAnswered) {
      S.note = r.reason === 'nothing-to-fork' ? 'nothing to map yet: send a prompt first' : 'fork failed: ' + r.reason
      return
    }
    const map = parseMap(r.text)
    if (!map) {
      S.note = 'fork reply was not a graph: ' + short(r.text.replace(/\s+/g, ' '), 60)
      return
    }
    S.map = { ...map, turn: S.turn }
    S.mapAt = messages.length
    S.note = `map drawn at turn ${S.turn}`
    await saveMap($)
  } catch (err) {
    S.note = 'map error: ' + err.message
  } finally {
    S.busy = false
    await redraw($)
  }
}

// The fork's JSON becomes the same { nodes, edges } shape a mermaid chart parses to
function parseMap(text) {
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const box = { file: 'single', component: 'round', step: 'double' }
    const nodes = (json.nodes || []).slice(0, 10).map(n => ({
      id: String(n.id),
      label: (n.now ? '▶ ' : '') + short(n.label || n.id, 22),
      box: box[n.kind] || 'single',
    }))
    const edges = (json.edges || []).slice(0, 14).map(e => ({ from: String(e.from), to: String(e.to), label: short(e.label || '', 10) }))
    return nodes.length ? { title: short(json.title || 'the work', 50), graph: { nodes, edges } } : null
  } catch {
    return null
  }
}

// The map is kept per session in the plugin's store, so it survives a reload or --resume
async function loadMap($) {
  const saved = ((await $.store.get('maps')) || {})[await $.session.id()]
  if (saved) Object.assign(S, { map: saved.map, mapAt: saved.mapAt, note: `map from turn ${saved.map.turn}` })
}

async function saveMap($) {
  const maps = (await $.store.get('maps')) || {}
  maps[await $.session.id()] = { map: S.map, mapAt: S.mapAt, at: await $.clock.now() }
  // Keep the 20 newest sessions only
  const keep = Object.entries(maps).sort((a, b) => b[1].at - a[1].at).slice(0, 20)
  await $.store.set('maps', Object.fromEntries(keep))
}

function mapSummary() {
  const { nodes, edges } = S.map.graph
  const name = id => nodes.find(n => n.id === id)?.label
  return `"${S.map.title}": ` + nodes.map(n => n.label).join(', ') + '; ' + edges.map(e => `${name(e.from)} -> ${name(e.to)}`).join(', ')
}

// Files Claude read, wrote or edited whose names the map does not mention
function newFiles(messages) {
  const onMap = S.map.graph.nodes.map(n => n.label).join(' ')
  const names = messages.flatMap(m => (m.toolUses || []).map(t => String(t.input?.file_path || '').split('/').pop()))
  return [...new Set(names)].filter(n => n && !onMap.includes(n))
}

// What happened since the map was drawn, as short lines: prompts and tool calls
function digest(messages) {
  const lines = []
  for (const m of messages) {
    if (m.role === 'user' && m.text && !m.toolResults?.length) lines.push('user: ' + short(m.text.replace(/\s+/g, ' '), 160))
    for (const t of m.toolUses || []) {
      const i = t.input || {}
      lines.push(`${t.tool}: ` + short(String(i.file_path || i.path || i.command || i.pattern || i.description || ''), 100))
    }
  }
  return lines.slice(-40).join('\n') || '(nothing)'
}

// ---------------------------------------------------------------------------
// What the pane draws
// ---------------------------------------------------------------------------

// Lines of { text, color, bold, dim }, cut to `w` columns
function paneLines(w) {
  const out = []
  const add = (text, style = {}) => out.push({ text, ...style })
  const rule = () => add('─'.repeat(w), { dim: true })

  add(spread('◆ LIVE WORK MAP', S.map ? `turn ${S.map.turn}` : '', w), { bold: true, color: 'cyan' })
  if (S.map) {
    add(S.map.title, { bold: true })
    for (const l of drawGraph(S.map.graph, w)) add(l, { color: 'cyan' })
    add('┌ file   ╭ component   ╔ step   ▶ now', { dim: true })
  }
  add((S.busy ? '… ' : '') + S.note, { dim: true })
  rule()

  add(spread('◆ PINNED DIAGRAMS', S.pins.length ? `${S.pins.length} pinned` : '', w), { bold: true, color: 'magenta' })
  if (!S.pins.length) add('Mermaid or box diagrams Claude writes appear here.', { dim: true })
  S.pins.forEach((p, i) => {
    if (i) add('')
    const what = p.graph ? `flowchart, ${p.graph.nodes.length} boxes` : p.kind === 'mermaid' ? 'mermaid' : 'box diagram'
    add(short(`${i + 1}. ${p.title || what} · turn ${p.turn}`, w), { bold: true })
    if (p.graph) for (const l of drawGraph(p.graph, w)) add(l)
    else {
      // Not a flowchart we can draw: show the code as written, dimmed for mermaid
      if (p.kind === 'mermaid') add('(raw mermaid: only flowcharts are drawn)', { dim: true })
      for (const l of p.code.split('\n')) add(l, { dim: p.kind === 'mermaid' })
    }
  })
  return out
}

function spread(left, right, w) {
  return right ? left + ' '.repeat(Math.max(1, w - left.length - right.length)) + right : left
}

// Ask for a redraw, and in tests also write the pane's text to a file
async function redraw($) {
  $.ui.invalidate('ui.render')
  const dump = await $.env.get('DIAGRAM_PANE_DUMP')
  if (dump) await $.fs.write(dump, paneLines(60).map(l => l.text).join('\n') + '\n')
}
