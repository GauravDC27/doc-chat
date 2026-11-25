import { expect, mock, test } from 'claude-code/testing'

import { buildPrompt } from '../hooks/ask'
import { clickablePage, hashPath, htmlToText, isInDoc, isInText, joinUnits, resolvePath, sentences, splitSections, titleFromPath } from '../hooks/docs'
import type { LoadedDoc } from '../hooks/docs'

type On = Parameters<Parameters<typeof test>[1]>[1]
type File = { text: string; mtimeMs: number }

const T0 = 1_800_000_000_000
const enc = new TextEncoder()

const HTML = `<!doctype html><html><head><title>Audio Encoder Notes</title><style>body{color:red}</style><script>var x = 1</script></head>
<body><h1>Audio <em>Encoder</em> Notes</h1>
<p>The encoder turns 30 s of audio into 1500 frames &amp; a projector maps them to the LLM&rsquo;s width.</p>
<ul><li>CTC loss aligns frames to tokens</li><li>Whisper large-v3 encoder</li></ul>
<table><tr><th>Model</th><th>WER</th></tr><tr><td>E6</td><td>12.03</td></tr></table>
<svg viewBox="0 0 10 10"><text x="1" y="1">WER by test set</text></svg>
<h2>Why a projector</h2><p>The projector downsamples by 4&times; so the LLM sees 12.5 tokens per second of audio instead of 50.</p>
</body></html>`

const PDF_TEXT = '[page 1]\nThe CTC loss aligns audio frames to output tokens without frame labels.\n\n[page 2]\nSpecAugment masks bands of the spectrogram during training.'

type PaneRow = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

