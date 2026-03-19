import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { send } from "./llm";

describe("send", () => {
  it("sends the prompt to the model", async () => {
    const generateResult: LanguageModelV3GenerateResult = {
      content: [{ type: "text", text: "Hello! How can I assist you today?" }],
      finishReason: {
        unified: "stop",
        raw: "stop",
      },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 2,
          text: 2,
          reasoning: 0,
        },
      },
      warnings: [],
    };

    const model = new MockLanguageModelV3({
      doGenerate: async () => generateResult,
    });

    const result = await send({ model, prompt: "hello" });

    expect(result.text).toBe("Hello! How can I assist you today?");
    expect(result.reasoningText).toBeUndefined();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.prompt).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("returns reasoningText when the model provides reasoning", async () => {
    const generateResult: LanguageModelV3GenerateResult = {
      content: [
        { type: "reasoning", text: "first think" },
        { type: "text", text: "final answer" },
      ],
      finishReason: {
        unified: "stop",
        raw: "stop",
      },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 2,
          text: 1,
          reasoning: 1,
        },
      },
      warnings: [],
    };

    const model = new MockLanguageModelV3({
      doGenerate: async () => generateResult,
    });

    const result = await send({ model, prompt: "hello" });

    expect(result.text).toBe("final answer");
    expect(result.reasoningText).toBe("first think");
  });

  it("streams reasoning deltas in real time", async () => {
    const model = new MockLanguageModelV3({
      doStream: {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "reasoning-start",
              id: "r1",
            });
            controller.enqueue({
              type: "reasoning-delta",
              id: "r1",
              delta: "first think",
            });
            controller.enqueue({
              type: "reasoning-end",
              id: "r1",
            });
            controller.enqueue({
              type: "text-start",
              id: "t1",
            });
            controller.enqueue({
              type: "text-delta",
              id: "t1",
              delta: "final answer",
            });
            controller.enqueue({
              type: "text-end",
              id: "t1",
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: {
                  total: 2,
                  text: 1,
                  reasoning: 1,
                },
              },
            });
            controller.close();
          },
        }),
      },
    });
    const deltas: string[] = [];

    const result = await send({
      model,
      onReasoningDelta: (delta) => deltas.push(delta),
      prompt: "hello",
    });

    expect(deltas).toEqual(["first think"]);
    expect(result.reasoningText).toBe("first think");
  });

  it("passes tools to the model call", async () => {
    const generateResult: LanguageModelV3GenerateResult = {
      content: [{ type: "text", text: "tool ready" }],
      finishReason: {
        unified: "stop",
        raw: "stop",
      },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 2,
          text: 2,
          reasoning: 0,
        },
      },
      warnings: [],
    };

    const model = new MockLanguageModelV3({
      doGenerate: async () => generateResult,
    });
    const tools = {
      echo: tool({
        description: "Echoes the provided text.",
        inputSchema: jsonSchema<{ value: string }>({
          type: "object",
          properties: {
            value: {
              type: "string",
            },
          },
          required: ["value"],
          additionalProperties: false,
        }),
        execute: async ({ value }) => ({ value }),
      }),
    };

    await send({ model, prompt: "hello", tools });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.tools).toEqual([
      expect.objectContaining({
        name: "echo",
      }),
    ]);
  });

  it("supports multi-step tool execution", async () => {
    let step = 0;

    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;

        if (step === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "echo",
                input: JSON.stringify({ value: "step one" }),
              },
            ],
            finishReason: {
              unified: "tool-calls",
              raw: "tool-calls",
            },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: {
                total: 1,
                text: 0,
                reasoning: 0,
              },
            },
            warnings: [],
          } satisfies LanguageModelV3GenerateResult;
        }

        return {
          content: [{ type: "text", text: "done" }],
          finishReason: {
            unified: "stop",
            raw: "stop",
          },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: {
              total: 1,
              text: 1,
              reasoning: 0,
            },
          },
          warnings: [],
        } satisfies LanguageModelV3GenerateResult;
      },
    });
    const tools = {
      echo: tool({
        description: "Echoes the provided text.",
        inputSchema: jsonSchema<{ value: string }>({
          type: "object",
          properties: {
            value: {
              type: "string",
            },
          },
          required: ["value"],
          additionalProperties: false,
        }),
        execute: async ({ value }) => ({ value }),
      }),
    };

    const result = await send({
      model,
      prompt: "hello",
      stopWhen: stepCountIs(5),
      tools,
    });

    expect(result.text).toBe("done");
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});
