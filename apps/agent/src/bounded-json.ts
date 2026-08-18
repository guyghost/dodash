export const readBoundedJson = async (
  source: { readonly body: ReadableStream<Uint8Array> | null; readonly headers: Headers },
  maxBytes: number,
): Promise<unknown> => {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await source.body?.cancel("payload too large");
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  if (source.body === null) throw new Error("MISSING_BODY");

  const reader = source.body.getReader();
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
        throw new Error("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
};
