// Shared helper: pull a JSON value out of a model response defensively.
// We ask for bare JSON, but strip a stray ```json fence if one appears and
// locate the outermost array or object.

function sliceOutermost(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  // Prefer whichever of [ or { appears first.
  const firstArr = body.indexOf("[");
  const firstObj = body.indexOf("{");
  const preferArray = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj);
  const primary = preferArray
    ? sliceOutermost(body, "[", "]")
    : sliceOutermost(body, "{", "}");
  const fallback = preferArray
    ? sliceOutermost(body, "{", "}")
    : sliceOutermost(body, "[", "]");
  const out = primary ?? fallback;
  if (!out) {
    throw new Error(`No JSON found in model response:\n${text.slice(0, 500)}`);
  }
  return out;
}