function setup(on: On, files: Map<string, File>) {
  const clock = mock.clock(on, { now: T0 })
  const calls: { model: string; system: string; prompt: string }[] = []
  const runs: string[][] = []
  const toasts: string[] = []
  const opens: Record<string, unknown>[] = []
  const panes: PaneRow[] = []
  const world = { selection: undefined as string | undefined, clipboard: '', reply: 'An answer.' }
  on('fs.read', (_, e) => {
    const f = files.get(e.path)
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: f.text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, { text: e.text, mtimeMs: T0 })
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.stat', (_, e) => {
    const f = files.get(e.path)
    if (f) return { value: { kind: 'file' as const, size: enc.encode(f.text).length, mtimeMs: f.mtimeMs, isLink: false } }
    if ([...files.keys()].some(k => k.startsWith(`${e.path}/`))) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', (_, e) => {
    const d = `${e.path.replace(/\/+$/, '')}/`
    const seen = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [k, f] of files) {
      if (!k.startsWith(d)) continue
      const rest = k.slice(d.length)
      const name = rest.split('/')[0] ?? ''
      if (rest.includes('/')) seen.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
      else seen.set(name, { name, kind: 'file', size: enc.encode(f.text).length, mtimeMs: f.mtimeMs, isLink: false })
    }
    return { value: [...seen.values()] }
  })
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data', HOME: '/Users/me' } }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    let stdout = ''
    if (argv[0] === 'osascript') stdout = PDF_TEXT
    if (argv[0] === 'pbpaste') stdout = world.clipboard
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', (_, e) => {
    calls.push({ model: e.model, system: String(e.system ?? ''), prompt: String(e.prompt) })
    return { value: { isAnswered: true as const, text: world.reply, usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } } }
  })
  on('ui.selection', () => ({ value: world.selection === undefined ? undefined : { text: world.selection } }))
  on('ui.panes', () => ({ value: panes.map(p => ({ ...p })) }))
  on('ui.open', (_, e) => {
    opens.push({ ...e })
    if (!panes.some(p => p.id === e.id)) panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__doc-chat__open_doc' } }))
  on('tool.call', { tool: 'SendUserFile' }, () => ({ result: 'Sent.' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, calls, runs, toasts, opens, panes, world }
}

const pane = (placement: 'dock' | 'widget' = 'dock') =>
  ({
    plugin: 'doc-chat',
    component: 'Pane',
    requestId: 'docchat',
    surface: 'desktop',
    props: { title: 'Doc chat', isFocused: false, bodyColumns: 90, placement, scroll: { offset: 0, bodyRows: 60 }, view: {} },
  }) as const

const menu = (props: Record<string, unknown>) => ({ plugin: 'doc-chat', component: 'ContextMenu', surface: 'desktop', props }) as const

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })

test('HTML becomes readable text, and paths resolve the way links and typing give them', () => {
  const h = htmlToText(HTML)
  expect(h.title).toBe('Audio Encoder Notes')
  expect(h.text).toContain('# Audio Encoder Notes')
  expect(h.text).toContain('1500 frames & a projector maps them to the LLM’s width.')
  expect(h.text).toContain('- CTC loss aligns frames to tokens')
  expect(h.text).toContain('| Model | WER |\n| --- | --- |\n| E6 | 12.03 |')
  expect(h.text).toContain('[figure: WER by test set]')
  expect(h.text).toContain('downsamples by 4× so')
  expect(h.text).not.toContain('var x')
  expect(h.text).not.toContain('color:red')

  expect(resolvePath('file:///Users/me/My%20Docs/a.pdf', '/w', '/Users/me')).toBe('/Users/me/My Docs/a.pdf')
  expect(resolvePath('docs/x.html:12', '/w', '/Users/me')).toBe('/w/docs/x.html')
  expect(resolvePath('../y/./z.md', '/w/a', '/Users/me')).toBe('/w/y/z.md')
  expect(resolvePath('~/r.pdf', '/w', '/Users/me')).toBe('/Users/me/r.pdf')
  expect(resolvePath('https://example.com/a.pdf', '/w', '/Users/me')).toBeUndefined()
  expect(titleFromPath('/l/sessions/2026-11-23-teardown-of-bert/walkthrough.pdf')).toBe('Teardown of bert')
  expect(titleFromPath('/x/Speech_Model_Report.pdf')).toBe('Speech Model Report')

  const pages = splitSections(PDF_TEXT)
  expect(pages.map(s => s.title)).toEqual(['Page 1', 'Page 2'])
  const doc = { text: PDF_TEXT } as LoadedDoc
  expect(isInDoc('The CTC loss aligns audio\nframes to output tokens', doc)).toBe(true)
  expect(isInDoc('export ANTHROPIC_API_KEY=sk-ant-something-secret', doc)).toBe(false)
  // Text selected from rendered Markdown has lost its marks; it still matches.
  expect(isInText('Because 50 Hz frames would make', 'Because **50 Hz** frames would make sequences longer')).toBe(true)
})

test('a page becomes clickable sentences, headings and table rows, its wrapped lines joined', () => {
  const md = [
    '## Why a projector',
    '',
    'The encoder makes 50 frames a second. A projector downsamples',
    'them by 4× (see [the paper](https://arxiv.org/abs/1)). Then the LLM reads them!',
    '',
    '- CTC loss aligns frames. It needs no labels.',
    '',
    '| Model | WER |',
    '| --- | --- |',
    '| E6 | 12.03 |',
    '',
    '```python',
    'x = model(audio). Done',
    '```',
    'यह वाक्य है। दूसरा वाक्य।',
  ].join('\n')
  const { markdown, units } = clickablePage(md)
  expect(units.map(u => u.text)).toEqual([
    'Why a projector',
    'The encoder makes 50 frames a second.',
    'A projector downsamples them by 4× (see the paper).',
    'Then the LLM reads them!',
    'CTC loss aligns frames.',
    'It needs no labels.',
    'Model | WER',
    'E6 | 12.03',
    'यह वाक्य है।',
    'दूसरा वाक्य।',
  ])
  expect(markdown).toContain('## [Why a projector](https://doc-chat.local/s/0)')
  expect(markdown).toContain('[A projector downsamples them by 4× (see the paper).](https://doc-chat.local/s/2)')
  expect(markdown).toContain('- [CTC loss aligns frames.](https://doc-chat.local/s/4) [It needs no labels.](https://doc-chat.local/s/5)')
  expect(markdown).toContain('| [E6](https://doc-chat.local/s/7) | 12.03 |')
  expect(markdown).toContain('| --- | --- |')
  expect(markdown).toContain('```python\nx = model(audio). Done\n```')
  expect(joinUnits(units, 2, 5)).toBe('A projector downsamples them by 4× (see the paper). Then the LLM reads them!\nCTC loss aligns frames. It needs no labels.')
  expect(clickablePage(md, { from: 1, to: 2 }).markdown).toContain('[**The encoder makes 50 frames a second.**](https://doc-chat.local/s/1)')
  expect(sentences('Use e.g. this one. Fig. 3 shows it, as Radford et al. 2023 found. Next one.')).toEqual(['Use e.g. this one.', 'Fig. 3 shows it, as Radford et al. 2023 found.', 'Next one.'])
})

test('the prompt caches the doc and carries the thread, the passage and the question', () => {
  const doc = { path: '/d/a.pdf', source: '/d/a.pdf', title: 'A', kind: 'pdf', text: PDF_TEXT, sections: [], pages: 2, mtimeMs: 0, isTruncated: false } as LoadedDoc
  const blocks = buildPrompt(doc, [{ id: '1', at: 0, kind: 'ask', question: 'What is CTC?', answer: 'Connectionist temporal classification.' }], { quote: 'SpecAugment masks bands', question: 'Why?' })
  expect(blocks[0]?.cache).toBe(true)
  expect(blocks[0]?.text).toContain('<document title="A" path="/d/a.pdf" kind="pdf" pages="2">')
  expect(blocks[1]?.cache).toBeUndefined()
  expect(blocks[1]?.text).toContain('Q: What is CTC?\nA: Connectionist temporal classification.')
  expect(blocks[1]?.text).toContain('"""\nSpecAugment masks bands\n"""')
  expect(blocks[1]?.text.endsWith('Their question: Why?')).toBe(true)
})

test('every session starts with the widget in its corner, on the doc used last in any session', async ($, on) => {
  const doc = '/w/docs/audio_encoder_notes.html'
  const files = new Map<string, File>([
    [doc, { text: HTML, mtimeMs: T0 }],
    ['/data/recent.json', { text: JSON.stringify([{ path: '/gone.pdf', title: 'Gone', at: T0 }, { path: doc, title: 'Audio Encoder Notes', at: T0 - 1 }]), mtimeMs: T0 }],
  ])
  const { clock, opens } = setup(on, files)
  await start($)
  await clock.settle()
  expect(opens).toHaveLength(1)
  expect(opens[0]).toEqual({ id: 'docchat', title: 'Doc chat', placement: 'widget' })

  const small = await $.ui.mount(pane('widget'))
  expect((await small.find({ type: 'Text', text: /^Doc chat · / }))?.text).toBe('Doc chat · Audio encoder notes')
  expect((await small.find({ type: 'Text', text: /Open to read/ }))?.text).toBe('Open to read it and ask Sonnet 5.5 about any passage')
  await small.unmount()
})

test('doc text selected in the conversation shows up by itself, and a question button asks Sonnet about it', async ($, on) => {
  const doc = '/w/docs/audio_encoder_notes.html'
  const files = new Map<string, File>([[doc, { text: HTML, mtimeMs: T0 }]])
  const { clock, calls, world } = setup(on, files)
  await start($)
  const out = await $.command.run({ command: 'doc', args: 'docs/audio_encoder_notes.html' })
  expect(out.text).toBe('Doc chat opened audio_encoder_notes.html.')
  await clock.settle()

  const ui = await $.ui.mount(pane())
  expect((await ui.find({ type: 'Markdown', text: /CTC loss/ }))?.text).toContain('- [Whisper large-v3 encoder](https://doc-chat.local/s/')
  expect(await ui.find({ type: 'Text', text: /Click a sentence in the text below/ })).toBeDefined()

  // Something selected elsewhere (not in the doc) is left alone; a passage of the doc is picked up.
  await clock.advance(800)
  world.selection = 'npm run build'
  await clock.advance(800)
  expect(await ui.find({ type: 'Text', text: /^Selected:$/ })).toBeUndefined()
  world.selection = 'The projector downsamples by 4× so the LLM sees 12.5 tokens per second'
  await clock.advance(800)
  expect((await ui.find({ type: 'Text', text: /^“The projector/ }))?.text).toBe(`“${world.selection}”`)

  world.reply = 'Because **50 Hz** frames would make sequences four times longer.'
  await ui.press({ key: 'q-why' })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.model).toBe('claude-sonnet-5-5')
  expect(calls[0]?.system).toContain('engineer comfortable with Python')
  expect(calls[0]?.prompt).toContain('- CTC loss aligns frames to tokens')
  expect(calls[0]?.prompt).toContain(`"""\n${world.selection}\n"""`)
  expect(calls[0]?.prompt).toContain('Their question: Why is it done this way?')
  // The answer shows above the page, so reading goes on in place.
  expect((await ui.find({ type: 'Markdown', text: /50 Hz/ }))?.text).toContain('four times longer')
  expect((await ui.find({ type: 'Text', text: /cached/ }))?.text).toBe('Sonnet 5.5 · 9.2k in (9.0k cached) · 80 out')
  expect(await ui.find({ type: 'Text', text: /^Selected:$/ })).toBeUndefined()

  // A typed follow-up with no passage held is about the whole doc, and the thread rides along.
  world.reply = 'Twelve and a half.'
  await ui.input({ key: 'ask-1', text: 'How many tokens per second does the LLM see?' })
  expect(calls).toHaveLength(2)
  expect(calls[1]?.prompt).not.toContain('The passage they selected')
  expect(calls[1]?.prompt).toContain('Q: Why is it done this way?')
  expect(calls[1]?.prompt).toContain('A: Because **50 Hz** frames')

  // Text selected in an answer counts too: ask about part of what Sonnet said.
  world.selection = 'Because 50 Hz frames would make sequences'
  await clock.advance(800)
  expect((await ui.find({ type: 'Text', text: /^“Because 50 Hz/ }))?.text).toBe('“Because 50 Hz frames would make sequences”')

  const id = hashPath(doc)
  const saved = JSON.parse(files.get(`/data/thread-${id}.json`)?.text ?? '{}')
  expect(saved.path).toBe(doc)
  expect(saved.title).toBe('Audio Encoder Notes')
  expect(saved.turns.map((t: { kind: string }) => t.kind)).toEqual(['why', 'ask'])
  expect(JSON.parse(files.get('/data/index.json')?.text ?? '{}')[id].questions).toBe(2)
  expect(JSON.parse(files.get('/data/recent.json')?.text ?? '[]')[0].path).toBe(doc)

  await ui.press({ key: 'view-chat' })
  expect((await ui.find({ type: 'Button', text: /^Chat/ }))?.text).toBe('Chat (2)')
  await ui.unmount()
})

