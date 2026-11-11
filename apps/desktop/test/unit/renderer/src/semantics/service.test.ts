import { parseMarkdown, semanticLimits } from '@manuslip/core'
import { renderMarkdown } from '@manuslip/renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ParseRequest,
  ParseResponse,
} from '../../../../../src/renderer/src/semantics/protocol'
import {
  type SemanticEvent,
  SemanticService,
  type WorkerPort,
} from '../../../../../src/renderer/src/semantics/service'

const options = { rawHtml: false, footnotesLabel: 'Footnotes', footnoteBackLabel: 'Back' }
class FakeWorker implements WorkerPort {
  messages: ParseRequest[] = []
  receive: (value: unknown) => void = () => {}
  fail: () => void = () => {}
  terminated = false
  onMessage(listener: (value: unknown) => void): void {
    this.receive = listener
  }
  onFailure(listener: () => void): void {
    this.fail = listener
  }
  post(request: ParseRequest): void {
    this.messages.push(request)
  }
  terminate(): void {
    this.terminated = true
  }
  finish(index = 0, clockOffset = 0): void {
    const request = this.messages[index]
    if (!request) throw new Error('No running request')
    const document = parseMarkdown(request.source)
    const projection = renderMarkdown(document.root, request.options)
    this.receive({
      kind: 'result',
      sequence: request.sequence,
      generation: request.generation,
      documentId: request.documentId,
      revision: request.revision,
      sentAt: performance.timeOrigin + performance.now() + clockOffset,
      snapshot: {
        document,
        projection,
        bytes: 100,
        cached: false,
        transportInMs: 0,
        serializeMs: 0,
      },
    } satisfies ParseResponse)
  }
}
afterEach(() => {
  vi.useRealTimers()
})
describe('window semantic scheduling', () => {
  it('reports a nonnegative transport delay when worker clocks round ahead', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker(),
      events: SemanticEvent[] = []
    const service = new SemanticService(() => worker)
    const connection = service.connect('rounded-clock', (event) => events.push(event))
    try {
      connection.request(1, () => 'source', options)
      await vi.advanceTimersByTimeAsync(semanticLimits.debounce)
      worker.finish(0, 0.125)
      expect(events.at(-1)).toMatchObject({ kind: 'snapshot', transportOutMs: 0 })
    } finally {
      service.dispose()
    }
  })
  it('coalesces completion input within a frame while keeping ordinary input debounced', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const service = new SemanticService(() => worker)
    const connection = service.connect('completion', () => {})
    try {
      connection.request(1, () => 'ordinary', options)
      await vi.advanceTimersByTimeAsync(16)
      expect(worker.messages).toHaveLength(0)
      connection.request(2, () => '$x$', options, true)
      await vi.advanceTimersByTimeAsync(8)
      connection.request(3, () => '$y$', options, true)
      await vi.advanceTimersByTimeAsync(15)
      expect(worker.messages).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(worker.messages.map((message) => message.revision)).toEqual([3])
      connection.request(4, () => '**done**', options, true)
      await vi.advanceTimersByTimeAsync(16)
      expect(worker.messages).toHaveLength(1)
      worker.finish()
      expect(worker.messages.map((message) => message.revision)).toEqual([3, 4])
    } finally {
      service.dispose()
    }
  })

  it('carries the original request clock through a delayed native response', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker(),
      events: SemanticEvent[] = [],
      service = new SemanticService(() => worker),
      connection = service.connect('private filename.md', (event) => events.push(event))
    try {
      connection.request(4, () => '# Complete source', options)
      await vi.advanceTimersByTimeAsync(semanticLimits.debounce)
      const request = worker.messages[0]
      if (!request) throw new Error('No posted request')
      await vi.advanceTimersByTimeAsync(230)
      worker.finish()
      const event = events.at(-1)
      expect(event).toMatchObject({
        kind: 'snapshot',
        sequence: request.sequence,
        revision: request.revision,
        requestSentAt: request.sentAt,
      })
      expect(event).not.toHaveProperty('source')
      expect(event).not.toHaveProperty('documentId')
    } finally {
      connection.dispose()
      service.dispose()
    }
  })

  it.each(['request', 'retry', 'failure'] as const)(
    'preserves work started by %s inside a throwing snapshot consumer',
    async (action) => {
      vi.useFakeTimers()
      const workers: FakeWorker[] = []
      const service = new SemanticService(() => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker
      })
      let thrown = false
      const notify = vi.fn((event: SemanticEvent) => {
        if (event.kind !== 'snapshot' || thrown) return
        thrown = true
        if (action !== 'failure') {
          connection.request(2, () => 'newest source', options)
          if (action === 'retry') connection.retry()
        } else workers[0]?.fail()
        throw new Error('Consumer failed after starting new work')
      })
      const connection = service.connect('one', notify)
      try {
        connection.request(1, () => 'first source', options)
        await vi.advanceTimersByTimeAsync(semanticLimits.debounce)
        workers[0]?.finish()
        expect(workers).toHaveLength(action === 'failure' ? 2 : 1)
        const active = workers.at(-1)
        expect(active?.terminated).toBe(false)
        if (action === 'request') {
          expect(active?.messages).toHaveLength(1)
          await vi.advanceTimersByTimeAsync(semanticLimits.debounce)
        }
        expect(active?.messages.at(-1)?.sequence).toBe(2)
        active?.finish(action === 'failure' ? 0 : 1)
        expect(notify).toHaveBeenLastCalledWith(
          expect.objectContaining({ kind: 'snapshot', revision: action === 'failure' ? 1 : 2 }),
        )
        await vi.advanceTimersByTimeAsync(semanticLimits.watchdog)
        expect(active?.terminated).toBe(false)
        expect(workers).toHaveLength(action === 'failure' ? 2 : 1)
      } finally {
        service.dispose()
      }
    },
  )

  it.each(['snapshot', 'error'] as const)(
    'keeps a healthy worker and its restart allowance after throwing %s consumers',
    async (kind) => {
      vi.useFakeTimers()
      const workers: FakeWorker[] = []
      const service = new SemanticService(() => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker
      })
      const notify = vi.fn((event: SemanticEvent) => {
        if (event.kind === kind && (event.kind !== 'error' || event.code === 'semantic-limit'))
          throw new Error('Consumer failed')
      })
      const connection = service.connect('one', notify)
      try {
        for (let revision = 0; revision <= semanticLimits.restarts; revision++) {
          connection.request(revision, () => 'retained source', options)
          await vi.advanceTimersByTimeAsync(semanticLimits.debounce)
          const worker = workers[0],
            request = worker?.messages.at(-1)
          if (!worker || !request) throw new Error('Missing running request')
          if (kind === 'snapshot') worker.finish(revision)
          else worker.receive({ ...request, kind: 'error', code: 'semantic-limit' })
          expect(workers).toHaveLength(1)
          expect(worker.terminated).toBe(false)
        }
        // Genuine transport failures still receive the full, unchanged restart allowance.
        for (let index = 0; index <= semanticLimits.restarts; index++) workers[index]?.fail()
        expect(workers).toHaveLength(semanticLimits.restarts + 1)
        expect(workers.every((worker) => worker.terminated)).toBe(true)
        expect(notify).toHaveBeenLastCalledWith({
          kind: 'error',
          code: 'semantic-worker',
          paused: true,
        })
      } finally {
        service.dispose()
      }
    },
  )

  it.each([1, semanticLimits.restarts])(
    'keeps the replacement alive after %s ports report failure and then throw from post',
    async (failures) => {
      vi.useFakeTimers()
      class ReportingWorker extends FakeWorker {
        override post(request: ParseRequest): void {
          super.post(request)
          this.fail()
          throw new Error('Post failed after reporting transport failure')
        }
      }
      const workers: FakeWorker[] = []
      const service = new SemanticService(() => {
        const worker = workers.length < failures ? new ReportingWorker() : new FakeWorker()
        workers.push(worker)
        return worker
      })
      const notify = vi.fn()
      const connection = service.connect('one', notify)
      try {
        connection.request(1, () => 'retained source', options)
        await vi.advanceTimersByTimeAsync(semanticLimits.debounce)
        expect(workers).toHaveLength(failures + 1)
        expect(workers.slice(0, failures).every((worker) => worker.terminated)).toBe(true)
        const replacement = workers[failures]
        expect(replacement?.terminated).toBe(false)
        expect(replacement?.messages.map((request) => request.sequence)).toEqual([failures + 1])
        replacement?.finish()
        expect(notify).toHaveBeenLastCalledWith(
          expect.objectContaining({ kind: 'snapshot', revision: 1 }),
        )
        await vi.advanceTimersByTimeAsync(semanticLimits.watchdog)
        expect(workers).toHaveLength(failures + 1)
        expect(replacement?.terminated).toBe(false)
      } finally {
        service.dispose()
      }
    },
  )

  it.each(['message', 'failure'] as const)(
    'does not send a stale request after synchronous %s registration failure',
    async (registration) => {
      vi.useFakeTimers()
      class ReportingWorker extends FakeWorker {
        override onMessage(listener: (value: unknown) => void): void {
          super.onMessage(listener)
          if (registration === 'message') listener(null)
        }
        override onFailure(listener: () => void): void {
          super.onFailure(listener)
          if (registration === 'failure') listener()
        }
      }
      const workers: FakeWorker[] = []
      const service = new SemanticService(() => {
        const worker = workers.length ? new FakeWorker() : new ReportingWorker()
        workers.push(worker)
        return worker
      })
      const notify = vi.fn()
      const connection = service.connect('one', notify)
      try {
        connection.request(1, () => 'retained source', options)
        await vi.advanceTimersByTimeAsync(semanticLimits.debounce)
        expect(workers).toHaveLength(2)
        expect(workers[0]?.messages).toEqual([])
        expect(workers[1]?.messages.map((request) => request.sequence)).toEqual([2])
        workers[1]?.finish()
        expect(notify).toHaveBeenLastCalledWith(
          expect.objectContaining({ kind: 'snapshot', revision: 1 }),
        )
        await vi.advanceTimersByTimeAsync(semanticLimits.watchdog)
        expect(workers).toHaveLength(2)
        expect(workers[1]?.terminated).toBe(false)
      } finally {
        service.dispose()
      }
    },
  )

  it('debounces without materializing source on every edit and replaces pending work', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const service = new SemanticService(() => worker)
    const notify = vi.fn()
    const connection = service.connect('one', notify)
    const first = vi.fn(() => 'first')
    connection.request(1, first, options)
    await vi.advanceTimersByTimeAsync(100)
    const second = vi.fn(() => 'newest')
    connection.request(2, second, options)
    await vi.advanceTimersByTimeAsync(150)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    expect(worker.messages.map((request) => request.revision)).toEqual([2])
    connection.request(3, () => 'discarded pending', options)
    connection.request(4, () => 'latest pending', options)
    await vi.advanceTimersByTimeAsync(150)
    expect(worker.messages).toHaveLength(1)
    worker.finish()
    expect(notify.mock.calls.some(([event]) => event.kind === 'snapshot')).toBe(false)
    expect(worker.messages.map((request) => request.revision)).toEqual([2, 4])
    worker.finish(1)
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'snapshot', revision: 4 }),
    )
    service.dispose()
  })
  it('publishes continuous typing within one second and ignores disposed generations', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const service = new SemanticService(() => worker)
    const notify = vi.fn()
    const connection = service.connect('one', notify)
    for (let revision = 0; revision < 10; revision++) {
      connection.request(revision, () => String(revision), options)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]?.revision).toBe(9)
    connection.dispose()
    const next = vi.fn()
    const replacement = service.connect('one', next)
    replacement.request(10, () => 'reopened', options)
    await vi.advanceTimersByTimeAsync(150)
    worker.finish()
    expect(next.mock.calls.some(([event]) => event.kind === 'snapshot')).toBe(false)
    worker.finish(1)
    expect(next).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'snapshot', revision: 10 }),
    )
    service.dispose()
  })
  it('guards same-revision configuration changes as well as document revisions', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const service = new SemanticService(() => worker)
    const notify = vi.fn()
    const connection = service.connect('one', notify)
    connection.request(1, () => '<b>raw</b>', options)
    await vi.advanceTimersByTimeAsync(150)
    connection.request(1, () => '<b>raw</b>', { ...options, rawHtml: true })
    await vi.advanceTimersByTimeAsync(150)
    worker.finish()
    expect(notify.mock.calls.some(([event]) => event.kind === 'snapshot')).toBe(false)
    worker.finish(1)
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'snapshot', revision: 1 }),
    )
    service.dispose()
  })
  it('terminates hung workers, limits automatic restarts, and allows explicit retry', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const service = new SemanticService(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })
    const notify = vi.fn()
    const connection = service.connect('one', notify)
    connection.request(1, () => 'retained source', options)
    await vi.advanceTimersByTimeAsync(150 + semanticLimits.watchdog * 4)
    expect(workers).toHaveLength(4)
    expect(workers.every((worker) => worker.terminated)).toBe(true)
    expect(notify).toHaveBeenLastCalledWith({
      kind: 'error',
      code: 'semantic-worker',
      paused: true,
    })
    connection.retry()
    expect(workers).toHaveLength(5)
    workers[4]?.finish()
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'snapshot' }))
    service.dispose()
  })
})
