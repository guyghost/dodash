export const constantTimeEqual = (left: string, right: string): boolean => {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
};

export const hasValidBearerToken = (
  authorization: string | null,
  expected: unknown,
): boolean => {
  const supplied = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return (
    supplied !== undefined &&
    typeof expected === "string" &&
    expected.length >= 32 &&
    constantTimeEqual(supplied, expected)
  );
};
