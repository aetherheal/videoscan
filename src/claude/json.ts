// Shared helper: pull a JSON value out of a model response defensively.
// We ask for bare JSON, but a response may arrive fenced (```json), wrapped in
// stray prose, or — crucially — contain `[`/`{`/`}` characters INSIDE string
// values (the summarizer is told to bracket uncertain terms, e.g. "[lacing?]").
// A naive "slice from first bracket to last" mis-handles that, so we scan with
// string/escape awareness and return the first balanced top-level value.

export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();

  // Fast path: the whole body is already valid JSON (the structured-output and
  // well-behaved cases). Returning it untouched avoids any mis-slicing.
  try {
    JSON.parse(body);
    return body;
  } catch {
    // fall through to scan for an embedded JSON value
  }

  // Start at whichever of [ or { appears first.
  const a = body.indexOf("[");
  const o = body.indexOf("{");
  const start = a === -1 ? o : o === -1 ? a : Math.min(a, o);
  if (start === -1) {
    throw new Error(`No JSON found in model response:\n${text.slice(0, 500)}`);
  }

  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return body.slice(start, i + 1);
  }

  // Reached the end without the structure closing — almost always a response
  // truncated by max_tokens. Surface that clearly instead of a cryptic parse error.
  throw new Error(
    `Truncated or unbalanced JSON in model response (no closing '${close}'):\n` +
      text.slice(0, 300),
  );
}
