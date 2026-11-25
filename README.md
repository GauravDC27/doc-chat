# Doc chat

Read a doc beside the conversation and ask Sonnet 5.5 about it: PDFs, HTML pages and Markdown. Pick a passage, then ask what it means, why it is done that way or how it works. The session's own conversation never sees it, so a training run or any other work keeps going untouched.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install doc-chat --marketplace GauravDC27/doc-chat
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell:

```bash
claude plugin install doc-chat --marketplace GauravDC27/doc-chat
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `GauravDC27/doc-chat`, then Add plugin.

Doc chat reads PDFs with macOS's PDFKit, so PDFs need a Mac; HTML and Markdown work anywhere.

## The widget

Every session starts with a small **Doc chat** widget in the corner of the chat. It shows the doc you used last, in any session, and the latest answer. Expand it to read and ask.

Expanded, it has:

- **Doc**: pick the doc from your recent docs, or **Find another doc…** to search by name or path.
- **Read**: the doc's text, page by page for a PDF or section by section otherwise, with the latest answer shown above the page. Every sentence, heading and table row is clickable; **Plain text** turns that off.
- **Chat**: every question and answer about this doc, newest first.
- The question bar: **What is this?**, **Why?**, **How does it work?**, **Example**, **Simpler**, and a box for your own question.

If you close the widget, a one-line **Doc chat · Open** band stays above the prompt in that session. **Hide** removes the band too.

## Asking about a passage

- **Click a sentence** in the widget's Read view to quote it, then click a second sentence to quote everything from the first to the second. It shows up as **Selected: “…”** above the buttons, in bold on the page; then press a button or type a question. (The desktop app doesn't let you select text inside a pane, so clicking stands in for selecting.)
- **Reading in the app's file viewer?** Copy the passage (⌘C). It shows up as **Copied from the doc: “…”**. Copied text is used only when it is found in the open doc, so a command or a key you copied is never sent.
- **Text in the conversation:** select it, right-click and pick **Doc chat: what is this? / why? / how does it work? / ask my own question…**
- **A doc link in the conversation:** right-click it and pick **Open in Doc chat**.
- Text from the doc or from an answer that you select in the conversation counts too.

A question typed with no passage held is about the whole doc. Follow-ups see the earlier questions and answers.

## Commands and the agent

- `/doc` opens the widget. `/doc attention notes` opens the best match by name, and `/doc docs/papers/attention.pdf` opens a path.
- `/doc-ask <question>` asks about the doc on show.
- Claude can open a doc for you with the `open_doc` tool ("open the listening doc in Doc chat").

## Across sessions

Threads and the recent list are files in the mod's data folder, shared by every session. A question asked in one session shows up in another session's widget within a few seconds. A doc Claude sends you, or writes into a `docs`, `learning`, `reports`, `notes` or `papers` folder, joins the recent list.

## How it answers

The doc's full text goes to the model with each question and is marked for the prompt cache, so follow-ups within a few minutes cost little. PDFs are read with macOS's built-in PDFKit, and a PDF with the Markdown it was printed from beside it (same name, `.md`) is read from that Markdown. HTML is read with its figures reduced to their labels. Answers stay grounded in the doc, say when they go beyond it, and teach the ML underneath: intuition, maths, shapes and the research behind it.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `model` | `claude-sonnet-5-5` | The model that answers |
| `effort` | `medium` | How hard it thinks: `low`, `medium` or `high` |
| `background` | an engineer who knows Python and some ML | What answers can assume you know |
| `folders` | the session's folder | Where the doc finder looks, comma-separated |
| `autoOpen` | on | Show the widget when a session starts |
| `watchClipboard` | on | Pick up passages copied from the open doc while the widget is on screen |

## Limits

- Mods can't read the app's file viewer, so a selection there reaches Doc chat by copying it.
- Text in a pane can't be selected in the desktop app; the Read view's clickable sentences stand in for selecting.
- A clicked passage stays on one page.
- The Read view shows the doc's text without its figures.
- Scanned PDFs with no text layer can't be read.
- Docs longer than about 400,000 characters are cut to their first part, and the widget says so.
- Answers count toward the session's cost.
