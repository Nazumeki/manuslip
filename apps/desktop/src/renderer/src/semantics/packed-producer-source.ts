import { parserVersion } from '@manuslip/core'
import { rendererVersion } from '@manuslip/renderer'
import { readPackedRequestMetadata } from '../../../../../../packages/core/src/packing-exchange'
import {
  type PackedSource,
  packedSourceSteps,
  sameIdentity,
} from '../../../../../../packages/core/src/packing-source'
import { PackedWork } from '../../../../../../packages/core/src/packing-work'
import { capturePackedRequest } from './packed-request-source'
import { absoluteNow, type ParseRequest } from './protocol'

const completed = new WeakSet<object>()
export interface PreparedProducerSource {
  readonly request: Readonly<ParseRequest>
  readonly source: PackedSource
  readonly checked: ReturnType<typeof readPackedRequestMetadata>
  readonly transportInMs: number
}
export function isPreparedProducerSource(value: unknown): value is PreparedProducerSource {
  return typeof value === 'object' && value !== null && completed.has(value)
}
export interface ProducerSourceWork extends PackedWork<PreparedProducerSource> {
  readonly retainedBytes: number
}
/** Internal structured-clone entry. All fields are immutable before yielding; the source
 * digest and byte cap are independently scanned in this isolate. Neither the renderer's
 * claimed hash nor its local capability can grant a prepared Worker request.
 * Legacy producer.prepare keeps its existing synchronous validation contract.
 */
export function producerSourceSteps(input: unknown, exchange: unknown): ProducerSourceWork {
  const { request, jsonByteLimit } = capturePackedRequest(input)
  const options = request.options
  const checked = readPackedRequestMetadata(exchange)
  const identity = {
    generation: request.generation,
    documentId: request.documentId,
    revision: request.revision,
    parserVersion: `${parserVersion}/manuslip`,
    rendererVersion,
    options: JSON.stringify(options),
  }
  if (
    !sameIdentity(
      { ...identity, sourceHash: checked.value.identity.sourceHash },
      checked.value.identity,
    )
  )
    throw new Error('Packed request source mismatch')
  if (checked.value.sequence !== request.sequence)
    throw new Error('Packed producer sequence mismatch')
  const scan = packedSourceSteps(identity, request.source, jsonByteLimit)
  const transportInMs = Math.max(0, absoluteNow() - request.sentAt)
  const work = new PackedWork(
    (function* () {
      const source = yield* scan
      if (!source || !sameIdentity(source.identity, checked.value.identity))
        throw new Error('Packed request source mismatch')
      const result = Object.freeze({ request, source, checked, transportInMs })
      completed.add(result)
      return result
    })(),
    () => scan.return(),
  )
  // Covers the scan's source/snapshot plus exchange, request, options and scheduling state.
  Object.defineProperty(work, 'retainedBytes', {
    value: scan.retainedBytes + checked.retainedBytes + 8192,
    enumerable: true,
  })
  return Object.freeze(work) as ProducerSourceWork
}
