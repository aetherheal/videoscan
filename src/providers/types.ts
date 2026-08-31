// The pipeline only needs one-shot JSON inference: text-only, or text plus
// local image attachments. Keep provider-specific transport details out of the
// callers so either backend can serve the same Layer 4/catalog/notes contracts.

export type JsonSchema = Record<string, unknown>;

export interface SystemPrompt {
  text: string;
  // Layer 4 uses Anthropic prompt caching for its large editorial prompt.
  // This is intentionally optional because the other two existing calls do not.
  cache?: boolean;
}

export interface JsonRequest {
  system: SystemPrompt;
  prompt: string;
  schema: JsonSchema;
  maxTokens: number;
  // The notes call already uses Anthropic's json_schema output format. The
  // other existing Anthropic calls deliberately retain their current prompting
  // behavior and validate JSON locally.
  structuredOutput?: boolean;
}

export interface ImageAttachment {
  path: string;
  // Text that identifies this image in the prompt, such as a scene timestamp.
  label: string;
}

export interface VisionJsonRequest extends JsonRequest {
  images: readonly ImageAttachment[];
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JsonResponse {
  // Call sites retain their tolerant extractJson() parsing and domain-schema
  // validation. The Codex provider normalizes this to the parsed JSON value.
  text: string;
  usage?: ProviderUsage;
  stopReason?: string | null;
  contentBlockTypes?: readonly string[];
}

export interface LlmProvider {
  readonly model: string;

  generateJson(request: JsonRequest): Promise<JsonResponse>;
  generateVisionJson(request: VisionJsonRequest): Promise<JsonResponse>;
}
