import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { fetchPage, webTools } from "./web";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("webTools", () => {
  it("defines fetchPage tool", () => {
    expect(Object.keys(webTools)).toEqual(["fetchPage"]);
  });
});

describe("fetchPage", () => {
  it("fetches a page and returns its content", async () => {
    server.use(
      http.get("https://example.com/hello", () =>
        HttpResponse.text("Hello, world!"),
      ),
    );

    const result = await fetchPage({ url: "https://example.com/hello" });

    expect(result.status).toBe(200);
    expect(result.content).toBe("Hello, world!");
    expect(result.truncated).toBe(false);
    expect(result.url).toBe("https://example.com/hello");
  });

  it("truncates content exceeding maxLength", async () => {
    server.use(
      http.get("https://example.com/long", () =>
        HttpResponse.text("abcdefghij"),
      ),
    );

    const result = await fetchPage({
      url: "https://example.com/long",
      maxLength: 5,
    });

    expect(result.content).toBe("abcde");
    expect(result.truncated).toBe(true);
  });

  it("returns JSON content as text", async () => {
    server.use(
      http.get("https://example.com/api", () =>
        HttpResponse.json({ key: "value" }),
      ),
    );

    const result = await fetchPage({ url: "https://example.com/api" });

    expect(result.contentType).toContain("application/json");
    expect(JSON.parse(result.content)).toEqual({ key: "value" });
  });

  it("returns non-200 status codes", async () => {
    server.use(
      http.get("https://example.com/missing", () =>
        HttpResponse.text("Not Found", { status: 404 }),
      ),
    );

    const result = await fetchPage({ url: "https://example.com/missing" });

    expect(result.status).toBe(404);
    expect(result.content).toBe("Not Found");
  });

  it("sends custom headers", async () => {
    server.use(
      http.get("https://example.com/auth", ({ request }) => {
        const auth = request.headers.get("Authorization");
        return HttpResponse.text(auth ?? "no-auth");
      }),
    );

    const result = await fetchPage({
      url: "https://example.com/auth",
      headers: { Authorization: "Bearer token123" },
    });

    expect(result.content).toBe("Bearer token123");
  });

  it("throws for non-http URLs", async () => {
    await expect(fetchPage({ url: "ftp://example.com" })).rejects.toThrow(
      "URL must start with http:// or https://",
    );
  });
});
