import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import type {
  ImageAttachment,
  JsonRequest,
  JsonResponse,
  LlmProvider,
  VisionJsonRequest,
} from "./types.js";

function mediaTypeFor(path: string): "image/jpeg" | "image/png" {
  return path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

function outputConfig(request: JsonRequest): Anthropic.Messages.OutputConfig {
  if (request.structuredOutput) {
    return {
      effort: "medium",
      format: { type: "json_schema", schema: request.schema },
    };
  }
  return { effort: "medium" };
}

function systemFor(request: JsonRequest): Anthropic.MessageCreateParams["system"] {
  if (!request.system.cache) return request.system.text;
  return [
    {
      type: "text",
      text: request.system.text,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function responseFor(response: Anthropic.Message): JsonResponse {
  return {
    text: response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join(""),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    stopReason: response.stop_reason,
    contentBlockTypes: response.content.map((block) => block.type),
  };
}

function imageContent(image: ImageAttachment): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaTypeFor(image.path),
      data: readFileSync(image.path).toString("base64"),
    },
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: { apiKey: string; model: string }) {
    this.model = options.model;
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  // The two existing text-only calls stream because their long generations can
  // exceed the SDK's 10-minute non-streaming ceiling.
  async generateJson(request: JsonRequest): Promise<JsonResponse> {
    const response = await this.client.messages
      .stream({
        model: this.model,
        max_tokens: request.maxTokens,
        thinking: { type: "adaptive" },
        output_config: outputConfig(request),
        system: systemFor(request),
        messages: [{ role: "user", content: request.prompt }],
      })
      .finalMessage();

    return responseFor(response);
  }

  // Cataloging was non-streaming before this abstraction; preserve that path.
  async generateVisionJson(request: VisionJsonRequest): Promise<JsonResponse> {
    const content: Anthropic.ContentBlockParam[] = [
      { type: "text", text: request.prompt },
    ];
    for (const image of request.images) {
      content.push({ type: "text", text: image.label });
      content.push(imageContent(image));
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      thinking: { type: "adaptive" },
      output_config: outputConfig(request),
      system: systemFor(request),
      messages: [{ role: "user", content }],
    });

    return responseFor(response);
  }
}
