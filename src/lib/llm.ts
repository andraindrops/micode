import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";

const DEFAULT_MODEL = "openai/gpt-4o-mini";

export type SendResult = {
  text: string;
  reasoningText: string | undefined;
  responseMessages: ModelMessage[];
};

export type SendOptions = {
  apiKey?: string;
  maxRetries?: number;
  messages?: ModelMessage[];
  model?: LanguageModel;
  onReasoningDelta?: (delta: string) => void;
  onToolCall?: (event: { toolName: string; args: unknown }) => void;
  onToolResult?: (event: { toolName: string; result: unknown }) => void;
  prompt?: string;
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
  system?: string;
  temperature?: number;
  tools?: ToolSet;
};

export async function send({
  apiKey,
  maxRetries,
  messages,
  model,
  onReasoningDelta,
  onToolCall,
  onToolResult,
  prompt,
  stopWhen,
  system,
  temperature,
  tools,
}: SendOptions): Promise<SendResult> {
  const resolvedModel = model ?? getDefaultModel({ apiKey });
  const input = messages ? { messages } : { prompt: prompt ?? "" };

  if (onReasoningDelta == null) {
    return generateResult({
      ...input,
      maxRetries,
      model: resolvedModel,
      onToolCall,
      onToolResult,
      stopWhen,
      system,
      temperature,
      tools,
    });
  }

  const result = streamText({
    ...input,
    maxRetries,
    model: resolvedModel,
    system,
    onChunk({ chunk }) {
      if (chunk.type === "reasoning-delta") {
        onReasoningDelta(chunk.text);
      }
      if (chunk.type === "tool-call" && onToolCall) {
        onToolCall({ toolName: chunk.toolName, args: chunk.input });
      }
      if (chunk.type === "tool-result" && onToolResult) {
        onToolResult({ toolName: chunk.toolName, result: chunk.output });
      }
    },
    stopWhen: stopWhen ?? stepCountIs(10),
    temperature,
    tools,
  });

  const [reasoningText, text, response] = await Promise.all([
    result.reasoningText,
    result.text,
    result.response,
  ]);

  return {
    text,
    reasoningText,
    responseMessages: response.messages,
  };
}

async function generateResult({
  maxRetries,
  messages,
  model,
  onToolCall,
  onToolResult,
  prompt,
  stopWhen,
  system,
  temperature,
  tools,
}: {
  maxRetries?: number;
  messages?: ModelMessage[];
  model: LanguageModel;
  onToolCall?: (event: { toolName: string; args: unknown }) => void;
  onToolResult?: (event: { toolName: string; result: unknown }) => void;
  prompt?: string;
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
  system?: string;
  temperature?: number;
  tools?: ToolSet;
}): Promise<SendResult> {
  const input = messages ? { messages } : { prompt: prompt ?? "" };
  const { reasoningText, response, text } = await generateText({
    ...input,
    maxRetries,
    model,
    system,
    onStepFinish({ toolCalls, toolResults }) {
      if (onToolCall) {
        for (const tc of toolCalls) {
          onToolCall({ toolName: tc.toolName, args: tc.input });
        }
      }
      if (onToolResult) {
        for (const tr of toolResults) {
          onToolResult({ toolName: tr.toolName, result: tr.output });
        }
      }
    },
    stopWhen: stopWhen ?? stepCountIs(10),
    temperature,
    tools,
  });

  return {
    text,
    reasoningText,
    responseMessages: response.messages,
  };
}

function getDefaultModel({ apiKey }: { apiKey?: string }): LanguageModel {
  const openrouter = createOpenRouter({ apiKey: getApiKey({ apiKey }) });

  return openrouter.chat(DEFAULT_MODEL);
}

function getApiKey({
  apiKey = process.env.OPENROUTER_API_KEY,
}: {
  apiKey?: string;
}): string {
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set.\n\n" +
        "Get your API key at https://openrouter.ai/keys and run:\n\n" +
        "  export OPENROUTER_API_KEY=your-key-here\n" +
        "  npx micoli\n",
    );
  }

  return apiKey;
}
