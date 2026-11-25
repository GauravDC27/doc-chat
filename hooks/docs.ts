import type { EngineInterface } from 'claude-code'

import type { DocKind } from '../types'

type $ = EngineInterface

export type Section = { title: string; text: string }

export type LoadedDoc = {
  path: string
  /** The file the text came from: a PDF's own Markdown source when it sits beside it. */
  source: string
  title: string
  kind: DocKind
  text: string
  sections: Section[]
  pages?: number
  mtimeMs: number
  isTruncated: boolean
}

/** About 100k tokens: room for a long paper, with the thread and answer beside it. */
export const MAX_DOC_CHARS = 400_000

const DOC_EXT = /\.(pdf|html?|md|markdown|txt)$/i

export function kindOf(path: string): DocKind | null {
  const m = DOC_EXT.exec(path)
  if (!m) return null
  const ext = (m[1] ?? '').toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown') return 'md'
  return 'text'
}

/** FNV-1a over the path: a short id that names the doc's pane and thread file. */
export function hashPath(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function normalizePath(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * A link's address or a typed path as an absolute file path: `file://` links,
 * percent-encoding, a `:line` suffix, `~/` and paths relative to the session's folder.
 * Undefined for a web address or anything else that names no file.
 */
export function resolvePath(raw: string, cwd: string, home: string): string | undefined {
  let p = raw.trim().replace(/^<(.*)>$/, '$1').replace(/^["'](.*)["']$/, '$1')
  if (p === '') return undefined
  if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\/(localhost)?/i, '')
  else if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return undefined
  p = p.replace(/[?#].*$/, '')
  try {
    p = decodeURIComponent(p)
  } catch {
    // keep it as written
  }
  p = p.replace(/:\d+(?::\d+)?$/, '')
  if (p === '~' || p.startsWith('~/')) {
    if (!home) return undefined
    p = home + p.slice(1)
  }
  if (!p.startsWith('/')) {
    if (!cwd) return undefined
    p = `${cwd}/${p}`
  }
  return normalizePath(p)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const GENERIC = /^(walkthrough|index|readme|report|main|notes?)$/i

/** A readable name from the path alone: a lesson's folder for `walkthrough.pdf`, else the file name. */
export function titleFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  let name = (parts.at(-1) ?? path).replace(/\.[^.]+$/, '')
  if (GENERIC.test(name) && parts.length > 1) name = parts.at(-2) ?? name
  name = name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/[_-]+/g, ' ').trim()
  return name.charAt(0).toUpperCase() + name.slice(1)
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓', rArr: '⇒', times: '×', divide: '÷', minus: '−',
  plusmn: '±', le: '≤', ge: '≥', ne: '≠', asymp: '≈', approx: '≈', sim: '∼', infin: '∞', deg: '°',
  middot: '·', bull: '•', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  sum: 'Σ', prod: '∏', radic: '√', part: '∂', nabla: '∇', isin: '∈', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ',
  omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', sup2: '²', sup3: '³', frac12: '½', copy: '©', thinsp: ' ',
  ensp: ' ', emsp: ' ', zwj: '', zwnj: '', shy: '',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all
    }
    return NAMED[code] ?? all
  })
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '')

const BLOCK = 'p|div|section|article|header|footer|tr|table|thead|tbody|ul|ol|figure|figcaption|blockquote|pre|aside|nav|main|dl|dt|dd|details|summary|caption'

/** A page's readable text: headings as `#`, list items as `-`, table cells split by `|`, figures by their labels. */
export function htmlToText(html: string): { title?: string; text: string } {
  const titleRaw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '')
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, svg => {
    const labels = [...svg.matchAll(/<(?:text|tspan|title)\b[^>]*>([^<]+)</gi)].map(m => decodeEntities((m[1] ?? '').trim())).filter(Boolean)
    const unique = [...new Set(labels)].slice(0, 60)
    return unique.length ? `\n[figure: ${unique.join(' · ')}]\n` : '\n[figure]\n'
  })
  s = s.replace(/<table\b[\s\S]*?<\/table>/gi, table => {
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(r => [...(r[1] ?? '').matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => decodeEntities(stripTags(c[1] ?? '')).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()))
      .filter(r => r.length > 0)
    const head = rows[0]
    if (!head) return '\n'
    const width = Math.max(...rows.map(r => r.length))
    const line = (r: string[]) => `| ${[...r, ...Array<string>(width - r.length).fill('')].join(' | ')} |`
    return `\n\n${[line(head), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')}\n\n`
  })
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${stripTags(t).replace(/\s+/g, ' ').trim()}\n\n`)
  s = s.replace(/<li\b[^>]*>/gi, '\n- ')
  s = s.replace(/<(td|th)\b[^>]*>/gi, ' | ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
  s = decodeEntities(stripTags(s))
  s = s
    .replace(/[ \t  ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const title = titleRaw ? decodeEntities(stripTags(titleRaw)).replace(/\s+/g, ' ').trim() : undefined
  return title ? { title, text: s } : { text: s }
}

/** A Markdown file's title: its front matter's `title`, else its first `#` heading. */
export function markdownTitle(md: string): string | undefined {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)
  const t = fm ? /^title:\s*(.+)$/m.exec(fm[1] ?? '')?.[1] : undefined
  if (t) return t.trim().replace(/^["']|["']$/g, '')
  return /^#\s+(.+)$/m.exec(md)?.[1]?.trim()
}

/** PDFKit through JavaScript for Automation: every Mac has it, so nothing needs installing. */
const PDF_SCRIPT = [
  'function run(argv) {',
  '  ObjC.import("PDFKit");',
  '  var d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));',
  '  if (!d || d.isNil()) return "";',
  '  var out = [];',
  '  for (var i = 0; i < d.pageCount; i++) {',
  '    var s = d.pageAtIndex(i).string;',
  '    out.push("[page " + (i + 1) + "]\\n" + (s && !s.isNil() ? s.js : ""));',
  '  }',
  '  return out.join("\\n\\n");',
  '}',
].join('\n')

export async function pdfText($: $, path: string): Promise<string> {
  const r = await $.process.run(['osascript', '-l', 'JavaScript', '-e', PDF_SCRIPT, path], { timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').at(-1) || `PDFKit could not read ${baseName(path)}`)
  const text = r.stdout.replace(/\r\n?/g, '\n').trim()
  if (!/\S/.test(text.replace(/\[page \d+\]/g, ''))) throw new Error(`${baseName(path)} has no text layer (a scanned PDF?)`)
  return text
}

/** One clickable piece of a page: a sentence, a heading or a table row, and the line it sits on. */
export type Unit = { text: string; line: number }

/** Where a clicked piece's link points; the surface opens none, the mod answers it. */
export const UNIT_URL = 'https://doc-chat.local/s/'

const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|\[page \d+\]$)/

const stripLinks = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')

/** The text a piece quotes: its words without link and emphasis marks. */
const plainOf = (s: string) => stripLinks(s).replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim()

/** Sentences of a line: a break after . ! ? … or the Devanagari danda, before what starts a new sentence. */
export function sentences(body: string): string[] {
  const parts = body
    .split(/(?<=[.!?…।])\s+(?=[\p{Lu}\p{N}\p{Script=Devanagari}"'“‘(\[*`])/u)
    .map(s => s.trim())
    .filter(Boolean)
  // A break after an abbreviation (Fig. 3, et al. 2023) is no sentence end.
  const out: string[] = []
  for (const p of parts) {
    const prev = out.at(-1)
    if (prev !== undefined && ABBREV.test(prev)) out[out.length - 1] = `${prev} ${p}`
    else out.push(p)
  }
  return out
}

const ABBREV = /(?:^|[\s(])(?:figs?|eqs?|secs?|tab|refs?|no|vs|al|cf|approx|dr|mr|ms|prof|e\.g|i\.e|etc)\.$/i

/**
 * A page's Markdown with every sentence (and heading and table row) made a link
 * the mod answers, so a click picks it: the pane draws text a person cannot select.
 * Lines wrapped inside a paragraph (a PDF's) are joined first; fenced code stays as it is.
 */
export function clickablePage(md: string, picked?: { from: number; to: number }): { markdown: string; units: Unit[] } {
  const merged: string[] = []
  let inFence = false
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const isFence = /^\s*(```|~~~)/.test(line)
    const prev = merged.at(-1)
    const joins = !inFence && !isFence && !!line.trim() && !STRUCTURAL.test(line) && prev !== undefined && !!prev.trim() && !/^\s*(#{1,6}\s|\||```|~~~|\[page \d+\]$)/.test(prev)
    if (joins) merged[merged.length - 1] = prev.endsWith('-') ? `${prev}${line.trim()}` : `${prev} ${line.trim()}`
    else merged.push(line)
    if (isFence) inFence = !inFence
  }
  const units: Unit[] = []
  const link = (label: string, plain: string, line: number) => {
    const i = units.push({ text: plain, line }) - 1
    const safe = stripLinks(label).replace(/([[\]])/g, '\\$1')
    const isPicked = picked !== undefined && i >= picked.from && i <= picked.to
    return `[${isPicked ? `**${safe.replace(/\*\*/g, '')}**` : safe}](${UNIT_URL}${i})`
  }
  const out: string[] = []
  inFence = false
  merged.forEach((line, li) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      return
    }
    if (inFence || !line.trim() || /^\[page \d+\]$/.test(line.trim())) {
      out.push(line)
      return
    }
    if (/^\s*\|/.test(line)) {
      if (/^[\s|:-]+$/.test(line)) {
        out.push(line)
        return
      }
      const cells = line.split('|')
      const k = cells.findIndex(c => c.trim())
      const plain = cells.map(c => plainOf(c)).filter(Boolean).join(' | ')
      if (k >= 0) cells[k] = ` ${link((cells[k] ?? '').trim(), plain, li)} `
      out.push(cells.join('|'))
      return
    }
    const m = /^(\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)*)(.*)$/.exec(line)
    const prefix = m?.[1] ?? ''
    const body = stripLinks(m?.[2] ?? line)
    if (!body.trim()) {
      out.push(line)
      return
    }
    const parts = /#/.test(prefix) ? [body.trim()] : sentences(body)
    out.push(prefix + parts.map(p => link(p, plainOf(p), li)).join(' '))
  })
  return { markdown: out.join('\n'), units }
}

/** The passage from one piece to another, a new line where the page had one. */
export function joinUnits(units: Unit[], from: number, to: number): string {
  let text = ''
  for (let i = from; i <= to; i++) {
    const u = units[i]
    if (!u) continue
    text += text ? `${units[i - 1]?.line === u.line ? ' ' : '\n'}${u.text}` : u.text
  }
  return text
}

/** Pieces small enough to select from in the pane: a PDF by page, anything else by heading. */
export function splitSections(text: string): Section[] {
  const out: Section[] = []
  if (/^\[page \d+\]$/m.test(text)) {
    for (const part of text.split(/^(?=\[page \d+\]$)/m)) {
      const m = /^\[page (\d+)\]\n?/.exec(part)
      if (!m) continue
      const body = part.slice(m[0].length).trim()
      if (body) out.push({ title: `Page ${m[1]}`, text: body })
    }
    return out
  }
  const parts = text.split(/^(?=#{1,3} )/m)
  let cur: Section | undefined
  for (const part of parts) {
    const heading = /^#{1,3} (.+)$/m.exec(part.split('\n')[0] ?? '')?.[1]?.trim()
    if (cur && cur.text.length < 1200) cur.text += `\n\n${part.trim()}`
    else {
      cur = { title: heading ?? (out.length === 0 ? 'Start' : `Part ${out.length + 1}`), text: part.trim() }
      out.push(cur)
    }
  }
  const sized: Section[] = []
  for (const s of out.filter(s => s.text)) {
    if (s.text.length <= 6000) {
      sized.push(s)
      continue
    }
    let buf = ''
    let n = 1
    for (const para of s.text.split(/\n{2,}/)) {
      if (buf && buf.length + para.length > 5000) {
        sized.push({ title: `${s.title} (${n++})`, text: buf })
        buf = ''
      }
      buf = buf ? `${buf}\n\n${para}` : para
    }
    if (buf) sized.push({ title: n > 1 ? `${s.title} (${n})` : s.title, text: buf })
  }
  return sized
}

export async function loadDoc($: $, path: string): Promise<LoadedDoc> {
  const kind = kindOf(path)
  if (!kind) throw new Error(`${baseName(path)} is not a PDF, HTML, Markdown or text file`)
  const st = await $.fs.stat(path)
  if (st.kind !== 'file') throw new Error(`${path} is not a file`)
  const sibling = path.replace(/\.[^./]+$/, '.md')
  const hasSource = (kind === 'pdf' || kind === 'html') && sibling !== path && (await $.fs.exists(sibling))
  let source = path
  let text: string
  let title: string | undefined
  let pages: number | undefined
  if (hasSource) {
    source = sibling
    text = await $.fs.read(sibling)
    title = markdownTitle(text)
  } else if (kind === 'pdf') {
    text = await pdfText($, path)
    pages = (text.match(/^\[page \d+\]$/gm) ?? []).length
  } else if (kind === 'html') {
    const h = htmlToText(await $.fs.read(path))
    text = h.text
    title = h.title
  } else {
    text = await $.fs.read(path)
    if (kind === 'md') title = markdownTitle(text)
  }
  const isTruncated = text.length > MAX_DOC_CHARS
  if (isTruncated) text = text.slice(0, MAX_DOC_CHARS)
  const doc: LoadedDoc = { path, source, title: title || titleFromPath(path), kind, text, sections: splitSections(text), mtimeMs: st.mtimeMs, isTruncated }
  if (pages !== undefined) doc.pages = pages
  return doc
}

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[­​-‍]/g, '')
    .replace(/-\n/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()

const normCache = new WeakMap<LoadedDoc, string>()

/**
 * Whether copied text came from this doc: most of its four-word runs appear in
 * the doc's text. Keeps a stale clipboard (a command, a key) from being sent.
 */
export function isInDoc(quote: string, doc: LoadedDoc): boolean {
  let hay = normCache.get(doc)
  if (hay === undefined) {
    hay = ` ${norm(doc.text)} `
    normCache.set(doc, hay)
  }
  return isInHay(quote, hay)
}

/** The same test against any text, such as the chat's own answers. */
export function isInText(quote: string, text: string): boolean {
  return isInHay(quote, ` ${norm(text)} `)
}

function isInHay(quote: string, hay: string): boolean {
  const words = norm(quote).split(' ').filter(Boolean)
  if (words.length === 0) return false
  if (words.length < 4) return words.join(' ').length >= 6 && hay.includes(` ${words.join(' ')} `)
  let hits = 0
  let total = 0
  for (let i = 0; i + 4 <= words.length; i += words.length > 120 ? 3 : 1) {
    total++
    if (hay.includes(words.slice(i, i + 4).join(' '))) hits++
  }
  return hits / total >= 0.6
}

const SKIP_DIRS = new Set([
  'node_modules', 'venv', 'env', '__pycache__', 'site-packages', 'dist', 'build', 'data', 'datasets', 'checkpoints',
  'ckpt', 'outputs', 'wandb', 'runs', 'logs', 'cache', 'tmp',
])

export type Found = { path: string; mtimeMs: number }

/**
 * Docs under the roots, newest first, at most four folders deep. Where a lesson's
 * PDF, HTML and Markdown sit together, the PDF stands for all three.
 */
export async function scanDocs($: $, roots: string[], limit = 200): Promise<Found[]> {
  const found = new Map<string, Found>()
  let visited = 0
  const queue: { dir: string; depth: number }[] = roots.map(dir => ({ dir: dir.replace(/\/+$/, ''), depth: 0 }))
  while (queue.length > 0 && visited < 6000) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number }
    let entries
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      visited++
      if (e.name.startsWith('.')) continue
      const path = `${dir}/${e.name}`
      if (e.kind === 'dir') {
        if (depth < 4 && !SKIP_DIRS.has(e.name.toLowerCase())) queue.push({ dir: path, depth: depth + 1 })
        continue
      }
      if (e.kind !== 'file' || e.size < 200 || !kindOf(e.name) || kindOf(e.name) === 'text') continue
      const stem = path.replace(/\.[^./]+$/, '')
      const rank = (p: string) => ({ pdf: 0, html: 1, md: 2, text: 3 })[kindOf(p) ?? 'text']
      const had = found.get(stem)
      if (!had || rank(path) < rank(had.path)) found.set(stem, { path, mtimeMs: Math.max(e.mtimeMs, had?.mtimeMs ?? 0) })
    }
  }
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

/** How well a doc matches typed words: every word must appear in its title or path. */
export function matchScore(words: string[], title: string, path: string): number {
  const t = title.toLowerCase()
  const p = path.toLowerCase()
  let score = 0
  for (const w of words) {
    if (t.includes(w)) score += 2
    else if (p.includes(w)) score += 1
    else return 0
  }
  return score
}
