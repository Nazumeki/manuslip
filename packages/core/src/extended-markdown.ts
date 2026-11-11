import { nameToEmoji } from 'gemoji'
import type { Literal, Parent, PhrasingContent } from 'mdast'
import type { CompileContext, Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type { Construct, Extension, Token, TokenType } from 'micromark-util-types'
import type { Plugin } from 'unified'

interface Subscript extends Parent {
  type: 'subscript'
  children: PhrasingContent[]
}
interface Superscript extends Parent {
  type: 'superscript'
  children: PhrasingContent[]
}
interface Emoji extends Literal {
  type: 'emoji'
  name: string
  value: string
}
declare module 'mdast' {
  interface RootContentMap {
    subscript: Subscript
    superscript: Superscript
    emoji: Emoji
  }
  interface PhrasingContentMap {
    subscript: Subscript
    superscript: Superscript
    emoji: Emoji
  }
}
declare module 'micromark-util-types' {
  interface TokenTypeMap {
    manuslipSubscript: 'manuslipSubscript'
    manuslipSubscriptMarker: 'manuslipSubscriptMarker'
    manuslipSubscriptData: 'manuslipSubscriptData'
    manuslipSuperscript: 'manuslipSuperscript'
    manuslipSuperscriptMarker: 'manuslipSuperscriptMarker'
    manuslipSuperscriptData: 'manuslipSuperscriptData'
    manuslipEmoji: 'manuslipEmoji'
  }
  interface Token {
    _manuslipEmojiName?: string
  }
}

function script(marker: number, token: TokenType, mark: TokenType, data: TokenType): Construct {
  return {
    name: token,
    previous: (code) => code !== marker,
    tokenize(effects, ok, nok) {
      // Another construct can trigger an attempt despite `previous`. A doubled
      // delimiter must never fall back to a single-marker script with Opt off.
      if (this.previous === marker) return nok
      let escaped = false
      let count = 0
      return start
      function start(code: number | null) {
        effects.enter(token)
        effects.enter(mark)
        effects.consume(code)
        effects.exit(mark)
        return first
      }
      function first(code: number | null) {
        if (code === marker || code === null || code < 0 || code === 32 || code === 9)
          return nok(code)
        effects.enter(data, { contentType: 'text' })
        return body(code)
      }
      function body(code: number | null) {
        if (code === null || code < 0 || ((code === 32 || code === 9) && !escaped)) return nok(code)
        if (!escaped && code === marker) {
          if (!count) return nok(code)
          effects.exit(data)
          effects.enter(mark)
          effects.consume(code)
          effects.exit(mark)
          effects.exit(token)
          return ok
        }
        count++
        effects.consume(code)
        if (escaped) escaped = false
        else if (code === 92) escaped = true
        return body
      }
    },
  }
}

const emoji: Construct = {
  name: 'manuslipEmoji',
  tokenize(effects, ok, nok) {
    let token: Token
    let name = ''
    return start
    function start(code: number | null) {
      token = effects.enter('manuslipEmoji')
      effects.consume(code)
      return body
    }
    function body(code: number | null) {
      if (code === 58 && Object.hasOwn(nameToEmoji, name)) {
        token._manuslipEmojiName = name
        effects.consume(code)
        effects.exit('manuslipEmoji')
        return ok
      }
      if (
        code === null ||
        name.length >= 64 ||
        !(
          (code >= 97 && code <= 122) ||
          (code >= 48 && code <= 57) ||
          code === 95 ||
          code === 43 ||
          code === 45
        )
      )
        return nok(code)
      name += String.fromCharCode(code)
      effects.consume(code)
      return body
    }
  },
}

const syntax: Extension = {
  text: {
    58: emoji,
    94: script(94, 'manuslipSuperscript', 'manuslipSuperscriptMarker', 'manuslipSuperscriptData'),
    126: script(126, 'manuslipSubscript', 'manuslipSubscriptMarker', 'manuslipSubscriptData'),
  },
}
const fromMarkdown: FromMarkdownExtension = {
  enter: {
    manuslipSubscript(token) {
      this.enter({ type: 'subscript', children: [] }, token)
    },
    manuslipSuperscript(token) {
      this.enter({ type: 'superscript', children: [] }, token)
    },
    manuslipEmoji(token) {
      const name = token._manuslipEmojiName
      const value = name && Object.hasOwn(nameToEmoji, name) ? nameToEmoji[name] : undefined
      if (!name || !value) throw new Error('Invalid emoji token')
      this.enter({ type: 'emoji', name, value }, token)
    },
  },
  exit: {
    manuslipSubscript(token) {
      if (/\\[ \t]/.test(this.sliceSerialize(token)))
        normalizeScriptSpaces(this.stack[this.stack.length - 1])
      this.exit(token)
    },
    manuslipSuperscript(token) {
      if (/\\[ \t]/.test(this.sliceSerialize(token)))
        normalizeScriptSpaces(this.stack[this.stack.length - 1])
      this.exit(token)
    },
    manuslipEmoji(token) {
      this.exit(token)
    },
  },
}

function normalizeScriptSpaces(node: CompileContext['stack'][number] | undefined): void {
  if (!node) return
  const pending = [node]
  while (pending.length) {
    const current = pending.pop()
    if (!current) continue
    if (current.type === 'text') current.value = current.value.replace(/\\[ \t]/g, ' ')
    if ('children' in current) pending.push(...current.children)
  }
}

/** Positioned parser constructs shared by native and cooperative Manuslip compilation. */
export const remarkExtendedInline: Plugin = function () {
  const data = this.data()
  data.micromarkExtensions ??= []
  data.fromMarkdownExtensions ??= []
  data.micromarkExtensions.push(syntax)
  data.fromMarkdownExtensions.push(fromMarkdown)
}
