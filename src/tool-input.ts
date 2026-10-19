/** Native Codex captures arguments as JSON text; object-based targets need its value. */
export function toolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; }
    catch { /* Preserve non-JSON text as a labeled value. */ }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return value == null ? {} : { value };
}
