// DOM-only instrumentation: never reads private CodeMirror or React state.
export function installInputAudit() {
  const short = (value) => (typeof value === 'string' ? value.slice(0, 160) : (value ?? null))
  const target = (node) => {
    const element = node instanceof Element ? node : node?.parentElement
    if (!element) return null
    return element.closest('[data-table-cell-editor]')
      ? 'cell'
      : element.closest('.cm-content')
        ? 'source'
        : element.tagName.toLowerCase()
  }
  const selection = () => {
    const value = window.getSelection()
    return value
      ? {
          anchor: value.anchorOffset,
          focus: value.focusOffset,
          collapsed: value.isCollapsed,
          text: short(value.toString()),
          surface: target(value.focusNode),
        }
      : null
  }
  const snapshot = () => ({
    mode: document.querySelector('button[aria-pressed=true][aria-label="Source"]')
      ? 'Source'
      : 'Live Preview',
    visibility: document.visibilityState,
    documentFocus: document.hasFocus(),
    outlineHidden: document.getElementById('workspace-outline')?.hidden ?? null,
    outlineMounted: Boolean(document.querySelector('#workspace-outline .document-outline')),
    text: short(document.querySelector('.cm-content:not([data-table-cell-editor])')?.textContent),
    selection: selection(),
    focus: target(document.activeElement),
    links: [...document.querySelectorAll('.cm-content a[href]')].slice(0, 15).map((a) => ({
      text: short(a.textContent),
      href: a.getAttribute('href'),
    })),
    checks: [...document.querySelectorAll('.cm-content input[type=checkbox]')].map(
      (e) => e.checked,
    ),
    math: document.querySelectorAll('.cm-content [role=math]').length,
    cells: document.querySelectorAll('[data-table-cell-editor]').length,
  })
  let current = null
  const captured = new WeakMap()
  const measures = new PerformanceObserver((list) => {
    if (!current) return
    for (const entry of list.getEntries())
      if (entry.name.startsWith('manuslip:'))
        current.measures.push({
          name: entry.name,
          start: entry.startTime - current.start,
          duration: entry.duration,
          detail: entry.detail,
        })
  })
  measures.observe({ type: 'measure' })
  const longtasks = new PerformanceObserver((list) => {
    if (!current) return
    for (const entry of list.getEntries())
      current.longtasks.push({ start: entry.startTime - current.start, duration: entry.duration })
  })
  longtasks.observe({ type: 'longtask' })
  const mutations = new MutationObserver((records) => {
    if (!current) return
    if (!records.some((r) => target(r.target) === 'source' || target(r.target) === 'cell')) return
    current.mutations.push({ time: performance.now() - current.start, records: records.length })
  })
  mutations.observe(document, { subtree: true, childList: true, characterData: true })
  for (const type of [
    'keydown',
    'keyup',
    'beforeinput',
    'input',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'paste',
    'copy',
    'cut',
    'click',
    'change',
    'selectionchange',
  ])
    document.addEventListener(
      type,
      (event) => {
        const audit = current
        if (!audit) return
        const surface = target(event.target)
        if (!['source', 'cell'].includes(surface) && type !== 'selectionchange') return
        const record = {
          type,
          time: performance.now() - audit.start,
          surface,
          targetTag: event.target instanceof Element ? event.target.tagName.toLowerCase() : null,
          trusted: event.isTrusted,
          cancelable: event.cancelable,
          key: short(event.key),
          code: short(event.code),
          repeat: event.repeat ?? null,
          modifiers: [event.ctrlKey, event.shiftKey, event.altKey, event.metaKey],
          inputType: event.inputType ?? null,
          data: short(event.data),
          composing: event.isComposing ?? null,
          clipboardTypes: event.clipboardData ? [...event.clipboardData.types] : null,
          ranges: event.getTargetRanges
            ? [...event.getTargetRanges()].map((r) => ({
                from: r.startOffset,
                to: r.endOffset,
                sameNode: r.startContainer === r.endContainer,
              }))
            : null,
          selection: selection(),
        }
        captured.set(event, record)
        audit.events.push(record)
        setTimeout(() => {
          record.prevented = event.defaultPrevented
          record.nextTaskMs = performance.now() - audit.start - record.time
        }, 0)
        if (type === 'keydown' && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
          requestAnimationFrame(() => {
            record.firstFrameMs = performance.now() - audit.start - record.time
            requestAnimationFrame(() => {
              record.secondFrameMs = performance.now() - audit.start - record.time
            })
          })
        }
      },
      true,
    )
  for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'paste', 'click', 'change'])
    document.addEventListener(type, (event) => {
      const record = captured.get(event)
      if (record && current) {
        record.bubbleMs = performance.now() - current.start - record.time
        record.preventedAtBubble = event.defaultPrevented
      }
    })
  window.__inputAudit = {
    begin(id) {
      current = {
        id,
        start: performance.now(),
        before: snapshot(),
        events: [],
        measures: [],
        mutations: [],
        longtasks: [],
        checkpoints: [],
      }
    },
    checkpoint(label) {
      current.checkpoints.push({ label, time: performance.now() - current.start, ...snapshot() })
    },
    finish() {
      const result = { ...current, after: snapshot() }
      current = null
      return result
    },
  }
}