test('a passage copied from the open file shows up by itself; copied text from elsewhere never does', async ($, on) => {
  const files = new Map<string, File>([['/w/report.pdf', { text: '%PDF-1.7', mtimeMs: T0 }]])
  const { clock, calls, runs, toasts, world } = setup(on, files)
  world.clipboard = 'export TOKEN=abc123 secret'
  await start($)
  await $.command.run({ command: 'doc', args: '/w/report.pdf' })
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect(runs.some(r => r[0] === 'osascript' && r.at(-1) === '/w/report.pdf')).toBe(true)
  await clock.advance(800 * 3)

  world.clipboard = 'git push --force origin main'
  await clock.advance(800 * 3)
  expect(await ui.find({ type: 'Text', text: /^Copied from the doc:$/ })).toBeUndefined()
  await ui.press({ key: 'q-explain' })
  expect(calls).toHaveLength(0)
  expect(toasts.at(-1)).toContain('copy one from the open file')

  world.clipboard = 'SpecAugment masks bands of the\nspectrogram during training.'
  await clock.advance(800 * 3)
  expect(await ui.find({ type: 'Text', text: /^Copied from the doc:$/ })).toBeDefined()
  await ui.press({ key: 'q-how' })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.prompt).toContain('SpecAugment masks bands of the\nspectrogram during training.')
  expect(calls[0]?.prompt).toContain('pages="2"')
  expect(calls.some(c => c.prompt.includes('TOKEN'))).toBe(false)

  await ui.press({ key: 'latest-hide' })
  expect((await ui.find({ type: 'Markdown', text: /CTC loss/ }))?.text).toContain('without frame labels')
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Markdown', text: /SpecAugment/ }))?.text).toContain('masks bands')
  await ui.unmount()
})

