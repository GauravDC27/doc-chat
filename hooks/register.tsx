import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AskKind, DocChat, LibraryEntry, LibraryState, Quote, QuoteSource, Turn, Widget } from '../types'
import { KIND_LABEL, KIND_QUESTION, MAX_QUOTE_CHARS, buildPrompt, systemPrompt } from './ask'
import { UNIT_URL, baseName, clickablePage, hashPath, isInDoc, isInText, joinUnits, kindOf, loadDoc, matchScore, resolvePath, scanDocs, titleFromPath } from './docs'
import type { LoadedDoc } from './docs'

type $ = EngineInterface
type QuickKind = Exclude<AskKind, 'ask'>

/** The one pane: a small widget in the corner, expanded into the reader and chat. */
const PANE = 'docchat'
const GENERAL = 'general'
const TOOL = 'open_doc'
const QUICK: QuickKind[] = ['explain', 'why', 'how', 'example', 'simpler']
const FIND = '__find'
const SESSION_TEXT = '__session'
const PAGE_CHARS = 12_000
/** How often the widget looks for a new selection; the clipboard is read every third look. */
const LOOK_MS = 800

const EMPTY_WIDGET: Widget = {
  docId: null,
  view: 'read',
  askSeq: 0,
  showLatest: false,
  showAll: false,
  isClearArmed: false,
  isPicking: false,
  filter: '',
  findSeq: 0,
  isClosed: false,
  isBandHidden: false,
}

// Bump a shape tag when that value's fields change: it declines what an earlier version stored.
const chatsAtom = atom({ plugin: 'doc-chat', key: 'chats' } as const, {}, { shape: 'chats-1' })
const widgetAtom = atom({ plugin: 'doc-chat', key: 'widget' } as const, EMPTY_WIDGET, { shape: 'widget-1' })
const libraryAtom = atom({ plugin: 'doc-chat', key: 'library' } as const, { entries: [], isScanning: false }, { shape: 'library-2' })

export const DEFAULT_BACKGROUND =
  'An engineer comfortable with Python and the basics of machine learning. Wants the AI and ML ideas underneath: architectures, the maths, why a technique is used and what the alternatives were, and the research it comes from.'

type Effort = 'low' | 'medium' | 'high'
const cfg = {
  model: 'claude-sonnet-5-5',
  effort: 'medium' as Effort,
  background: DEFAULT_BACKGROUND,
  folders: [] as string[],
  autoOpen: true,
  watchClipboard: true,
}

let cwd = ''
let home = ''
let dataDir: string | null | undefined
const docs = new Map<string, LoadedDoc>()
const loading = new Map<string, Promise<LoadedDoc | null>>()
const stoppers = new Map<string, AbortController>()
let looker: Timer | undefined
let looks = 0
let isLooking = false
/** What was on screen and on the clipboard at the last look; undefined until the first, which only notes it. */
let seenSel: string | undefined
let seenClip: string | undefined
let isScanning = false

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  if (m) return `${(m[1] ?? '').charAt(0).toUpperCase()}${(m[1] ?? '').slice(1)} ${m[2]}.${m[3]}`
  return id.charAt(0).toUpperCase() + id.slice(1)
}

const shortTitle = (t: string, n = 40) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

const oneLine = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

function shortPath(path: string): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

function folderOf(path: string): string {
  const dir = shortPath(path).replace(/\/?[^/]*$/, '')
  return dir || '.'
}

