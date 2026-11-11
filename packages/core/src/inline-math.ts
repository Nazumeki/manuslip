import type { Construct, State } from 'micromark-util-types'
import type { Plugin } from 'unified'

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    mathText: 'mathText'
    mathTextSequence: 'mathTextSequence'
    mathTextData: 'mathTextData'
  }
}

/** Typora's default dollar boundaries, retaining the pinned math compiler and
 * display-math grammar. Escaped dollars remain TeX source inside the span.
 */
export const remarkInlineMath: Plugin = function () {
  const data = this.data()
  data.micromarkExtensions = data.micromarkExtensions?.map((extension) => {
    const dollar = extension.text?.[36]
    if (!dollar) return extension
    const constructs = (Array.isArray(dollar) ? dollar : [dollar]).map((construct): Construct => {
      if (construct.name !== 'mathText') return construct
      return {
        ...construct,
        tokenize(effects, ok, nok) {
          let previous = 0
          const native = construct.tokenize.call(this, effects, ok, nok)
          return effects.check(doubleDollar, native, single)

          function single(code: number | null) {
            effects.enter('mathText')
            effects.enter('mathTextSequence')
            effects.consume(code)
            effects.exit('mathTextSequence')
            return first
          }
          function first(code: number | null): State | undefined {
            if (code === null || whitespace(code)) return nok(code)
            effects.enter('mathTextData')
            return body(code)
          }
          function body(code: number | null): State | undefined {
            if (code === null) return nok(code)
            if (code === 36 && previous !== 92) {
              if (whitespace(previous)) return nok(code)
              effects.exit('mathTextData')
              effects.enter('mathTextSequence')
              effects.consume(code)
              effects.exit('mathTextSequence')
              effects.exit('mathText')
              return after
            }
            previous = code
            effects.consume(code)
            return body
          }
          function after(code: number | null) {
            return code !== null && code >= 48 && code <= 57 ? nok(code) : ok(code)
          }
        },
      }
    })
    return { ...extension, text: { ...extension.text, 36: constructs } }
  })
}

function whitespace(code: number): boolean {
  return code < 0 || /\s/u.test(String.fromCharCode(code))
}

const doubleDollar: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return first
    function first(code: number | null) {
      effects.enter('mathTextSequence')
      effects.consume(code)
      effects.exit('mathTextSequence')
      return second
    }
    function second(code: number | null) {
      return code === 36 ? ok(code) : nok(code)
    }
  },
}