test('a lesson PDF is read from the Markdown it was printed from', async ($, on) => {
  const md = '---\ntitle: Mixture of experts\n---\n\n## In one minute\n\nA router picks 8 of 512 experts per token.'
  const files = new Map<string, File>([
    ['/w/learning/concepts/moe/moe.pdf', { text: '%PDF-1.7', mtimeMs: T0 }],
    ['/w/learning/concepts/moe/moe.md', { text: md, mtimeMs: T0 }],
  ])
  const { clock, calls, runs, world } = setup(on, files)
  await start($)
  await $.command.run({ command: 'doc', args: 'learning/concepts/moe/moe.pdf' })
  await clock.settle()
  const ui = await $.ui.mount(pane())
  world.selection = 'A router picks 8 of 512 experts per token.'
  await ui.press({ key: 'q-example' })
  expect(runs.some(r => r[0] === 'osascript')).toBe(false)
  expect(calls[0]?.prompt).toContain('title="Mixture of experts"')
  expect(calls[0]?.prompt).toContain('text-from="/w/learning/concepts/moe/moe.md"')
  await ui.unmount()
})

test('right-click: a doc link opens it, and selected text asks about the doc on show', async ($, on) => {
  const files = new Map<string, File>([['/w/Report Final.pdf', { text: '%PDF-1.7', mtimeMs: T0 }]])
  const { clock, calls } = setup(on, files)
  await start($)
  await clock.settle()

  const plain = await $.ui.mount(menu({ link: { href: 'https://example.com' } }))
  expect(await plain.find({ type: 'Button' })).toBeUndefined()
  await plain.unmount()

  const onLink = await $.ui.mount(menu({ link: { href: 'file:///w/Report%20Final.pdf' } }))
  await onLink.press({ key: 'chat-doc' })
  await onLink.unmount()
  await clock.settle()

  const onText = await $.ui.mount(menu({ selection: { text: 'SpecAugment masks bands' } }))
  expect((await onText.find({ type: 'Text', text: /About/ }))?.text).toBe('About Report Final')
  await onText.press({ key: 'ask-how' })
  await onText.unmount()
  expect(calls).toHaveLength(1)
  expect(calls[0]?.prompt).toContain('path="/w/Report Final.pdf"')
  expect(calls[0]?.prompt).toContain('"""\nSpecAugment masks bands\n"""')
  expect(calls[0]?.prompt).toContain('Their question: How does it work, step by step?')

  // "Ask my own question" holds the passage for a typed question.
  const own = await $.ui.mount(menu({ selection: { text: 'masks bands of the spectrogram' } }))
  await own.press({ key: 'ask-own' })
  await own.unmount()
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Text', text: /^From the chat:$/ })).toBeDefined()
  await ui.input({ key: 'ask-1', text: 'Which bands, and how wide?' })
  expect(calls[1]?.prompt).toContain('"""\nmasks bands of the spectrogram\n"""\n\nTheir question: Which bands, and how wide?')
  await ui.unmount()
})

