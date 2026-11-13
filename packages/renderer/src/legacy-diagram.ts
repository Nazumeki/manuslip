import { checkDiagramSource, type DiagramSyntax } from './diagram'
import { legacyFlowchart } from './legacy-flowchart'
import { unsupportedLegacy } from './legacy-labels'
import { legacySequence } from './legacy-sequence'
export { restoreLegacyLabelFragments, restoreLegacyLabelText } from './legacy-labels'

/** Invoked by the isolated diagram host. Original source remains in the request. */
export function legacyDiagramToMermaid(source: string, syntax: DiagramSyntax): string {
  checkDiagramSource(source)
  const result =
    syntax === 'sequence'
      ? legacySequence(source)
      : syntax === 'flowchart'
        ? legacyFlowchart(source)
        : syntax === 'mermaid'
          ? source
          : unsupportedLegacy()
  checkDiagramSource(result)
  return result
}
