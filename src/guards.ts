/** Narrows untrusted input to a plain (non-array) object; its fields remain `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
