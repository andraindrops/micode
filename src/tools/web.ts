import { jsonSchema, type ToolSet, tool } from "ai";

export type FetchPageInput = {
  url: string;
  maxLength?: number;
  headers?: Record<string, string>;
};

export async function fetchPage({
  url,
  maxLength = 50000,
  headers,
}: FetchPageInput): Promise<{
  url: string;
  status: number;
  contentType: string;
  truncated: boolean;
  content: string;
}> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("URL must start with http:// or https://");
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": "micoli/1.0",
      Accept: "text/html,application/xhtml+xml,text/plain,application/json",
      ...headers,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  const contentType = response.headers.get("content-type") ?? "";

  const text = await response.text();
  const truncated = text.length > maxLength;
  const content = truncated ? text.slice(0, maxLength) : text;

  return {
    url: response.url,
    status: response.status,
    contentType,
    truncated,
    content,
  };
}

const fetchPageInputSchema = jsonSchema<FetchPageInput>({
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "URL to fetch. Must start with http:// or https://.",
    },
    maxLength: {
      type: "integer",
      description: "Maximum character length of the returned content.",
      minimum: 1,
      default: 50000,
    },
    headers: {
      type: "object",
      description: "Additional HTTP headers to send with the request.",
      additionalProperties: { type: "string" },
    },
  },
  required: ["url"],
  additionalProperties: false,
});

export function createWebTools(): ToolSet {
  return {
    fetchPage: tool({
      description:
        "Fetch a web page and return its content as text. Supports HTML, JSON, and plain text.",
      inputSchema: fetchPageInputSchema,
      execute: async (input) => fetchPage(input),
    }),
  };
}

export const webTools: ToolSet = createWebTools();
