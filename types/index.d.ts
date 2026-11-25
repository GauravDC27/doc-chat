/** How a doc's text was read: PDFs through PDFKit (or the Markdown they were printed from), HTML with its tags stripped. */
export type DocKind = 'pdf' | 'html' | 'md' | 'text'

/** The quick questions, and `ask` for one the person typed. */
export type AskKind = 'explain' | 'why' | 'how' | 'example' | 'simpler' | 'ask'

/** Where a passage came from: sentences clicked in the reader, selected on screen, copied from the doc, or the right-click menu. */
export type QuoteSource = 'pick' | 'selection' | 'clipboard' | 'menu'

/** Sentences clicked in the reader: from one to another on one page; `isOpen` while a second click would extend it. */
export type Pick = { docId: string; section: number; from: number; to: number; isOpen: boolean }

export type Quote = { text: string; from: QuoteSource }

export type Turn = {
  id: string
  at: number
  kind: AskKind
  question: string
  quote?: string
  answer?: string
  error?: string
  model?: string
  tokensIn?: number
  tokensCached?: number
  tokensOut?: number
}

/** One doc's chat: the doc's description and its thread. The doc's text stays in the module. */
export type DocChat = {
  /** 8 hex characters from the doc's path, or `general` for the chat with no doc. */
  id: string
  path: string | null
  title: string
  kind: DocKind | 'none'
  chars: number
  sections: number
  pages?: number
  isTruncated: boolean
  isLoading: boolean
  loadError?: string
  turns: Turn[]
  isBusy: boolean
  /** The page or section the reader shows. */
  section: number
  /** When the thread file was last read or written, so a question asked in another session shows here too. */
  threadMtime?: number
}

/** The one Doc chat widget of this session. */
export type Widget = {
  /** The chat it shows, a key of `chats`; null before any doc is picked. */
  docId: string | null
  view: 'read' | 'chat'
  /** The passage the next question is about. */
  quote?: Quote
  /** The sentences that passage was clicked from, drawn bold in the reader. */
  pick?: Pick
  /** The reader draws plain text instead of clickable sentences. */
  isPlain?: boolean
  /** Bumped after each question so the input box comes back empty. */
  askSeq: number
  /** The latest answer shows above the page while reading, until hidden. */
  showLatest: boolean
  showAll: boolean
  isClearArmed: boolean
  /** The doc finder is open instead of the page. */
  isPicking: boolean
  filter: string
  /** Bumped to empty the finder box. */
  findSeq: number
  /** The person closed the widget in this session: it stays closed, and a one-line band reopens it. */
  isClosed: boolean
  isBandHidden: boolean
}

export type LibraryEntry = {
  path: string
  title: string
  folder: string
  mtimeMs: number
  questions: number
  lastAskedAt?: number
  /** When it was last opened in Doc chat or sent to the person, in any session. */
  openedAt?: number
}

export type LibraryState = {
  entries: LibraryEntry[]
  isScanning: boolean
  scannedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'doc-chat': {
      chats: Shaped<Record<string, DocChat>>
      widget: Shaped<Widget>
      library: Shaped<LibraryState>
    }
  }
}
