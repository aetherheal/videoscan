// Minimal structured logger. Scripts are human-facing CLI tools, so plain
// stderr output is fine — no pino dependency for a pipeline this small.
type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields): void {
  const prefix = `[${level}]`;
  if (fields && Object.keys(fields).length > 0) {
    console.error(prefix, msg, fields);
  } else {
    console.error(prefix, msg);
  }
}

export const logger = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
