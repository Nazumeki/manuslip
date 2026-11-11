import { Facet } from '@codemirror/state'
import { defaultMarkdownPlugins } from '@manuslip/core/conventions'

/** Opt owns highlight and strikethrough in every document view. */
export const optMarkdown = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? defaultMarkdownPlugins.opt,
})

export const latexMarkdown = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? defaultMarkdownPlugins.latex,
})
