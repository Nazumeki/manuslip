import { describe, expect, it, vi } from 'vitest'
import { sourceHash } from '../../src/contracts'
import { packValue, unpackValue } from '../../src/packing'
import { PackedArena } from '../../src/packing-arena'
import { PackedReader } from '../../src/packing-bytes'
import type { PackedCapture } from '../../src/packing-capture'
import type { PackedOperation } from '../../src/packing-revision'
import type { PackedSerializationLimits, PackedSerializedValue } from '../../src/packing-serialize'
import { PackedSession } from '../../src/packing-session'
import type { PackedValue } from '../../src/packing-value'
import { finishPackedSteps } from '../../src/packing-work'
import { parseMarkdown } from '../../src/parse'

const MiB = 1024 * 1024
const limits = { bytes: 8 * MiB, retained: 32 * MiB, staging: 8 * MiB, captures: 8, readers: 16 }
const serialization: PackedSerializationLimits = {
  bytes: 8 * MiB,
  workspace: 4 * MiB,
  nodes: 1000000,
  depth: 128,
}
const identity = (revision = 0) => ({
  generation: 1,
  documentId: 'serialize',
  revision,
  sourceHash: sourceHash('source'),
  parserVersion: 'test',
  rendererVersion: 'test',
  options: 'test',
})
function fixture(value: unknown) {
  const owner = new PackedSession(limits)
  const ticket = owner.begin(identity(), 'source')
  owner.commit(owner.prepareFull(ticket, identity(), packValue(value, limits.bytes)))
  const capture = owner.capture()
  return { owner, capture }
}
function decoded(value: PackedValue<PackedSerializedValue>): unknown {
  return unpackValue(value.value.payload, {
    bytes: limits.bytes,
    retained: 64 * MiB,
    staging: limits.staging,
  }).value
}
function serialize(
  capture: PackedCapture,
  budget = serialization,
  path: readonly (string | number)[] = [],
) {
  const result = finishPackedSteps(capture.serialize(path, budget))
  if (!result) throw new Error('Incomplete serialization')
  return result
}
const position = (offset: number) => ({
  start: { line: 1, column: offset + 1, offset },
  end: { line: 1, column: offset + 2, offset: offset + 1 },
})

