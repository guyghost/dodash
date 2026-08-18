export class PayloadTooLargeError extends Error {
  override readonly name = "PayloadTooLargeError";
}

export class InvalidJsonError extends Error {
  override readonly name = "InvalidJsonError";
}

interface BodySource {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: Headers;
}

export const readBoundedJson = async (
  source: BodySource,
  maxBytes: number,
): Promise<unknown> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const declaredLength = source.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await source.body?.cancel("payload exceeds configured limit");
      throw new PayloadTooLargeError("JSON payload exceeds configured limit");
    }
  }

  if (source.body === null) {
    throw new InvalidJsonError("JSON body is missing");
  }

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("payload exceeds configured limit");
        throw new PayloadTooLargeError("JSON payload exceeds configured limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new InvalidJsonError(
      error instanceof Error ? error.message : "Invalid JSON payload",
    );
  }
};
