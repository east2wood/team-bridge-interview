import type { ReactNode } from 'react'

/**
 * Just enough Markdown to read a resume.
 *
 * Builds React elements rather than HTML, which is the whole security story:
 * there is no innerHTML anywhere, so a resume containing a script tag renders
 * as the words "script tag" and nothing else can happen. No sanitiser to keep
 * up to date, because nothing is ever parsed as markup.
 *
 * Headings, emphasis, code, links, and both kinds of list — which is what
 * resumes are made of. Tables, images, footnotes and the rest are left as the
 * text they were written as, on the grounds that a resume using them is rare
 * and showing the raw line is honest where guessing is not.
 */
export function Markdown({ text }: { text: string }): ReactNode {
  return <>{blocks(text.replace(/\r\n?/g, '\n'))}</>
}

function blocks(text: string): ReactNode[] {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  let key = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (!line.trim()) continue

    // Fenced code: taken verbatim to its closing fence, or to the end of the
    // resume if whoever wrote it forgot one.
    const fence = /^\s*```(\w+)?\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i]!), i++
      out.push(
        <pre key={key++} className="md__code">
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1]!.length, 4)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
      out.push(
        <Tag key={key++} className={`md__h md__h${level}`}>
          {inline(strip(heading[2]!))}
        </Tag>,
      )
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key++} className="md__rule" />)
      continue
    }

    // A list runs until something that is not a list item. Nesting is read
    // from the indent, one level deep — enough for "role, then bullets".
    if (isItem(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: ReactNode[] = []
      while (i < lines.length && (isItem(lines[i]!) || isLooseContinuation(lines, i))) {
        if (!isItem(lines[i]!)) {
          i++
          continue
        }
        items.push(<li key={items.length}>{inline(strip(itemText(lines[i]!)))}</li>)
        i++
      }
      i--
      out.push(
        ordered ? (
          <ol key={key++} className="md__list">
            {items}
          </ol>
        ) : (
          <ul key={key++} className="md__list">
            {items}
          </ul>
        ),
      )
      continue
    }

    // Everything else is a paragraph. Consecutive lines are kept as separate
    // lines rather than run together, because that is what they are in the
    // resumes this reads: one skill group, one employer, one date range per
    // line, with nothing but the newline separating them.
    const para: string[] = [line]
    while (i + 1 < lines.length && lines[i + 1]!.trim() && !isBlockStart(lines[i + 1]!)) {
      para.push(lines[++i]!)
    }
    out.push(
      <p key={key++} className="md__p">
        {para.map((row, n) => (
          <span key={n}>
            {n > 0 && <br />}
            {inline(strip(row))}
          </span>
        ))}
      </p>,
    )
  }

  return out
}

/**
 * Drops a trailing attribute list — `{.section-title}`, `{.contact}`.
 *
 * TeamBridge's resumes carry them so the themes that print a resume can style
 * it. They are directions to a stylesheet, not something the candidate wrote,
 * and shown as text they read as though the resume is broken. Only a block
 * that starts with `.` or `#` is taken, so a sentence with braces in it keeps
 * them.
 */
function strip(text: string): string {
  return text.replace(/\s*\{[.#][^{}]*\}\s*$/, '')
}

const isItem = (line: string) => /^\s*([-*+]|\d+[.)])\s+/.test(line)
const itemText = (line: string) => line.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
const isBlockStart = (line: string) =>
  isItem(line) || /^(#{1,6})\s/.test(line) || /^\s*```/.test(line)

/** A blank line inside a list, where the list continues after it. */
function isLooseContinuation(lines: string[], i: number): boolean {
  return !lines[i]!.trim() && i + 1 < lines.length && isItem(lines[i + 1]!)
}

/** Bold, italic, inline code and links, in one pass so they cannot nest wrongly. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g

  let last = 0
  let key = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]

    if (token.startsWith('`')) {
      out.push(
        <code key={key++} className="md__inlinecode">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!
      out.push(anchor(key++, link[2]!, link[1]!))
    } else if (token.startsWith('http')) {
      out.push(anchor(key++, token, token))
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>)
    }

    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))

  return out
}

/**
 * A link that leaves the app.
 *
 * `target` is not decoration: every window here denies in-app navigation and
 * hands the URL to the system browser, and that handler only sees a link that
 * asks for a new window. Without it the click would navigate the interview
 * out of existence.
 */
function anchor(key: number, href: string, label: string): ReactNode {
  // A resume's links are a portfolio and an email address; anything else —
  // file:, or a scheme some other program has registered — is shown as the
  // text it is rather than handed to the operating system.
  const safe = /^(https?:\/\/|mailto:)/i.test(href)
  if (!safe) return <span key={key}>{label}</span>

  return (
    <a key={key} href={href} target="_blank" rel="noreferrer" title={href}>
      {label}
    </a>
  )
}
