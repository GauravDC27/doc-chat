import type { ModelTextBlock } from 'claude-code'

import type { AskKind, Turn } from '../types'
import type { LoadedDoc } from './docs'

export const KIND_LABEL: Record<AskKind, string> = {
  explain: 'What is this?',
  why: 'Why?',
  how: 'How does it work?',
  example: 'Example',
  simpler: 'Simpler',
  ask: 'Ask',
}

/** What each quick button asks about the quoted passage. */
export const KIND_QUESTION: Record<Exclude<AskKind, 'ask'>, string> = {
  explain: 'What does this passage say? Explain it and the idea behind it, and why it matters in this document.',
  why: 'Why is it done this way? What problem does it solve, what were the alternatives, and what trade-off decided it?',
  how: 'How does it work, step by step? Show the mechanism or the maths, with the shapes or numbers that make it concrete.',
  example: 'Work through a small concrete example of this with real numbers.',
  simpler: 'Explain this more simply, with an everyday analogy, and say where the analogy breaks.',
}

export const MAX_QUOTE_CHARS = 4000
const HISTORY_TURNS = 6
const HISTORY_ANSWER_CHARS = 2500

export function systemPrompt(background: string): string {
  return [
    'You are a tutor in a side chat beside a document the person is reading. They select passages and ask what, why and how.',
    '',
    `About them: ${background}`,
    '',
    'How to answer:',
    '- Lead with the direct answer in one or two sentences, then explain. Stay under about 350 words unless they ask for depth or the question needs a derivation.',
    '- Ground it in the document. When the document says something relevant, quote a short phrase and say where (its section or page). When you go beyond the document, say so with "Beyond the doc:".',
    '- Teach the AI and ML underneath: the intuition, the maths where it helps, tensor shapes and real numbers, and the paper or idea it comes from. For a why, name the problem, the alternatives and the trade-off that decided it.',
    '- If the document looks wrong, inconsistent or overclaims, say so plainly and explain why.',
    '- If the question is ambiguous, answer the likeliest reading and say what you assumed.',
    '- Format as Markdown: short paragraphs, bullets, and a table when comparing. Write maths in plain Unicode inline (σ, Σ, √, ≈, x², softmax(z)ᵢ = e^(zᵢ) / Σⱼ e^(zⱼ)) or in a fenced code block. Never use LaTeX delimiters such as $…$, \\( \\) or \\[ \\]: they do not render here.',
    '- No emoji, and no opening praise of the question.',
  ].join('\n')
}

function docBlock(doc: LoadedDoc): string {
  const attrs = [`title="${doc.title.replace(/"/g, "'")}"`, `path="${doc.path}"`, `kind="${doc.kind}"`]
  if (doc.pages) attrs.push(`pages="${doc.pages}"`)
  if (doc.source !== doc.path) attrs.push(`text-from="${doc.source}"`)
  const cut = doc.isTruncated ? '\n[The document continues; only its first part fits here.]' : ''
  return `<document ${attrs.join(' ')}>\n${doc.text}${cut}\n</document>`
}

function historyBlock(turns: Turn[]): string | undefined {
  const done = turns.filter(t => t.answer).slice(-HISTORY_TURNS)
  if (done.length === 0) return undefined
  const lines = done.map(t => {
    const quote = t.quote ? `\n(about: "${t.quote.slice(0, 600)}${t.quote.length > 600 ? '…' : ''}")` : ''
    const answer = (t.answer ?? '').length > HISTORY_ANSWER_CHARS ? `${(t.answer ?? '').slice(0, HISTORY_ANSWER_CHARS)}…` : t.answer
    return `Q: ${t.question}${quote}\nA: ${answer}`
  })
  return `<earlier_in_this_chat>\n${lines.join('\n\n')}\n</earlier_in_this_chat>`
}

/**
 * The one user message: the document first and marked for the prompt cache, so
 * follow-ups within a few minutes read it from the cache; then the thread so far;
 * then the passage and the question.
 */
export function buildPrompt(doc: LoadedDoc | null, earlier: Turn[], ask: { quote?: string; question: string }): ModelTextBlock[] {
  const blocks: ModelTextBlock[] = []
  if (doc) blocks.push({ text: docBlock(doc), cache: true })
  else blocks.push({ text: 'No document is attached: the person is asking about text from their Claude Code session or a document you cannot see. Answer from what they quote and your own knowledge.' })
  const history = historyBlock(earlier)
  const quote = ask.quote ? `The passage they selected:\n"""\n${ask.quote.slice(0, MAX_QUOTE_CHARS)}\n"""\n\n` : ''
  blocks.push({ text: `${history ? `${history}\n\n` : ''}${quote}Their question: ${ask.question}` })
  return blocks
}
