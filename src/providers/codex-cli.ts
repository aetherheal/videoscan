import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson } from "../claude/json.js";
import type {
  JsonRequest,
  JsonResponse,
  JsonSchema,
  LlmProvider,
  VisionJsonRequest,
} from "./types.js";

const ARRAY_WRAPPER_KEY = "items";
const STDERR_TAIL_LENGTH = 4_000;

interface CommandResult {
  exitCode: number | null;
  stderrTail: string;
  timedOut: boolean;
}

function appendTail(current: string, chunk: Buffer): string {
  return (current + chunk.toString()).slice(-STDERR_TAIL_LENGTH);
}

function errorDetails(model: string, exitCode: number | null, stderrTail: string): string {
  const stderr = stderrTail.trim() || "(no stderr)";
  return `model=${model}, exit_code=${exitCode ?? "unknown"}, stderr_tail=${stderr}`;
}

function isArraySchema(schema: JsonSchema): boolean {
  return schema.type === "array";
}

function cliSchema(schema: JsonSchema): JsonSchema {
  if (!isArraySchema(schema)) return schema;

  // Some structured-output backends require a top-level object. Layer 4's
  // contract is a bare array, so Codex gets an object wrapper and this provider
  // unwraps it before returning to the Layer 4 validator.
  return {
    type: "object",
    properties: { [ARRAY_WRAPPER_KEY]: schema },
    required: [ARRAY_WRAPPER_KEY],
    additionalProperties: false,
  };
}

function cliPrompt(request: JsonRequest, wrapsArray: boolean): string {
  const wrapperInstruction = wrapsArray
    ? `\n\nThe output schema requires an object wrapper. Return the requested JSON array in the \"${ARRAY_WRAPPER_KEY}\" property and no other properties.`
    : "";
  return `${request.system.text}${wrapperInstruction}\n\n${request.prompt}`;
}

async function runCodex(
  model: string,
  timeoutMs: number,
  request: JsonRequest | VisionJsonRequest,
): Promise<JsonResponse> {
  const dir = await mkdtemp(join(tmpdir(), "videoscan-codex-"));
  const schemaPath = join(dir, "schema.json");
  const promptPath = join(dir, "prompt.txt");
  const outputPath = join(dir, "output.json");
  const wrapsArray = isArraySchema(request.schema);

  try {
    const images = "images" in request ? request.images : [];
    const imageLabels = images.map((image, index) => `Image ${index + 1}: ${image.label}`);
    await Promise.all([
      writeFile(schemaPath, JSON.stringify(cliSchema(request.schema))),
      // Codex receives every prompt over stdin so long transcripts never hit
      // Windows' command-line length limit.
      writeFile(
        promptPath,
        `${cliPrompt(request, wrapsArray)}${imageLabels.length ? `\n\n${imageLabels.join("\n")}` : ""}`,
      ),
    ]);

    const args = [
      "exec",
      "-m",
      model,
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--output-schema",
      schemaPath,
      ...images.flatMap((image) => ["-i", image.path]),
      "-o",
      outputPath,
      "-",
    ];
    const result = await new Promise<CommandResult>((resolve, reject) => {
      // npm exposes Codex as codex.cmd on Windows; cmd.exe is required to run
      // that shim while Unix installations can execute codex directly.
      const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "codex";
      const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "codex.cmd", ...args] : args;
      const child = spawn(command, commandArgs, { stdio: ["pipe", "ignore", "pipe"] });
      let stderrTail = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = appendTail(stderrTail, chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Codex CLI could not start (${errorDetails(model, null, stderrTail)}): ${String(error)}`,
          ),
        );
      });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        resolve({ exitCode, stderrTail, timedOut });
      });

      const promptStream = createReadStream(promptPath);
      promptStream.once("error", (error) => {
        child.kill();
        reject(
          new Error(
            `Codex CLI could not read its prompt (${errorDetails(model, null, stderrTail)}): ${String(error)}`,
          ),
        );
      });
      promptStream.pipe(child.stdin);
    });

    if (result.timedOut) {
      throw new Error(
        `Codex CLI timed out after ${timeoutMs}ms (${errorDetails(model, result.exitCode, result.stderrTail)})`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(`Codex CLI failed (${errorDetails(model, result.exitCode, result.stderrTail)})`);
    }

    let output: string;
    try {
      output = await readFile(outputPath, "utf8");
    } catch (error) {
      throw new Error(
        `Codex CLI did not write an output file (${errorDetails(model, result.exitCode, result.stderrTail)}): ${String(error)}`,
      );
    }
    if (!output.trim()) {
      throw new Error(`Codex CLI wrote empty output (${errorDetails(model, result.exitCode, result.stderrTail)})`);
    }

    try {
      const parsed: unknown = JSON.parse(extractJson(output));
      if (wrapsArray) {
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !Array.isArray((parsed as Record<string, unknown>)[ARRAY_WRAPPER_KEY])
        ) {
          throw new Error(`missing ${ARRAY_WRAPPER_KEY} array wrapper`);
        }
        return { text: JSON.stringify((parsed as Record<string, unknown>)[ARRAY_WRAPPER_KEY]) };
      }
      return { text: JSON.stringify(parsed) };
    } catch (error) {
      throw new Error(
        `Codex CLI returned unparseable JSON (${errorDetails(model, result.exitCode, result.stderrTail)}): ${String(error)}`,
      );
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`Codex CLI failed (model=${model}): ${String(error)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class CodexCliProvider implements LlmProvider {
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: { model: string; timeoutMs: number }) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
  }

  async generateJson(request: JsonRequest): Promise<JsonResponse> {
    return runCodex(this.model, this.timeoutMs, request);
  }

  async generateVisionJson(request: VisionJsonRequest): Promise<JsonResponse> {
    return runCodex(this.model, this.timeoutMs, request);
  }
}
