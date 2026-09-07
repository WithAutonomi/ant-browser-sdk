/** Snapshot JSON-like protocol metadata without exposing live internal state. */
export function snapshot<T>(value: T): T {
  return freeze(structuredClone(value));
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