function ago(then: number, now: number): string {
  if (!then) return ''
  const m = Math.round((now - then) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

const SOURCE_LABEL: Record<QuoteSource, string> = {
  pick: 'Selected',
  selection: 'Selected',
  clipboard: 'Copied from the doc',
  menu: 'From the chat',
}

async function env($: $) {
  if (dataDir !== undefined) return
  const e = await $.process.hookEnv()
  dataDir = e.CLAUDE_PLUGIN_DATA ? e.CLAUDE_PLUGIN_DATA.replace(/\/+$/, '') : null
  home = home || e.HOME || /^(\/(?:Users|home)\/[^/]+)/.exec(dataDir ?? cwd)?.[1] || ''
}

// ---- Shared files in the plugin's data folder, so every session sees the same threads and recent docs ----

type IndexRow = { path: string | null; title: string; questions: number; lastAskedAt: number }
type RecentRow = { path: string; title: string; at: number }

async function readJson<T>($: $, path: string): Promise<T | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function readIndex($: $): Promise<Record<string, IndexRow>> {
  await env($)
  return dataDir ? ((await readJson<Record<string, IndexRow>>($, `${dataDir}/index.json`)) ?? {}) : {}
}

async function readRecent($: $): Promise<RecentRow[]> {
  await env($)
  if (!dataDir) return []
  const rows = await readJson<RecentRow[]>($, `${dataDir}/recent.json`)
  return Array.isArray(rows) ? rows.filter(r => r && typeof r.path === 'string' && typeof r.at === 'number') : []
}

/** Puts a doc at the top of every session's recent list. */
async function touchRecent($: $, path: string, title: string) {
  await env($)
  if (!dataDir) return
  const at = await $.clock.now()
  const rows = (await readRecent($)).filter(r => r.path !== path)
  rows.unshift({ path, title, at })
  await $.fs.write(`${dataDir}/recent.json`, JSON.stringify(rows.slice(0, 40)))
  await update($, libraryAtom, l => {
    const has = l.entries.some(x => x.path === path)
    const entries = has
      ? l.entries.map(x => (x.path === path ? { ...x, openedAt: at } : x))
      : [{ path, title, folder: folderOf(path), mtimeMs: at, questions: 0, openedAt: at }, ...l.entries]
    return { ...l, entries }
  })
}

const threadFile = (id: string) => (dataDir ? `${dataDir}/thread-${id}.json` : null)

function validTurns(raw: unknown): Turn[] {
  const turns = (raw as { turns?: unknown })?.turns
  return Array.isArray(turns) ? (turns as Turn[]).filter(x => x && typeof x.question === 'string' && (x.answer || x.error)) : []
}

async function loadThread($: $, id: string): Promise<{ turns: Turn[]; mtime?: number }> {
  await env($)
  const f = threadFile(id)
  if (!f) return { turns: [] }
  try {
    if (!(await $.fs.exists(f))) return { turns: [] }
    const mtime = (await $.fs.stat(f)).mtimeMs
    return { turns: validTurns(JSON.parse(await $.fs.read(f))), mtime }
  } catch {
    return { turns: [] }
  }
}

async function saveThread($: $, c: DocChat) {
  await env($)
  const f = threadFile(c.id)
  if (!f || !dataDir) return
  const turns = c.turns.filter(t => t.answer || t.error).slice(-200)
  await $.fs.write(f, JSON.stringify({ path: c.path, title: c.title, turns }, null, 1))
  const index = await readIndex($)
  if (turns.length === 0) delete index[c.id]
  else index[c.id] = { path: c.path, title: c.title, questions: turns.length, lastAskedAt: turns.at(-1)?.at ?? 0 }
  await $.fs.write(`${dataDir}/index.json`, JSON.stringify(index))
  const mtime = (await $.fs.stat(f)).mtimeMs
  await patchChat($, c.id, x => ({ ...x, threadMtime: mtime }))
  if (c.path) {
    const p = c.path
    await update($, libraryAtom, l => ({ ...l, entries: l.entries.map(x => (x.path === p ? { ...x, questions: turns.length, lastAskedAt: turns.at(-1)?.at ?? 0 } : x)) }))
  }
}

/** A question asked about this doc in another session shows up here too. */
async function refreshThread($: $, c: DocChat) {
  const f = threadFile(c.id)
  if (!f || c.isBusy) return
  try {
    if (!(await $.fs.exists(f))) return
    const mtime = (await $.fs.stat(f)).mtimeMs
    if (mtime <= (c.threadMtime ?? 0)) return
    const t = await loadThread($, c.id)
    await patchChat($, c.id, x => (x.isBusy ? x : { ...x, turns: t.turns, ...(t.mtime ? { threadMtime: t.mtime } : {}) }))
  } catch {
    // the next look tries again
  }
}

// ---- Chats ----

async function getChat($: $, id: string): Promise<DocChat | undefined> {
  return (await read($, chatsAtom))[id]
}

async function patchChat($: $, id: string, f: (c: DocChat) => DocChat) {
  await update($, chatsAtom, all => {
    const c = all[id]
    return c ? { ...all, [id]: f(c) } : all
  })
}

function emptyChat(id: string, path: string | null): DocChat {
  return {
    id,
    path,
    title: path ? titleFromPath(path) : 'Text from this session',
    kind: path ? (kindOf(path) ?? 'text') : 'none',
    chars: 0,
    sections: 0,
    isTruncated: false,
    isLoading: false,
    turns: [],
    isBusy: false,
    section: 0,
  }
}

/** The chat for a doc (or for session text when `path` is null), its thread read from disk the first time. */
async function ensureChat($: $, path: string | null): Promise<string> {
  const id = path ? hashPath(path) : GENERAL
  if (!(await getChat($, id))) {
    const t = await loadThread($, id)
    await update($, chatsAtom, all => (all[id] ? all : { ...all, [id]: { ...emptyChat(id, path), turns: t.turns, ...(t.mtime ? { threadMtime: t.mtime } : {}) } }))
  }
  return id
}

/** The doc's text, read once and again only when the file changes. */
async function ensureDoc($: $, id: string): Promise<LoadedDoc | null> {
  const c = await getChat($, id)
  if (!c?.path) return null
  const path = c.path
  const had = docs.get(id)
  if (had) {
    try {
      if ((await $.fs.stat(path)).mtimeMs === had.mtimeMs) return had
    } catch {
      return had
    }
  }
  const running = loading.get(id)
  if (running) return running
  const job = (async () => {
    await patchChat($, id, ({ loadError: _, ...x }) => ({ ...x, isLoading: true }))
    try {
      const doc = await loadDoc($, path)
      docs.set(id, doc)
      await patchChat($, id, x => ({
        ...x,
        isLoading: false,
        title: doc.title,
        kind: doc.kind,
        chars: doc.text.length,
        sections: doc.sections.length,
        ...(doc.pages ? { pages: doc.pages } : {}),
        isTruncated: doc.isTruncated,
        section: Math.min(x.section, Math.max(0, doc.sections.length - 1)),
      }))
      return doc
    } catch (err) {
      await patchChat($, id, x => ({ ...x, isLoading: false, loadError: message(err) }))
      return null
    } finally {
      loading.delete(id)
    }
  })()
  loading.set(id, job)
  return job
}

// ---- The widget ----

async function currentChat($: $): Promise<DocChat | undefined> {
  const w = await read($, widgetAtom)
  return w.docId ? getChat($, w.docId) : undefined
}

/** Opens the pane (or shows it again); `asWidget` asks the desktop app for its small corner form. */
async function openWidget($: $, opts: { asWidget?: boolean; focus?: boolean } = {}) {
  await update($, widgetAtom, w => (w.isClosed ? { ...w, isClosed: false } : w))
  const opened = await $.ui.open({ id: PANE, title: 'Doc chat', ...(opts.asWidget ? { placement: 'widget' as const } : {}), ...(opts.focus ? { focus: true as const } : {}) })
  startLooking($)
  return opened
}

/** Shows a doc in the widget, or session text when `path` is null. */
async function showDoc($: $, path: string | null, view?: Widget['view']) {
  const id = await ensureChat($, path)
  await update($, widgetAtom, ({ quote, pick, ...w }) => ({
    ...w,
    ...(quote && w.docId === id ? { quote } : {}),
    ...(pick && w.docId === id ? { pick } : {}),
    docId: id,
    view: view ?? (path ? 'read' : 'chat'),
    isPicking: false,
    isClearArmed: false,
    showAll: false,
    showLatest: w.docId === id ? w.showLatest : false,
  }))
  const opened = await openWidget($)
  if (path) {
    void ensureDoc($, id)
    const title = (await getChat($, id))?.title ?? titleFromPath(path)
    void touchRecent($, path, title).catch(() => undefined)
  }
  return { id, opened }
}

async function adopt($: $, q: Quote) {
  await update($, widgetAtom, ({ pick: _, ...w }) => (w.quote?.text === q.text ? w : { ...w, quote: q }))
}

/**
 * A click on a sentence in the reader: the first picks it, a second extends the
 * passage to the sentence clicked, and the next click starts a new passage.
 */
async function pickUnit($: $, href: string) {
  const i = Number(href.startsWith(UNIT_URL) ? href.slice(UNIT_URL.length) : NaN)
  if (!Number.isInteger(i) || i < 0) return
  const c = await currentChat($)
  const doc = c ? docs.get(c.id) : undefined
  if (!c || !doc) return
  const k = Math.min(c.section, Math.max(0, doc.sections.length - 1))
  const { units } = clickablePage(doc.sections[k]?.text ?? '')
  if (!units[i]) return
  const w = await read($, widgetAtom)
  const was = w.pick
  const isExtending = !!was && was.isOpen && was.docId === c.id && was.section === k && was.from !== i
  const from = isExtending && was ? Math.min(was.from, i) : i
  const to = isExtending && was ? Math.max(was.from, i) : i
  const quote: Quote = { text: joinUnits(units, from, to).slice(0, MAX_QUOTE_CHARS), from: 'pick' }
  await update($, widgetAtom, x => ({ ...x, quote, pick: { docId: c.id, section: k, from, to, isOpen: !isExtending } }))
}

/** Whether a selection belongs to the doc on show: in its text, or in this chat's answers. Session text takes any. */
function fits(text: string, c: DocChat | undefined, doc: LoadedDoc | undefined): boolean {
  if (!c || text.length < 3) return false
  if (!c.path) return true
  if (doc && isInDoc(text, doc)) return true
  const answers = c.turns.map(t => t.answer ?? '').join('\n')
  return answers ? isInText(text, answers) : false
}

function startLooking($: $) {
  if (looker) return
  looker = $.clock.every(LOOK_MS, async () => {
    if (isLooking) return
    isLooking = true
    try {
      await look($)
    } catch {
      // the next look tries again
    } finally {
      isLooking = false
    }
  })
}

/** While the widget is open: a new selection or copied passage becomes the one to ask about. */
async function look($: $) {
  looks++
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (!pane) {
    looker?.cancel()
    looker = undefined
    return
  }
  // No check of `isShown` or `isPlaced`: the desktop app draws the pane while it reports neither.
  const c = await currentChat($)
  const doc = c?.path ? (docs.get(c.id) ?? (looks % 5 === 1 ? ((await ensureDoc($, c.id)) ?? undefined) : undefined)) : undefined

  const sel = (await selectionText($)) ?? ''
  if (seenSel === undefined) seenSel = sel
  else if (sel && sel !== seenSel) {
    seenSel = sel
    if (fits(sel, c, doc)) await adopt($, { text: sel, from: 'selection' })
  }

  if (cfg.watchClipboard && doc && looks % 3 === 0) {
    const clip = (await clipboard($)) ?? ''
    if (seenClip === undefined) seenClip = clip
    else if (clip && clip !== seenClip) {
      seenClip = clip
      if (isInDoc(clip, doc)) await adopt($, { text: clip, from: 'clipboard' })
    }
  }

  if (c && looks % 4 === 0) await refreshThread($, c)
}

// ---- Quotes ----

async function clipboard($: $): Promise<string | undefined> {
  try {
    const r = await $.process.run(['pbpaste'], { timeoutMs: 3000 })
    const t = r.stdout.trim()
    return t ? t.slice(0, MAX_QUOTE_CHARS) : undefined
  } catch {
    return undefined
  }
}

async function selectionText($: $): Promise<string | undefined> {
  try {
    const t = (await $.ui.selection())?.text?.trim()
    return t ? t.slice(0, MAX_QUOTE_CHARS) : undefined
  } catch {
    return undefined
  }
}

/** For a quick button: the passage held, else what is selected, else a passage copied from the doc. */
async function grabQuote($: $, c: DocChat): Promise<Quote | undefined> {
  const w = await read($, widgetAtom)
  if (w.quote && w.docId === c.id) return w.quote
  const doc = c.path ? ((await ensureDoc($, c.id)) ?? undefined) : undefined
  const sel = await selectionText($)
  if (sel && fits(sel, c, doc)) return { text: sel, from: 'selection' }
  const clip = await clipboard($)
  if (clip && doc && isInDoc(clip, doc)) return { text: clip, from: 'clipboard' }
  return sel ? { text: sel, from: 'selection' } : undefined
}

// ---- Asking ----

async function ask($: $, id: string, kind: AskKind, question: string, opts: { quote?: string; fromWidget?: boolean } = {}): Promise<Turn | undefined> {
  const c = await getChat($, id)
  if (!c) return undefined
  if (c.isBusy) {
    await $.ui.toast(`Doc chat is still answering the last question.`)
    return undefined
  }
  const quote = opts.quote
  const now = await $.clock.now()
  const turn: Turn = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: now, kind, question, ...(quote ? { quote } : {}) }
  await patchChat($, id, x => ({ ...x, turns: [...x.turns, turn], isBusy: true }))
  await update($, widgetAtom, ({ quote: held, pick, ...w }) => ({
    ...w,
    ...(held && !opts.fromWidget ? { quote: held } : {}),
    ...(pick && !opts.fromWidget ? { pick } : {}),
    askSeq: opts.fromWidget ? w.askSeq + 1 : w.askSeq,
    showLatest: w.docId === id ? true : w.showLatest,
    isClearArmed: false,
    isPicking: false,
  }))
  let result: Partial<Turn>
  const doc = c.path ? await ensureDoc($, id) : null
  if (c.path && !doc) {
    result = { error: `Could not read the doc: ${(await getChat($, id))?.loadError ?? 'unknown error'}` }
  } else {
    const stop = new AbortController()
    stoppers.set(id, stop)
    try {
      const r = await $.model.complete(
        {
          model: cfg.model,
          system: systemPrompt(cfg.background),
          prompt: buildPrompt(doc, c.turns, { question, ...(quote ? { quote } : {}) }),
          maxTokens: 4096,
          effort: cfg.effort,
          timeoutMs: 300_000,
        },
        { signal: stop.signal },
      )
      if (r.isAnswered) {
        const u = r.usage
        result = {
          answer: r.text.trim(),
          model: cfg.model,
          tokensIn: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
          tokensCached: u.cache_read_input_tokens,
          tokensOut: u.output_tokens,
        }
      } else if (r.reason === 'aborted') result = { error: 'Stopped.' }
      else if (r.reason === 'api-error') {
        const f = r as { status?: number; error?: string }
        result = { error: `The API refused the request${f.status ? ` (${f.status}${f.error ? `: ${f.error}` : ''})` : ''}.` }
      } else result = { error: 'The model sent back no text.' }
    } catch (err) {
      result = { error: message(err) }
    } finally {
      stoppers.delete(id)
    }
  }
  const done: Turn = { ...turn, ...result }
  await patchChat($, id, x => ({ ...x, isBusy: false, turns: x.turns.map(t => (t.id === turn.id ? done : t)) }))
  const after = await getChat($, id)
  if (after) await saveThread($, after)
  return done
}

async function askQuick($: $, id: string, kind: QuickKind) {
  const c = await getChat($, id)
  if (!c) return
  const q = await grabQuote($, c)
  if (!q) {
    await $.ui.toast(c.path ? 'Select a passage in the doc text, or copy one from the open file, then press the button again.' : 'Select some text first.')
    return
  }
  await ask($, id, kind, KIND_QUESTION[kind], { quote: q.text, fromWidget: true })
}

async function askTyped($: $, id: string, text: string) {
  const question = text.trim()
  if (!question) return
  const w = await read($, widgetAtom)
  const quote = w.quote && w.docId === id ? w.quote.text : undefined
  await ask($, id, 'ask', question, { ...(quote ? { quote } : {}), fromWidget: true })
}

// ---- Library ----

async function rescan($: $) {
  if (isScanning) return
  isScanning = true
  await update($, libraryAtom, l => ({ ...l, isScanning: true }))
  try {
    await env($)
    const roots = (cfg.folders.length ? cfg.folders.map(f => resolvePath(f, cwd, home) ?? '') : [cwd]).filter(Boolean)
    const found = await scanDocs($, roots)
    const index = await readIndex($)
    const recent = await readRecent($)
    const rows = new Map(Object.values(index).flatMap(r => (r.path ? [[r.path, r] as const] : [])))
    const opened = new Map(recent.map(r => [r.path, r] as const))
    const seen = new Set(found.map(f => f.path))
    for (const p of [...rows.keys(), ...opened.keys()]) {
      if (!seen.has(p)) {
        seen.add(p)
        found.push({ path: p, mtimeMs: 0 })
      }
    }
    const entries: LibraryEntry[] = found.map(f => {
      const r = rows.get(f.path)
      const o = opened.get(f.path)
      const entry: LibraryEntry = { path: f.path, title: r?.title || o?.title || titleFromPath(f.path), folder: folderOf(f.path), mtimeMs: f.mtimeMs, questions: r?.questions ?? 0 }
      if (r) entry.lastAskedAt = r.lastAskedAt
      if (o) entry.openedAt = o.at
      return entry
    })
    const now = await $.clock.now()
    await update($, libraryAtom, l => ({ ...l, entries, isScanning: false, scannedAt: now }))
  } catch {
    await update($, libraryAtom, l => ({ ...l, isScanning: false }))
  } finally {
    isScanning = false
  }
}

const lastUsed = (x: LibraryEntry) => Math.max(x.openedAt ?? 0, x.lastAskedAt ?? 0)

function ranked(lib: LibraryState, filter: string): LibraryEntry[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...lib.entries].sort((a, b) => lastUsed(b) - lastUsed(a) || b.mtimeMs - a.mtimeMs)
  return lib.entries
    .map(entry => ({ entry, score: matchScore(words, entry.title, entry.path) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || lastUsed(b.entry) - lastUsed(a.entry) || b.entry.mtimeMs - a.entry.mtimeMs)
    .map(x => x.entry)
}

/** The doc picker's list: the doc on show, then the docs used most recently in any session, then the newest. */
function docOptions(lib: LibraryState, c: DocChat | undefined): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  const seen = new Set<string>()
  const push = (path: string, title: string) => {
    if (seen.has(path) || out.length >= 15) return
    seen.add(path)
    out.push({ value: path, label: shortTitle(title, 60) })
  }
  if (c?.path) push(c.path, c.title)
  for (const x of ranked(lib, '')) push(x.path, x.title)
  out.push({ value: SESSION_TEXT, label: 'Text from this session (no doc)' })
  out.push({ value: FIND, label: 'Find another doc…' })
  return out
}

async function openFinder($: $, filter = '') {
  await update($, widgetAtom, w => ({ ...w, isPicking: true, filter, findSeq: w.findSeq + 1 }))
  await openWidget($, { focus: true })
  const lib = await read($, libraryAtom)
  if (!lib.scannedAt || (await $.clock.now()) - lib.scannedAt > 60_000) void rescan($)
}

/** Whether the pane is already up (a reload keeps it), so a session start leaves it as it is. */
async function isPaneUp($: $): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return false
  }
}

