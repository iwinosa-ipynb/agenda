import type { ZodError } from "zod";

/**
 * Normalise a Zod error into `{ fieldName: [messages] }` so server actions can
 * return errors the UI can attach to individual inputs.
 */
export function flattenFieldErrors(
  error: ZodError,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form";
    (result[key] ??= []).push(issue.message);
  }

  return result;
}
