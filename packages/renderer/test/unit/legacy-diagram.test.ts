import { describe, expect, it } from 'vitest'
import { diagramLimits, diagramSyntax } from '../../src/diagram'
import {
  legacyDiagramToMermaid,
  restoreLegacyLabelFragments,
  restoreLegacyLabelText,
} from '../../src/legacy-diagram'

describe('bounded legacy diagram compatibility', () => {
  it('restores generated escapes across every possible text span boundary', () => {
    const encoded = '&#34;&#60;script&#62;&#34; &#38; &#35;35&#59; &#92; &#37; &#96;'
    const expected = restoreLegacyLabelText(encoded)
    for (let split = 0; split <= encoded.length; split++) {
      const fragments = [encoded.slice(0, split), '', encoded.slice(split)]
      const restored = restoreLegacyLabelFragments(fragments)
      expect(restored).toHaveLength(fragments.length)
      expect(restored[1]).toBe('')
      expect(restored.join('')).toBe(expected)
    }
  })
  it('preserves wrapped label spans and literal entities without decoding a second time', () => {
    expect(
      restoreLegacyLabelFragments([
        'Review',
        '&#34;&#60;dr',
        'aft&#62;&#34',
        ';',
        ' &#38;',
        ' keep',
        '&#35;35&#59',
        ';',
        ' &lt; &#39; &#9999;',
      ]),
    ).toEqual(['Review', '"<dr', 'aft>"', '', ' &', ' keep', '#35;', '', ' &lt; &#39; &#9999;'])
  })
  it('restores only generated flow-label entities once as inert text', () => {
    expect(
      restoreLegacyLabelText('&#34;&#60;script&#62;&#34; &#38; &#35;35&#59; &#92; &#37; &#96;'),
    ).toBe('"<script>" & #35; \\ % `')
    expect(restoreLegacyLabelText('&#35;34&#59; &lt; &#39; &#9999;')).toBe(
      '#34; &lt; &#39; &#9999;',
    )
  })
  it('preserves participant order, aliases, titles, notes and four legacy arrow styles', () => {
    const source =
      'Title: Greeting\r\nparticipant "Alice 世界" as A\r\nparticipant Bob\r\nA->Bob: Hello\r\nBob-->A: Reply\r\nA->>Bob: Open\r\nBob-->>A: Dashed open\r\nNote over A,Bob: Together\\nagain\r\nNote left of A: Thinking\r\n'
    const result = legacyDiagramToMermaid(source, 'sequence')
    expect(result).toBe(
      'sequenceDiagram\ntitle Greeting\nparticipant P0 as Alice 世界\nparticipant P1 as Bob\nP0->>P1: Hello\nP1-->>P0: Reply\nP0->P1: Open\nP1-->P0: Dashed open\nNote over P0,P1: Together<br/>again\nNote left of P0: Thinking',
    )
    expect(source).toContain('A->Bob: Hello\r\n')
  })
  it('uses generated identifiers for quoted Unicode names and text containing grammar characters', () => {
    const source =
      'participant "Alice: A,B" as A\nA->"end": <img src=x onerror=bad>; %% note\nNote over A,"end": #quot; & "text"\n'
    const result = legacyDiagramToMermaid(source, 'sequence')
    expect(result).toContain('participant P0 as Alice: A,B')
    expect(result).toContain('participant P1 as end')
    expect(result).toContain('P0->>P1: #60;img src=x onerror=bad#62;#59; #37;#37; note')
    expect(result).not.toContain('<img')
    expect(result).toContain('#35;quot#59; #38; #34;text#34;')
  })
  it('maps flowchart nodes, multiline labels, chains and yes/no conditions without copying identifiers', () => {
    const source =
      'st=>start\nop=>operation: 写作\n继续\ncond=>condition: Ready?\nio=>inputoutput: Input\\nOutput\nsub=>subroutine: Review\ne=>end\n\nst->op->cond\ncond(yes)->io->e\ncond(no)->sub->op\n'
    const result = legacyDiagramToMermaid(source, 'flowchart')
    expect(result).toContain('N0(["Start"])')
    expect(result).toContain('N1["写作<br/>继续"]')
    expect(result).toContain('N2{"Ready?"}')
    expect(result).toContain('N3[/"Input<br/>Output"/]')
    expect(result).toContain('N4[["Review"]]')
    expect(result).toContain('N5(["End"])')
    expect(result).toContain('N2 -->|yes| N3')
    expect(result).toContain('N2 -->|no| N4')
    expect(result).not.toContain('st->')
  })
  it.each([
    'a=>operation: Link:>https://example.test',
    'a=>operation: State|past',
    'a=>parallel: Paths',
    'a=>operation: A\nb=>end\na(right)->b',
    'a=>operation: A\na->missing',
    'a=>condition: Ready?\nb=>end\na->b',
    'a=>operation: A\nb=>end\na(yes)->b',
    'a=>operation: A\na=>end',
    'a=>operation: A\nstyle a fill:red',
  ])('retains unsupported flowchart syntax for a truthful source fallback: %#', (source) => {
    expect(() => legacyDiagramToMermaid(source, 'flowchart')).toThrow('diagram-unsupported')
  })
  it.each([
    'loop Repeat\nA->B: Message\nend',
    'A->B: Message\nparticipant C',
    'Note over A,B,C: Many',
    'activate A',
    'participant A\nparticipant B as A',
  ])('rejects unsupported or ambiguous sequence statements: %#', (source) => {
    expect(() => legacyDiagramToMermaid(source, 'sequence')).toThrow('diagram-unsupported')
  })
  it('keeps source, generated output, node and edge limits and configuration rejection', () => {
    expect(() => legacyDiagramToMermaid('界'.repeat(diagramLimits.source), 'sequence')).toThrow(
      'diagram-limit',
    )
    expect(() => legacyDiagramToMermaid(`A->B: ${'<'.repeat(17000)}`, 'sequence')).toThrow(
      'diagram-limit',
    )
    expect(() =>
      legacyDiagramToMermaid(
        Array.from({ length: diagramLimits.nodes + 1 }, (_, i) => `participant A${i}`).join('\n'),
        'sequence',
      ),
    ).toThrow('diagram-limit')
    expect(() =>
      legacyDiagramToMermaid('A->B: x\n'.repeat(diagramLimits.edges + 1), 'sequence'),
    ).toThrow('diagram-limit')
    expect(() => legacyDiagramToMermaid('%%{init:{}}\nA->B: x', 'sequence')).toThrow(
      'diagram-config',
    )
  })
  it('recognizes explicit legacy fence aliases and leaves Mermaid and unrelated code intact', () => {
    expect(['mermaid', 'SEQUENCE', 'seq', 'flowchart', 'FLOW', 'js'].map(diagramSyntax)).toEqual([
      'mermaid',
      'sequence',
      'sequence',
      'flowchart',
      'flowchart',
      undefined,
    ])
    const source = 'flowchart LR\nA-->B'
    expect(legacyDiagramToMermaid(source, 'mermaid')).toBe(source)
  })
})