describe('owned packed value serialization', () => {
  it('preserves the complete independent parser result, including all nodes, positions and extension fields', () => {
    const source =
      '# Heading\n\n> > A [reference][r] and *emphasis*.\n\n- [x] Task\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nFootnote[^n].\n\n[^n]: Note.\n\n[r]: /destination "Title"\n'
    const expected = parseMarkdown(source)
    Object.assign(expected.root, {
      extension: JSON.parse('{"__proto__":{"custom":true},"constructor":[null,false,true,-0,1.5]}'),
    })
    const { owner, capture } = fixture({ document: expected })
    let output: PackedValue<PackedSerializedValue> | undefined
    try {
      output = serialize(capture, serialization, ['document'])
      expect(decoded(output)).toEqual(expected)
      expect(output.value.workspaceBytes).toBeLessThanOrEqual(serialization.workspace)
      const bytes = output.value.payload.byteLength
      capture.release()
      owner.evict()
      expect(owner.stats.retainedBytes).toBe(bytes + 1024)
      expect(decoded(output)).toEqual(expected)
      const transferred = structuredClone(output.value.payload, {
        transfer: [output.value.payload],
      })
      expect(output.value.payload.byteLength).toBe(0)
      expect(unpackValue(transferred, limits).value).toEqual(expected)
      output.release()
      expect(owner.stats.retainedBytes).toBe(256)
    } finally {
      output?.release()
      capture.release()
      owner.dispose()
    }
  })

  it.each([null, true, false, 0, -0, 0xffffffff, -1.25, '', [], {}, ['shared', 'shared']])(
    'serializes a complete selected scalar or empty value: %j',
    (expected) => {
      const { owner, capture } = fixture(expected)
      const output = serialize(capture)
      try {
        expect(decoded(output)).toEqual(expected)
      } finally {
        output.release()
        capture.release()
        owner.dispose()
      }
    },
  )

  it('streams every UTF-16 unit and surrogate/escape boundaries without a full scalar read', () => {
    const everyUnit = Array.from({ length: 65536 }, (_, index) => String.fromCharCode(index)).join(
      '',
    )
    const expected = [
      `${'a'.repeat(4095)}😀${everyUnit}${'\\"\n\r\t界'.repeat(12000)}\ud800`,
      `${'界'.repeat(4095)}\udc00\ud800😀`,
    ]
    const { owner, capture } = fixture(expected)
    const read = vi.spyOn(PackedArena.prototype, 'scalar')
    let output: PackedValue<PackedSerializedValue> | undefined
    try {
      output = serialize(capture)
      expect(read).not.toHaveBeenCalled()
      read.mockRestore()
      expect(decoded(output)).toEqual(expected)
    } finally {
      read.mockRestore()
      output?.release()
      capture.release()
      owner.dispose()
    }
  })

  it('serializes lazy text, array, position and range transforms without modifying the previous capture', () => {
    const node = { type: 'text', value: 'same', position: position(2) }
    const block = { from: 2, to: 3, nested: { from: 2, to: 3 }, position: position(2) }
    const text = `${'a'.repeat(4095)}\ud800left${'界😀'.repeat(5000)}`
    const original = {
      nodes: [node, node],
      blocks: [block, block],
      text,
      array: Array.from({ length: 20000 }, (_, i) => i),
    }
    const { owner, capture } = fixture(original)
    let current: PackedCapture | undefined, output: PackedValue<PackedSerializedValue> | undefined
    try {
      const payload = packValue({ text: '\udc00"\\\n', array: [true, false] }, limits.bytes)
      const arena = PackedArena.open(payload.slice(0), limits)
      const textRecord = arena.field(arena.root, 'text'),
        arrayRecord = arena.field(arena.root, 'array')
      if (textRecord === undefined || arrayRecord === undefined)
        throw new Error('Missing delta records')
      const operations: PackedOperation[] = [
        { kind: 'offset', path: ['nodes'], start: 1, offset: 7 },
        { kind: 'range', path: ['blocks'], start: 1, offset: 5 },
        { kind: 'text', path: ['text'], start: 4096, remove: 4, record: textRecord },
        { kind: 'splice', path: ['array'], start: 0, remove: 19999, record: arrayRecord },
      ]
      const ticket = owner.begin(identity(1), 'source')
      owner.commit(
        owner.prepareDelta(ticket, {
          base: identity(),
          baseSource: 'source',
          result: identity(1),
          operations,
          payload,
        }),
      )
      current = owner.capture()
      const expected = {
        nodes: [
          node,
          {
            ...node,
            position: {
              start: { ...node.position.start, offset: 9 },
              end: { ...node.position.end, offset: 10 },
            },
          },
        ],
        blocks: [block, { ...block, from: 7, to: 8 }],
        text: `${text.slice(0, 4096)}\udc00"\\\n${text.slice(4100)}`,
        array: [true, false, 19999],
      }
      output = serialize(current)
      expect(decoded(output)).toEqual(expected)
      const previous = serialize(capture)
      try {
        expect(decoded(previous)).toEqual(original)
      } finally {
        previous.release()
      }
    } finally {
      output?.release()
      current?.release()
      capture.release()
      owner.dispose()
    }
  })

  it.each(['unstarted', 'measurement', 'emission', 'capture-release'] as const)(
    'cancels %s work without retaining a partial buffer or reservations',
    (phase) => {
      const { owner, capture } = fixture({
        items: Array.from({ length: 5000 }, (_, index) => ({ index, text: 'same' })),
      })
      const baseline = owner.stats
      const work = capture.serialize([], serialization)
      try {
        if (phase !== 'unstarted') {
          let suspended = false
          for (let i = 0; i < 100000; i++) {
            const step = work.next()
            if (step.done) throw new Error('Finished before cancellation')
            if (phase === 'emission' ? owner.stats.holds > baseline.holds : i > 30) {
              suspended = true
              break
            }
          }
          expect(suspended).toBe(true)
        }
        if (phase === 'capture-release') capture.release()
        else work.return()
        expect(work.next()).toEqual({ done: true, value: undefined })
        if (phase !== 'capture-release') expect(owner.stats).toEqual(baseline)
        capture.release()
        owner.evict()
        expect(owner.stats.retainedBytes).toBe(256)
        expect(owner.stats.readerStagingBytes).toBe(0)
      } finally {
        work.return()
        capture.release()
        owner.dispose()
      }
    },
  )

  it.each([
    { bytes: 10 },
    { workspace: 65536 },
    { workspace: 340000 },
    { nodes: 1 },
    { depth: 0 },
    { bytes: NaN },
    { depth: 129 },
    { nodes: -1 },
  ])('rejects insufficient or invalid limits before publishing output: %j', (change) => {
    const { owner, capture } = fixture({
      children: Array.from({ length: 8000 }, (_, index) => ({ value: index })),
    })
    const baseline = owner.stats
    try {
      expect(() => serialize(capture, { ...serialization, ...change })).toThrow(/serialization/)
      expect(owner.stats).toEqual(baseline)
    } finally {
      capture.release()
      owner.dispose()
    }
  })

  it('admits the exact output allocation before allocating its buffer', () => {
    const { owner, capture } = fixture(Array.from({ length: 8000 }, (_, index) => ({ index })))
    const measured = serialize(capture)
    const workspace = measured.value.workspaceBytes
    const outputBytes = measured.value.payload.byteLength
    measured.release()
    const block = owner.retain({
      resources: () => [
        {
          key: {},
          bytes:
            limits.retained -
            owner.stats.retainedBytes -
            workspace -
            Math.floor(outputBytes / 2) -
            4096,
        },
      ],
    })
    const baseline = owner.stats
    const allocate = vi.spyOn(globalThis, 'ArrayBuffer')
    try {
      expect(() => serialize(capture)).toThrow('Packed reader scope limit')
      expect(allocate).not.toHaveBeenCalled()
      expect(owner.stats).toEqual(baseline)
    } finally {
      allocate.mockRestore()
      block.release()
      capture.release()
      owner.dispose()
    }
  })

  it('admits actual workspace growth under a large ceiling without reserving the entire ceiling', () => {
    const expected = Array.from({ length: 8000 }, (_, index) => ({ index }))
    const { owner, capture } = fixture(expected)
    const block = owner.retain({
      resources: () => [{ key: {}, bytes: limits.retained - owner.stats.retainedBytes - 2 * MiB }],
    })
    const baseline = owner.stats
    const work = capture.serialize([], { ...serialization, workspace: limits.staging })
    let peak = baseline.retainedBytes
    let output: PackedValue<PackedSerializedValue> | undefined
    try {
      while (true) {
        const step = work.next()
        peak = Math.max(peak, owner.stats.retainedBytes)
        if (step.done) {
          output = step.value
          break
        }
        expect(owner.stats.readerStagingBytes).toBeLessThan(2 * MiB)
      }
      if (!output) throw new Error('Missing dynamically admitted output')
      expect(decoded(output)).toEqual(expected)
      expect(output.value.workspaceBytes).toBeLessThan(MiB)
      expect(peak - baseline.retainedBytes).toBeLessThan(2 * MiB)
      expect(owner.stats.readerStagingBytes).toBe(0)
      output.release()
      expect(owner.stats).toEqual(baseline)
    } finally {
      work.return()
      output?.release()
      block.release()
      capture.release()
      owner.dispose()
    }
  })

  it('binds selected paths and limits before queued work starts', () => {
    const { owner, capture } = fixture({ first: { text: 'correct' }, second: 'wrong' })
    const path = ['first'],
      budget = { ...serialization }
    const work = capture.serialize(path, budget)
    path[0] = 'second'
    budget.bytes = 0
    const output = finishPackedSteps(work)
    try {
      if (!output) throw new Error('Missing output')
      expect(decoded(output)).toEqual({ text: 'correct' })
    } finally {
      output?.release()
      capture.release()
      owner.dispose()
    }
  })

  it('forwards large-array progress and keeps each advance bounded while emitting references', () => {
    const { owner, capture } = fixture(Array.from({ length: 40000 }, (_, index) => index))
    const work = capture.serialize([], serialization)
    const read = vi.spyOn(PackedReader.prototype, 'uint')
    let output: PackedValue<PackedSerializedValue> | undefined
    try {
      let advances = 0
      let peakReads = 0
      while (true) {
        read.mockClear()
        const step = work.next()
        peakReads = Math.max(peakReads, read.mock.calls.length)
        if (step.done) {
          output = step.value
          break
        }
        advances++
      }
      read.mockRestore()
      expect(peakReads).toBeLessThan(1500)
      expect(advances).toBeGreaterThan(80000)
      if (!output) throw new Error('Missing output')
      expect(decoded(output)).toEqual(Array.from({ length: 40000 }, (_, index) => index))
    } finally {
      read.mockRestore()
      work.return()
      output?.release()
      capture.release()
      owner.dispose()
    }
  })
})
