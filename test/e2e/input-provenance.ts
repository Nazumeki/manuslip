import type { Page, TestInfo } from '@playwright/test'

/** Test-only evidence for unexpected native input. Keep DOM intent separate from
 * accepted parent transactions, and retain it even when an assertion fails.
 */
export async function observeInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const events: Record<string, unknown>[] = []
    Reflect.set(window, '__inputProvenance', events)
    for (const type of [
      'keydown',
      'keyup',
      'beforeinput',
      'input',
      'compositionstart',
      'compositionupdate',
      'compositionend',
    ]) {
      document.addEventListener(
        type,
        (event) => {
          if (!(event.target instanceof Element) || !event.target.closest('.cm-content')) return
          if (events.length >= 512) events.shift()
          events.push({
            type,
            time: performance.now(),
            trusted: event.isTrusted,
            key: event instanceof KeyboardEvent ? event.key : undefined,
            code: event instanceof KeyboardEvent ? event.code : undefined,
            repeat: event instanceof KeyboardEvent ? event.repeat : undefined,
            modifiers:
              event instanceof KeyboardEvent
                ? {
                    ctrl: event.ctrlKey,
                    alt: event.altKey,
                    shift: event.shiftKey,
                    meta: event.metaKey,
                  }
                : undefined,
            data:
              event instanceof InputEvent || event instanceof CompositionEvent
                ? event.data?.slice(0, 64)
                : undefined,
            inputType: event instanceof InputEvent ? event.inputType : undefined,
            composing:
              event instanceof InputEvent || event instanceof KeyboardEvent
                ? event.isComposing
                : undefined,
          })
        },
        true,
      )
    }
  })
}

export async function attachInput(page: Page, info: TestInfo): Promise<void> {
  const evidence = await page
    .evaluate(() => ({
      events: Reflect.get(window, '__inputProvenance'),
      accepted: performance.getEntriesByName('manuslip:input-accepted').map((entry) => ({
        time: entry.startTime,
        duration: entry.duration,
        detail: (entry as PerformanceMeasure).detail,
      })),
    }))
    .catch(() => null)
  await info.attach('input-provenance', {
    body: JSON.stringify(evidence),
    contentType: 'application/json',
  })
}