/** At a session start: pick the doc used last in any session and show the widget in its corner. */
async function boot($: $) {
  const w = await read($, widgetAtom)
  if (w.docId && !(await getChat($, w.docId))) await update($, widgetAtom, x => ({ ...x, docId: null }))
  if (!(await read($, widgetAtom)).docId) {
    let path: string | undefined
    for (const r of (await readRecent($)).slice(0, 5)) {
      if (await $.fs.exists(r.path)) {
        path = r.path
        break
      }
    }
    if (!path) {
      const last = Object.values(await readIndex($))
        .filter(r => r.path)
        .sort((a, b) => b.lastAskedAt - a.lastAskedAt)[0]
      if (last?.path && (await $.fs.exists(last.path))) path = last.path
    }
    if (path) {
      const id = await ensureChat($, path)
      await update($, widgetAtom, x => (x.docId ? x : { ...x, docId: id }))
    }
  }
  if (await isPaneUp($)) startLooking($)
  else if (cfg.autoOpen && !(await read($, widgetAtom)).isClosed) await openWidget($, { asWidget: true })
}

/** Docs the person is sent or that land in a docs folder join the recent list in every session. */
const DOC_FOLDER = /\/(docs?|learning|reports?|notes|papers)\//i

function recordDoc($: $, raw: string, isSent: boolean) {
  const path = resolvePath(raw, cwd, home)
  if (!path) return
  const kind = kindOf(path)
  if (!kind || kind === 'text') return
  if (!isSent && kind !== 'pdf' && !DOC_FOLDER.test(path)) return
  void touchRecent($, path, titleFromPath(path)).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const str = (k: string, d: string) => (typeof options[k] === 'string' && (options[k] as string).trim() ? (options[k] as string).trim() : d)
  const bool = (k: string, d: boolean) => (typeof options[k] === 'boolean' ? (options[k] as boolean) : d)
  cfg.model = str('model', 'claude-sonnet-5-5')
  const effort = str('effort', 'medium')
  cfg.effort = effort === 'low' || effort === 'high' ? effort : 'medium'
  cfg.background = str('background', DEFAULT_BACKGROUND)
  cfg.folders = str('folders', '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  cfg.autoOpen = bool('autoOpen', true)
  cfg.watchClipboard = bool('watchClipboard', true)
  dataDir = undefined
  docs.clear()
  loading.clear()
  looker = undefined
  looks = 0
  isLooking = false
  seenSel = undefined
  seenClip = undefined
  isScanning = false

  on('session.start', async ($, e, next) => {
    cwd = (e.cwd ?? '').replace(/\/+$/, '')
    await $.command.register({ name: 'doc', description: 'Open Doc chat: read a doc (PDF, HTML or Markdown) and ask Sonnet about it. Give its path or a few words of its name', argumentHint: '[doc]' })
    await $.command.register({ name: 'doc-ask', description: 'Ask Doc chat a question about the doc on show, and the passage you selected', argumentHint: '<question>' })
    await $.tool.register({
      name: TOOL,
      description:
        "Open a doc (PDF, HTML, Markdown or text file) in the person's Doc chat widget beside the conversation, where they read it, select passages and ask Sonnet about them. Use it when the person asks to open, read, study or chat about a doc. With `question`, also asks that question there and returns a short preview of the answer; the full answer stays in the widget.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "The doc's path, absolute or relative to the session's folder" },
          question: { type: 'string', description: 'A question to ask about the doc in the widget' },
        },
        required: ['path'],
      },
    })
    await env($)
    try {
      await boot($)
    } catch {
      // the widget still opens with /doc
    }
    return next(e)
  })

  on('command.run', { command: 'doc' }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) {
      const c = await currentChat($)
      if (c) {
        await openWidget($, { focus: true })
        return { text: `Doc chat is open on ${c.title}.` }
      }
      await openFinder($)
      return { text: 'Pick a doc in Doc chat.' }
    }
    await env($)
    const path = resolvePath(arg, cwd, home)
    if (path && kindOf(path) && (await $.fs.exists(path))) {
      await showDoc($, path)
      return { text: `Doc chat opened ${baseName(path)}.` }
    }
    if (!(await read($, libraryAtom)).scannedAt) await rescan($)
    const words = arg.toLowerCase().split(/\s+/)
    const hits = ranked(await read($, libraryAtom), arg)
    const top = hits[0]
    const second = hits[1]
    if (top && (!second || matchScore(words, top.title, top.path) > matchScore(words, second.title, second.path))) {
      await showDoc($, top.path)
      return { text: `Doc chat opened ${top.title}.` }
    }
    await openFinder($, arg)
    return { text: hits.length ? `${hits.length} docs match "${arg}": pick one in Doc chat.` : `No doc matches "${arg}". Try its path, or pick one in Doc chat.` }
  })

  on('command.run', { command: 'doc-ask' }, async ($, e) => {
    const c = await currentChat($)
    const id = c ? c.id : (await showDoc($, null)).id
    await openWidget($)
    if (!e.args.trim()) return { text: 'Doc chat is open: type your question there.' }
    void askTyped($, id, e.args)
    return { text: `Asking ${modelName(cfg.model)} in Doc chat.` }
  })

  on('tool.run', { tool: `mcp__doc-chat__${TOOL}` }, async ($, e) => {
    // The tool's arguments arrive spread beside the envelope.
    const a = e as { path?: unknown; question?: unknown }
    const raw = typeof a.path === 'string' ? a.path.trim() : ''
    const question = typeof a.question === 'string' ? a.question.trim() : ''
    await env($)
    const path = raw ? resolvePath(raw, cwd, home) : undefined
    if (!path || !kindOf(path)) return { result: `Doc chat reads PDF, HTML, Markdown and text files; "${raw}" is not one.` }
    if (!(await $.fs.exists(path))) return { result: `There is no file at ${path}.` }
    const { id, opened } = await showDoc($, path)
    const doc = await ensureDoc($, id)
    const c = await getChat($, id)
    const lines = [
      opened.isPlaced ? `Doc chat shows ${c?.title ?? baseName(path)}.` : `Doc chat has ${c?.title ?? baseName(path)} open but not on screen yet (${opened.reason}).`,
      doc
        ? `Read ${doc.kind.toUpperCase()}: ${doc.pages ? `${doc.pages} pages, ` : ''}${doc.sections.length} sections, ${doc.text.length} characters${doc.isTruncated ? ' (cut to fit)' : ''}.`
        : `Could not read it: ${c?.loadError ?? 'unknown error'}.`,
    ]
    if (question && doc) {
      const t = await ask($, id, 'ask', question)
      if (t?.answer) {
        lines.push(`${modelName(t.model ?? cfg.model)} answered in the widget (${t.tokensIn ?? 0} tokens in, ${t.tokensCached ?? 0} cached, ${t.tokensOut ?? 0} out). It begins: ${oneLine(t.answer, 500)}`)
      } else lines.push(`No answer: ${t?.error ?? 'the widget was busy'}`)
    }
    return { result: lines.join('\n') }
  })

  // Docs sent to the person or written into a docs folder become recent docs everywhere.
  on('tool.call', { tool: 'SendUserFile' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      if (ran.deny === undefined && !ran.isError) for (const f of e.files ?? []) recordDoc($, f, true)
    } catch {
      // recording a recent doc never affects the call
    }
    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      if (ran.deny === undefined && !ran.isError) recordDoc($, e.file_path, false)
    } catch {
      // recording a recent doc never affects the call
    }
    return ran
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      try {
        if (e.origin.kind === 'person') await update($, widgetAtom, w => ({ ...w, isClosed: true, isBandHidden: false }))
        looker?.cancel()
        looker = undefined
      } catch {
        // closing goes ahead whatever happened to the widget's state
      }
    }
    return next(e)
  })

  // One line above the prompt while the widget is closed, to bring it back.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const w = await read($, widgetAtom)
    if (!w.isClosed || w.isBandHidden || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const c = w.docId ? (await read($, chatsAtom))[w.docId] : undefined
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text dimColor>Doc chat{c ? ` · ${shortTitle(c.title)}` : ''}</Text>
        <Button key="dc-open" plain onPress={() => void openWidget($, { focus: true })}>
          Open
        </Button>
        <Button key="dc-hide" plain onPress={() => void update($, widgetAtom, x => ({ ...x, isBandHidden: true }))}>
          Hide
        </Button>
      </Box>
    )
  })

  // Right-click on selected text (in the chat or in Doc chat's own reader) or on a doc link (the desktop app).
  on('ui.render', { component: 'ContextMenu' }, async ($, e, next) => {
    const sel = e.props.selection?.text?.trim().slice(0, MAX_QUOTE_CHARS)
    const href = e.props.link?.href
    const linked = href ? resolvePath(href, cwd, home) : undefined
    const docLink = linked && kindOf(linked) ? linked : undefined
    if (!sel && !docLink) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const c = await currentChat($)
    const where = c ? `About ${shortTitle(c.title, 32)}` : 'In Doc chat'
    const target = async () => (c ? c.id : (await showDoc($, null)).id)
    const askIt = (kind: QuickKind) => async () => {
      const id = await target()
      await openWidget($)
      if (sel) await ask($, id, kind, KIND_QUESTION[kind], { quote: sel })
    }
    const hold = async () => {
      const id = await target()
      const quote: Quote | undefined = sel ? { text: sel, from: 'menu' } : undefined
      if (quote) await update($, widgetAtom, w => ({ ...w, docId: id, quote, askSeq: w.askSeq + 1, isPicking: false }))
      await openWidget($, { focus: true })
    }
    return (
      <Box flexDirection="column">
        {docLink && (
          <Button key="chat-doc" onPress={() => void showDoc($, docLink)}>
            Open in Doc chat <Text dimColor>{baseName(docLink)}</Text>
          </Button>
        )}
        {sel && (
          <Button key="ask-what" onPress={askIt('explain')}>
            Doc chat: what is this? <Text dimColor>{where}</Text>
          </Button>
        )}
        {sel && (
          <Button key="ask-why" onPress={askIt('why')}>
            Doc chat: why? <Text dimColor>{where}</Text>
          </Button>
        )}
        {sel && (
          <Button key="ask-how" onPress={askIt('how')}>
            Doc chat: how does it work? <Text dimColor>{where}</Text>
          </Button>
        )}
        {sel && (
          <Button key="ask-own" onPress={hold}>
            Doc chat: ask my own question… <Text dimColor>Quotes it in Doc chat</Text>
          </Button>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown, Progress, Select } = $.ui.resolve(e)
    const w = await read($, widgetAtom)
    const chats = await read($, chatsAtom)
    const c = w.docId ? chats[w.docId] : undefined
    const lib = await read($, libraryAtom)
    const model = modelName(cfg.model)
    // A reload keeps the pane up but starts the module over. Drawing writes no state, so loads start just after it.
    startLooking($)
    const needsDoc = !!c?.path && e.props.placement !== 'widget' && !docs.has(c.id) && !c.isLoading && !c.loadError && !loading.has(c.id)
    if (needsDoc || (!lib.scannedAt && !lib.isScanning && !isScanning)) {
      $.clock.after(1, () => {
        if (needsDoc && c) void ensureDoc($, c.id)
        if (!lib.scannedAt) void rescan($)
      })
    }
    const latest = c?.turns.at(-1)

    // The small form in the corner: what reads at a glance, since clicks may not reach it.
    if (e.props.placement === 'widget') {
      const line = !c
        ? `Open to pick a doc and ask ${model} about it`
        : c.isBusy
          ? `${model} is answering…`
          : w.quote
            ? `${SOURCE_LABEL[w.quote.from]}: “${oneLine(w.quote.text, 90)}”. Open to ask`
            : latest?.answer
              ? `Latest: ${oneLine(latest.answer, 110)}`
              : c.path
                ? `Open to read it and ask ${model} about any passage`
                : `Open to ask ${model} about text you select`
      return (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            Doc chat{c ? ` · ${shortTitle(c.title, 48)}` : ''}
          </Text>
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        </Box>
      )
    }

    const doc = c ? docs.get(c.id) : undefined
    const setW = (f: (x: Widget) => Widget) => void update($, widgetAtom, f)
    const setC = (f: (x: DocChat) => DocChat) => {
      if (c) void patchChat($, c.id, f)
    }

    const picker = (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Select
          key="doc"
          label="Doc"
          value={c?.path ?? (c ? SESSION_TEXT : FIND)}
          options={docOptions(lib, c)}
          onSelect={v => {
            if (v === FIND) void openFinder($)
            else if (v === SESSION_TEXT) void showDoc($, null)
            else void showDoc($, v)
          }}
        />
        {c?.path && (
          <Button key="open-file" plain onPress={() => void $.process.run(['open', c.path ?? ''], { timeoutMs: 10_000 })}>
            Open file
          </Button>
        )}
      </Box>
    )

    if (w.isPicking || !c) {
      const list = ranked(lib, w.filter).slice(0, 25)
      const now = await $.clock.now()
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Pick a doc to read and ask {model} about</Text>
          <Input
            key={`find-${w.findSeq}`}
            placeholder="Type a few words of its name, or a path…"
            submitLabel="Open"
            autoFocus
            value={w.filter}
            onInput={v => setW(x => ({ ...x, filter: v }))}
            onSubmit={async v => {
              const path = resolvePath(v.trim(), cwd, home)
              if (path && kindOf(path) && (await $.fs.exists(path))) return void showDoc($, path)
              const top = ranked(await read($, libraryAtom), v)[0]
              if (top) await showDoc($, top.path)
            }}
          />
          <Box flexDirection="column">
            {list.length === 0 && <Text dimColor>{lib.isScanning ? 'Looking for docs…' : 'No docs found.'}</Text>}
            {list.map(x => (
              <Button key={`pick-${hashPath(x.path)}`} plain onPress={() => void showDoc($, x.path)}>
                {x.title}{' '}
                <Text dimColor>
                  {[x.folder, lastUsed(x) ? `used ${ago(lastUsed(x), now)}` : x.mtimeMs ? ago(x.mtimeMs, now) : '', x.questions ? `${x.questions} question${x.questions === 1 ? '' : 's'}` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </Button>
            ))}
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center">
            {c && (
              <Button key="pick-cancel" plain onPress={() => setW(x => ({ ...x, isPicking: false }))}>
                Back to {shortTitle(c.title, 30)}
              </Button>
            )}
            <Button key="pick-session" plain onPress={() => void showDoc($, null)}>
              Text from this session
            </Button>
            <Button key="rescan" plain onPress={() => void rescan($)}>
              Rescan
            </Button>
            <Text dimColor>{lib.isScanning ? 'Looking…' : `${lib.entries.length} docs`}</Text>
          </Box>
        </Box>
      )
    }

    const meta = [
      c.kind === 'none' ? '' : c.kind.toUpperCase(),
      c.pages ? `${c.pages} pages` : c.sections > 1 ? `${c.sections} sections` : '',
      c.chars ? `${Math.max(1, Math.round(c.chars / 1000))}k characters` : '',
      c.isTruncated ? 'only the first part fits' : '',
    ]
      .filter(Boolean)
      .join(' · ')

    const tabs = (
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        {c.path && (
          <Button key="view-read" variant={w.view === 'read' ? 'primary' : 'secondary'} onPress={() => setW(x => ({ ...x, view: 'read' }))}>
            Read
          </Button>
        )}
        <Button key="view-chat" variant={w.view === 'chat' || !c.path ? 'primary' : 'secondary'} onPress={() => setW(x => ({ ...x, view: 'chat' }))}>
          {c.turns.length ? `Chat (${c.turns.length})` : 'Chat'}
        </Button>
        {c.turns.length > 0 && !c.isBusy && (w.view === 'chat' || !c.path) && (
          <Button
            key="clear"
            plain
            onPress={async () => {
              if (!w.isClearArmed) return setW(x => ({ ...x, isClearArmed: true }))
              await patchChat($, c.id, x => ({ ...x, turns: [] }))
              await update($, widgetAtom, x => ({ ...x, isClearArmed: false, showAll: false, showLatest: false }))
              const cleared = await getChat($, c.id)
              if (cleared) await saveThread($, cleared)
            }}
          >
            {w.isClearArmed ? 'Press again to clear this chat' : 'Clear chat'}
          </Button>
        )}
        <Text dimColor wrap="truncate-middle">
          {c.path ? `${shortPath(c.path)}${meta ? ` · ${meta}` : ''}` : 'Questions about text you select in this session'}
        </Text>
      </Box>
    )

    const status = (
      <Box flexDirection="column">
        {c.isLoading && <Progress label="Reading the doc" />}
        {c.loadError && <Text color="error">Could not read the doc: {c.loadError}</Text>}
      </Box>
    )

    const composer = (
      <Box flexDirection="column" gap={1}>
        {w.quote ? (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text wrap="truncate-end">
              <Text bold>{SOURCE_LABEL[w.quote.from]}:</Text> <Text dimColor>“{oneLine(w.quote.text, 220)}”</Text>
            </Text>
            <Button key="unquote" plain onPress={() => setW(({ quote: _, pick: __, ...x }) => x)}>
              Clear
            </Button>
          </Box>
        ) : (
          <Text dimColor>
            {c.path
              ? 'Click a sentence in the text below to quote it, and a second one to quote everything from the first to it. Or copy (⌘C) a passage from the open file. Then press a question or type your own.'
              : 'Select text in the conversation and it shows up here, or right-click it and pick a Doc chat question.'}
          </Text>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {QUICK.map(k => (
            <Button key={`q-${k}`} variant={w.quote ? 'primary' : 'secondary'} onPress={() => void askQuick($, c.id, k)}>
              {KIND_LABEL[k]}
            </Button>
          ))}
          {c.isBusy && (
            <Button key="stop" plain onPress={() => stoppers.get(c.id)?.abort()}>
              Stop
            </Button>
          )}
        </Box>
        <Input
          key={`ask-${w.askSeq}`}
          placeholder={w.quote ? 'Ask about this passage…' : c.path ? 'Ask anything about this doc…' : 'Ask about the text you selected…'}
          submitLabel="Ask"
          rows={2}
          {...(w.quote?.from === 'menu' ? { autoFocus: true as const } : {})}
          onSubmit={v => void askTyped($, c.id, v)}
        />
      </Box>
    )

    const card = (t: Turn) => (
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{t.kind === 'ask' ? t.question : KIND_LABEL[t.kind]}</Text>
        {t.quote && <Markdown dimColor text={`> ${oneLine(t.quote, 400)}`} />}
        {t.answer ? <Markdown text={t.answer} /> : t.error ? <Text color="error">{t.error}</Text> : <Progress label={`${model} is thinking`} />}
        {t.answer && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>
              {[
                modelName(t.model ?? cfg.model),
                t.tokensIn ? `${(t.tokensIn / 1000).toFixed(1)}k in${t.tokensCached ? ` (${(t.tokensCached / 1000).toFixed(1)}k cached)` : ''}` : '',
                t.tokensOut ? `${t.tokensOut} out` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <Button key={`copy-${t.id}`} plain onPress={press => void $.ui.copy({ text: t.answer ?? '', surface: press.surface })}>
              Copy
            </Button>
          </Box>
        )}
      </Box>
    )

    let body
    if (w.view === 'read' && c.path) {
      const sections = doc?.sections ?? []
      const k = Math.min(c.section, Math.max(0, sections.length - 1))
      const sec = sections[k]
      const isPages = c.kind === 'pdf' && !!c.pages && sections.length === c.pages
      const turnTo = (n: number) => {
        setC(x => ({ ...x, section: Math.max(0, Math.min(sections.length - 1, n)) }))
        setW(({ pick: _, ...x }) => x)
      }
      const pageText = sec ? (sec.text.length > PAGE_CHARS ? `${sec.text.slice(0, PAGE_CHARS)}\n\n…` : sec.text) : ''
      const pick = w.pick && w.pick.docId === c.id && w.pick.section === k ? w.pick : undefined
      const page = !w.isPlain && sec ? clickablePage(pageText, pick) : undefined
      body = (
        <Box flexDirection="column" gap={1}>
          {w.showLatest && latest && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {card(latest)}
              <Box flexDirection="row" gap={1}>
                <Button key="latest-hide" plain onPress={() => setW(x => ({ ...x, showLatest: false }))}>
                  Hide answer
                </Button>
                {c.turns.length > 1 && (
                  <Button key="latest-all" plain onPress={() => setW(x => ({ ...x, view: 'chat' }))}>
                    All {c.turns.length} questions
                  </Button>
                )}
              </Box>
            </Box>
          )}
          {sections.length > 1 && (
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Button key="prev" plain onPress={() => turnTo(k - 1)}>
                ‹ Prev
              </Button>
              <Select
                key="section"
                value={String(k)}
                options={sections.map((s, i) => ({ value: String(i), label: isPages ? `Page ${i + 1} of ${sections.length}` : `${i + 1}. ${oneLine(s.title, 60)}` }))}
                onSelect={v => turnTo(Number(v) || 0)}
              />
              <Button key="next" plain onPress={() => turnTo(k + 1)}>
                Next ›
              </Button>
            </Box>
          )}
          {sec && (
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Text dimColor>
                {w.isPlain
                  ? 'Plain text: sentences are not clickable.'
                  : pick?.isOpen
                    ? 'Click another sentence to quote everything from the first to it, or ask now.'
                    : 'Click a sentence to quote it; click a second to quote the passage between.'}
              </Text>
              <Button key="plain-toggle" plain onPress={() => setW(x => ({ ...x, isPlain: !x.isPlain }))}>
                {w.isPlain ? 'Clickable sentences' : 'Plain text'}
              </Button>
            </Box>
          )}
          {page ? (
            <Markdown key="page" text={page.markdown} onLinkPress={link => void pickUnit($, link.href)} />
          ) : sec ? (
            <Markdown text={pageText} />
          ) : (
            <Text dimColor>{c.isLoading ? 'Reading…' : 'No text.'}</Text>
          )}
        </Box>
      )
    } else {
      const newest = [...c.turns].reverse()
      const shown = w.showAll ? newest.slice(0, 30) : newest.slice(0, 3)
      const hidden = c.turns.length - shown.length
      body = (
        <Box flexDirection="column" gap={1}>
          {c.turns.length === 0 && <Text dimColor>No questions yet. Answers show here, newest first, and are kept for every session.</Text>}
          {shown.map(card)}
          {c.turns.length > 3 && (
            <Button key="show-all" plain onPress={() => setW(x => ({ ...x, showAll: !x.showAll }))}>
              {w.showAll ? 'Show only the latest' : `Show ${hidden} earlier question${hidden === 1 ? '' : 's'}`}
            </Button>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {picker}
        {tabs}
        {status}
        {composer}
        {body}
      </Box>
    )
  })
}
