import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { areasDoc } from '../algorithms/areas'
import { infillDoc } from '../algorithms/infill'
import { metricsDoc } from '../algorithms/metrics'
import { pathOrderDoc } from '../algorithms/pathOrder'
import { slicingDoc } from '../algorithms/slicing'
import { travelDoc } from '../algorithms/travel'
import type { StageDoc } from '../algorithms/types'
import { arachneDoc } from '../algorithms/wallsArachne'
import { constantWallsDoc } from '../algorithms/wallsConstant'
import { Markdown } from './markdown'

const render = (text: string): string =>
  renderToStaticMarkup(createElement(Markdown, { text }))

describe('Markdown', () => {
  it('renders ## and ### headings', () => {
    const html = render('## Section\n### Sub\nbody')
    expect(html).toContain('<h2>Section</h2>')
    expect(html).toContain('<h3>Sub</h3>')
    expect(html).toContain('<p>body</p>')
  })

  it('renders inline bold and code chips', () => {
    const html = render('Use **walls** with `wallWidth / 2` here.')
    expect(html).toContain('<strong>walls</strong>')
    expect(html).toContain('<code>wallWidth / 2</code>')
  })

  it('does not parse formatting inside code spans', () => {
    const html = render('`a ** b` stays literal')
    expect(html).toContain('<code>a ** b</code>')
    expect(html).not.toContain('<strong>')
  })

  it('groups consecutive numbered lines into one ordered list', () => {
    const html = render('1. first\n2. second\n3. third')
    expect(html).toMatch(/^<ol>(<li>.*<\/li>){3}<\/ol>$/)
  })

  it('groups dash lines into one unordered list with inline formatting', () => {
    const html = render('- `d = 2r` — size\n- plain')
    expect(html).toMatch(/^<ul>/)
    expect(html).toContain('<li><code>d = 2r</code> — size</li>')
    expect((html.match(/<li>/g) ?? []).length).toBe(2)
  })

  it('joins wrapped lines into one paragraph and splits on blank lines', () => {
    const html = render('one\ntwo\n\nthree')
    expect(html).toBe('<p>one two</p><p>three</p>')
  })

  it('escapes HTML in source text (no injection surface)', () => {
    const html = render('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('all StageDoc explanations', () => {
  const docs: [string, StageDoc][] = [
    ['slicing', slicingDoc],
    ['areas', areasDoc],
    ['constant walls', constantWallsDoc],
    ['arachne', arachneDoc],
    ['infill', infillDoc],
    ['path order', pathOrderDoc],
    ['travel', travelDoc],
    ['metrics', metricsDoc],
  ]

  it.each(docs)('%s: has a Step by step section and renders cleanly', (_, doc) => {
    expect(doc.explanation).toContain('## Step by step')
    const html = render(doc.explanation)
    // No raw markdown markers may survive into the output.
    expect(html).not.toContain('## ')
    expect(html).not.toContain('`')
    expect(html).not.toContain('**')
    // Structure: several sections, at least one list.
    expect((html.match(/<h2>/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(html).toMatch(/<[ou]l>/)
  })
})
