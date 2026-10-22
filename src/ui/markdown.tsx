import type { ReactNode } from 'react'

/**
 * Minimal markdown renderer for StageDoc explanations. Supports `##`/`###`
 * headings, ordered and unordered lists, blank-line-separated paragraphs,
 * `**bold**` and `` `inline code` ``. Builds React elements directly — no
 * dangerouslySetInnerHTML, so there is no XSS surface.
 */

/** Inline tokenizer: code spans first, then bold within plain text. */
function renderInline(text: string, prefix: string): ReactNode[] {
  const out: ReactNode[] = []
  text.split(/(`[^`\n]+`)/g).forEach((part, i) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      out.push(<code key={`${prefix}c${i}`}>{part.slice(1, -1)}</code>)
      return
    }
    part.split(/(\*\*[^*\n]+\*\*)/g).forEach((sub, j) => {
      if (sub.length > 4 && sub.startsWith('**') && sub.endsWith('**')) {
        out.push(<strong key={`${prefix}b${i}-${j}`}>{sub.slice(2, -2)}</strong>)
      } else if (sub) {
        out.push(sub)
      }
    })
  })
  return out
}

const ORDERED = /^\d+\.\s+/

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('### ')) {
      blocks.push(<h3 key={key++}>{renderInline(line.slice(4), `h3-${key}`)}</h3>)
      i++
      continue
    }
    if (line.startsWith('## ')) {
      blocks.push(<h2 key={key++}>{renderInline(line.slice(3), `h2-${key}`)}</h2>)
      i++
      continue
    }
    if (ORDERED.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && ORDERED.test(lines[i])) {
        items.push(
          <li key={i}>{renderInline(lines[i].replace(ORDERED, ''), `ol-${key}-${i}`)}</li>,
        )
        i++
      }
      blocks.push(<ol key={key++}>{items}</ol>)
      continue
    }
    if (line.startsWith('- ')) {
      const items: ReactNode[] = []
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(<li key={i}>{renderInline(lines[i].slice(2), `ul-${key}-${i}`)}</li>)
        i++
      }
      blocks.push(<ul key={key++}>{items}</ul>)
      continue
    }
    // Paragraph: consecutive plain lines, joined with a space.
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('- ') &&
      !ORDERED.test(lines[i])
    ) {
      para.push(lines[i].trim())
      i++
    }
    blocks.push(<p key={key++}>{renderInline(para.join(' '), `p-${key}`)}</p>)
  }
  return <>{blocks}</>
}