test('/doc with a few words finds the doc, and the finder lists what it found', async ($, on) => {
  const files = new Map<string, File>([
    ['/w/docs/ml/audio_encoder_notes.html', { text: HTML, mtimeMs: T0 - 1000 }],
    ['/w/learning/concepts/moe/moe.pdf', { text: 'x'.repeat(300), mtimeMs: T0 - 500 }],
    ['/w/learning/concepts/moe/moe.md', { text: 'y'.repeat(300), mtimeMs: T0 - 500 }],
    ['/w/node_modules/pkg/README.md', { text: 'z'.repeat(300), mtimeMs: T0 }],
  ])
  const { clock } = setup(on, files)
  await start($)
  await clock.settle()
  const out = await $.command.run({ command: 'doc', args: 'audio encoder' })
  expect(out.text).toBe('Doc chat opened Audio encoder notes.')

  const none = await $.command.run({ command: 'doc', args: 'quantum gravity' })
  expect(none.text).toContain('No doc matches')
  await clock.settle()
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Text', text: /^Pick a doc/ })).toBeDefined()
  await ui.input({ key: 'find-1', text: '', kind: 'change' })
  expect((await ui.find({ type: 'Text', text: /^\d+ docs$/ }))?.text).toBe('2 docs')
  expect(await ui.find({ type: 'Text', text: /node_modules/ })).toBeUndefined()
  await ui.press({ key: `pick-${hashPath('/w/learning/concepts/moe/moe.pdf')}` })
  expect(await ui.find({ type: 'Text', text: /^Pick a doc/ })).toBeUndefined()
  await ui.unmount()
})

test('the open_doc tool opens a doc in the widget and can ask it a question', async ($, on) => {
  const doc = '/w/docs/audio_encoder_notes.html'
  const files = new Map<string, File>([[doc, { text: HTML, mtimeMs: T0 }]])
  const { clock, calls, world } = setup(on, files)
  await start($)
  await clock.settle()
  world.reply = 'It puts a Whisper encoder in front of the LLM through a 4× projector.'
  const r = await $.tool.call({ tool: 'mcp__doc-chat__open_doc', path: 'docs/audio_encoder_notes.html', question: 'What architecture does it propose?' })
  const text = JSON.stringify(r.result ?? r.text ?? '')
  expect(text).toContain('Doc chat shows Audio Encoder Notes.')
  expect(text).toContain('Sonnet 5.5 answered in the widget')
  expect(text).toContain('4× projector')
  expect(calls[0]?.prompt).toContain('Their question: What architecture does it propose?')

  const bad = await $.tool.call({ tool: 'mcp__doc-chat__open_doc', path: 'train.py' })
  expect(JSON.stringify(bad.result ?? bad.text ?? '')).toContain('is not one')
})

