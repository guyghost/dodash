export class BodyLimitError extends Error {}

export const readBoundedBody = async (
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  maxBytes: number,
): Promise<Uint8Array> => {
  const declared = Number(declaredLength);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await body?.cancel("payload too large");
    throw new BodyLimitError("PAYLOAD_TOO_LARGE");
  }
  if (body === null) throw new Error("MISSING_BODY");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("payload too large");
        throw new BodyLimitError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};
