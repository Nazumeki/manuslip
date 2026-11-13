import { expect, type Page, test } from '@playwright/test'
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFRawStream,
} from 'pdf-lib'

/** Chromium reports the fonts that actually painted this node's text. */
export async function platformFonts(page: Page, selector: string) {
  return (await platformFontSamples(page, [selector]))[0] || []
}

async function platformFontSamples(page: Page, selectors: readonly string[]) {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable')
    await session.send('CSS.enable')
    const { root } = await session.send('DOM.getDocument')
    return await Promise.all(
      selectors.map(async (selector) => {
        const { nodeIds } = await session.send('DOM.querySelectorAll', {
          nodeId: root.nodeId,
          selector: `${selector}, ${selector} *`,
        })
        expect(nodeIds.length, selector).toBeGreaterThan(0)
        // The CDP operation covers direct text children, including SVG tspans and
        // CodeMirror's syntax spans; query each descendant rather than infer from CSS.
        const results = await Promise.all(
          nodeIds.map((nodeId) => session.send('CSS.getPlatformFontsForNode', { nodeId })),
        )
        return results.flatMap((result) => result.fonts)
      }),
    )
  } finally {
    await session.detach()
  }
}

export async function expectBundledCjk(page: Page, selector: string, minimumGlyphs: number) {
  return (await expectBundledCjkSamples(page, [[selector, minimumGlyphs]]))[0] || []
}

export async function expectBundledCjkSamples(
  page: Page,
  samples: readonly (readonly [selector: string, minimumGlyphs: number])[],
) {
  // Inspect one document once, including when the artifact embeds large font data.
  const groups = await platformFontSamples(
    page,
    samples.map(([selector]) => selector),
  )
  for (const [index, [selector, minimumGlyphs]] of samples.entries()) {
    const fonts = groups[index] || []
    const count = fonts
      .filter((font) => font.isCustomFont && font.familyName === 'Noto Sans CJK SC')
      .reduce((sum, font) => sum + font.glyphCount, 0)
    expect(count, JSON.stringify({ selector, fonts })).toBeGreaterThanOrEqual(minimumGlyphs)
    await test.info().attach('font-usage', {
      body: JSON.stringify({ selector, fonts, bundledGlyphs: count }),
      contentType: 'application/json',
    })
  }
  return groups
}

export function expectCjkPdf(pdf: PDFDocument, text: string) {
  const objects = pdf.context.enumerateIndirectObjects()
  const maps = new Map<PDFDict, PDFRawStream>()
  for (const [, font] of objects) {
    if (!(font instanceof PDFDict)) continue
    const unicode = font.lookup(PDFName.of('ToUnicode'))
    if (!(unicode instanceof PDFRawStream)) continue
    maps.set(font, unicode)
    const descendants = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)
    for (let index = 0; index < (descendants?.size() ?? 0); index++) {
      const descendant = descendants?.lookup(index, PDFDict)
      if (descendant) maps.set(descendant, unicode)
    }
  }
  let mappings = ''
  let glyphs = 0
  for (const [, font] of objects) {
    if (!(font instanceof PDFDict) || !font.has(PDFName.of('FontDescriptor'))) continue
    const descriptor = font.lookup(PDFName.of('FontDescriptor'), PDFDict)
    if (!descriptor.get(PDFName.of('FontName'))?.toString().includes('NotoSansCJKsc')) continue
    const program =
      descriptor.lookup(PDFName.of('FontFile2')) ?? descriptor.lookup(PDFName.of('FontFile3'))
    if (program instanceof PDFRawStream) {
      expect(decodePDFRawStream(program).decode().length).toBeGreaterThan(100)
      glyphs++
    } else {
      // Some Chromium font backends embed variable faces as Type 3 vector glyphs.
      expect(font.get(PDFName.of('Subtype'))?.toString()).toBe('/Type3')
      const paths = font.lookup(PDFName.of('CharProcs'), PDFDict)
      for (const [name] of paths.entries()) {
        if (name.toString() === '/g0') continue
        const path = paths.lookup(name)
        if (!(path instanceof PDFRawStream)) throw new Error('Missing embedded glyph path')
        const drawing = Buffer.from(decodePDFRawStream(path).decode()).toString()
        expect(drawing).toMatch(/\b[mlc]\b/)
        expect(drawing).toMatch(/\bf\*?\b/)
        glyphs++
      }
    }
    const unicode = maps.get(font)
    if (!unicode) throw new Error('Embedded Chinese font has no Unicode mapping')
    mappings += Buffer.from(decodePDFRawStream(unicode).decode()).toString()
  }
  expect(glyphs).toBeGreaterThan(0)
  for (const character of text) {
    const hex = Buffer.from(character, 'utf16le').swap16().toString('hex').toUpperCase()
    expect(mappings, `PDF Unicode mapping for ${character}`).toContain(`<${hex}>`)
  }
}