test('a question asked in another session shows up here, and docs sent to the person become recent', async ($, on) => {
  const doc = '/w/docs/audio_encoder_notes.html'
  const id = hashPath(doc)
  const files = new Map<string, File>([[doc, { text: HTML, mtimeMs: T0 }]])
  const { clock } = setup(on, files)
  await start($)
  await $.command.run({ command: 'doc', args: doc })
  await clock.settle()
  const ui = await $.ui.mount(pane())
  await ui.press({ key: 'view-chat' })
  expect(await ui.find({ type: 'Text', text: /No questions yet/ })).toBeDefined()

  files.set(`/data/thread-${id}.json`, {
    text: JSON.stringify({ path: doc, title: 'Audio Encoder Notes', turns: [{ id: 'a', at: T0, kind: 'ask', question: 'Asked elsewhere?', answer: 'Yes, in another session.' }] }),
    mtimeMs: T0 + 5000,
  })
  await clock.advance(800 * 4)
  expect((await ui.find({ type: 'Markdown', text: /another session/ }))?.text).toBe('Yes, in another session.')
  await ui.unmount()

  files.set('/w/out/ASR_Eval_Report.pdf', { text: '%PDF', mtimeMs: T0 })
  await $.tool.call({ tool: 'SendUserFile', files: ['out/ASR_Eval_Report.pdf'], status: 'normal' })
  await clock.settle()
  expect(JSON.parse(files.get('/data/recent.json')?.text ?? '[]')[0]).toEqual({ path: '/w/out/ASR_Eval_Report.pdf', title: 'ASR Eval Report', at: T0 + 3200 })
})

test('clicking a sentence quotes it, and a second click quotes the passage between', async ($, on) => {
  const files = new Map<string, File>([['/w/report.pdf', { text: '%PDF-1.7', mtimeMs: T0 }]])
  const { clock, calls } = setup(on, files)
  await start($)
  await $.command.run({ command: 'doc', args: '/w/report.pdf' })
  await clock.settle()
  const ui = await $.ui.mount(pane())
  const page = await ui.find({ type: 'Markdown', text: /doc-chat\.local/ })
  expect(page?.text).toBe('[The CTC loss aligns audio frames to output tokens without frame labels.](https://doc-chat.local/s/0)')

  await ui.press({ key: 'page', link: { href: 'https://doc-chat.local/s/0' } })
  expect(await ui.find({ type: 'Text', text: /^Selected:$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^“The CTC/ }))?.text).toBe('“The CTC loss aligns audio frames to output tokens without frame labels.”')
  expect((await ui.find({ type: 'Markdown', text: /doc-chat\.local/ }))?.text).toContain('[**The CTC loss')
  expect(await ui.find({ type: 'Text', text: /Click another sentence/ })).toBeDefined()

  await ui.press({ key: 'q-why' })
  expect(calls[0]?.prompt).toContain('"""\nThe CTC loss aligns audio frames to output tokens without frame labels.\n"""')
  expect(await ui.find({ type: 'Text', text: /^Selected:$/ })).toBeUndefined()

  // A page of two sentences: the second click quotes both.
  files.set('/w/notes.md', { text: '# Notes\n\nSpecAugment masks bands. It also masks time steps. Both help.', mtimeMs: T0 })
  await $.command.run({ command: 'doc', args: '/w/notes.md' })
  await clock.settle()
  await ui.press({ key: 'page', link: { href: 'https://doc-chat.local/s/3' } })
  await ui.press({ key: 'page', link: { href: 'https://doc-chat.local/s/1' } })
  expect((await ui.find({ type: 'Text', text: /^“SpecAugment/ }))?.text).toBe('“SpecAugment masks bands. It also masks time steps. Both help.”')
  expect(await ui.find({ type: 'Text', text: /Click a sentence to quote it/ })).toBeDefined()
  await ui.press({ key: 'plain-toggle' })
  expect(await ui.find({ type: 'Markdown', text: /doc-chat\.local/ })).toBeUndefined()
  await ui.unmount()
})
