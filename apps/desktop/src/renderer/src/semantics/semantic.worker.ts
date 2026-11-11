import {
  BoundedCache,
  parseDocumentMarkdown,
  parserVersion,
  SemanticLimitError,
  semanticLimits,
  sourceHash,
} from '@manuslip/core'
import { rendererVersion } from '@manuslip/renderer'
import {
  absoluteNow,
  type EncodedResponse,
  type EncodedSnapshot,
  type ParseResponse,
  parseRequest,
} from './protocol'
import { encodeSemanticSnapshot } from './snapshot'

const cache = new BoundedCache<string, { source: string; encoded: EncodedSnapshot }>(
  semanticLimits.workerCacheBytes,
)

self.onmessage = (event: MessageEvent<unknown>): void => {
  const arrivedAt = absoluteNow()
  let request: ReturnType<typeof parseRequest>
  try {
    request = parseRequest(event.data)
  } catch {
    throw new Error('Invalid worker input')
  }
  const identity = {
    sequence: request.sequence,
    generation: request.generation,
    documentId: request.documentId,
    revision: request.revision,
  }
  let response: ParseResponse | EncodedResponse
  try {
    const key = `${parserVersion}|${rendererVersion}|${JSON.stringify(request.options)}|${sourceHash(request.source)}`
    const hit = cache.get(key)
    let encoded: EncodedSnapshot
    const cached = hit?.source === request.source
    if (cached) encoded = { ...hit.encoded, payload: hit.encoded.payload.slice(0), serializeMs: 0 }
    else {
      const document = parseDocumentMarkdown(request.source, request.options.plugins)
      try {
        encoded = encodeSemanticSnapshot(document, request.source.length, request.options)
      } catch {
        throw new SemanticLimitError('Semantic result exceeds transport limit')
      }
      const charge = encoded.bytes * 2 + request.source.length * 2
      if (charge <= semanticLimits.workerCacheBytes)
        cache.set(
          key,
          { source: request.source, encoded: { ...encoded, payload: encoded.payload.slice(0) } },
          charge,
        )
    }
    response = {
      ...identity,
      kind: 'encoded-result',
      payload: encoded.payload,
      metadata: {
        bytes: encoded.bytes,
        cached,
        transportInMs: Math.max(0, arrivedAt - request.sentAt),
        serializeMs: encoded.serializeMs,
      },
      sentAt: absoluteNow(),
    }
  } catch (error) {
    response = {
      ...identity,
      kind: 'error',
      code: error instanceof SemanticLimitError ? 'semantic-limit' : 'semantic-parse',
      sentAt: absoluteNow(),
    }
  }
  if (response.kind === 'encoded-result')
    self.postMessage(response, { transfer: [response.payload] })
  else self.postMessage(response)
}
