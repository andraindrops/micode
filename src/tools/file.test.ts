import { mkdir, mkdtemp, rm, writeFile as writeFsFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  editFile,
  fileTools,
  findFiles,
  listFiles,
  readFile,
  resolveFilePath,
} from "./file";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "file-tools-"));
  tempDirectories.push(directory);
  return directory;
}

describe("fileTools", () => {
  it("defines list, read, edit, and find tools", () => {
    expect(Object.keys(fileTools).sort()).toEqual([
      "editFile",
      "findFiles",
      "listFiles",
      "readFile",
    ]);
  });
});

describe("listFiles", () => {
  it("lists files and directories in nested paths", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFsFile(join(workspace, "README.md"), "# hello\n", "utf8");
    await writeFsFile(join(workspace, "docs", "guide.md"), "guide\n", "utf8");

    const result = await listFiles({
      path: ".",
      recursive: true,
      maxDepth: 3,
      root: workspace,
    });

    expect(result.entries).toEqual([
      { path: "docs", type: "directory" },
      { path: "docs/guide.md", type: "file" },
      { path: "README.md", type: "file" },
    ]);
  });

  it("respects maxDepth for recursive listing", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "docs", "nested"), { recursive: true });
    await writeFsFile(join(workspace, "docs", "guide.md"), "guide\n", "utf8");
    await writeFsFile(
      join(workspace, "docs", "nested", "deep.md"),
      "deep\n",
      "utf8",
    );

    const result = await listFiles({
      path: ".",
      recursive: true,
      maxDepth: 1,
      root: workspace,
    });

    expect(result.entries).toEqual([
      { path: "docs", type: "directory" },
      { path: "docs/guide.md", type: "file" },
      { path: "docs/nested", type: "directory" },
    ]);
  });

  it("throws when listing above the current working directory", async () => {
    const workspace = await createWorkspace();

    await expect(
      listFiles({
        path: "..",
        root: workspace,
      }),
    ).rejects.toThrow("Path must stay inside the current working directory");
  });
});

describe("readFile", () => {
  it("reads only the requested line range", async () => {
    const workspace = await createWorkspace();
    await writeFsFile(
      join(workspace, "notes.txt"),
      ["alpha", "beta", "gamma", "delta"].join("\n"),
      "utf8",
    );

    const result = await readFile({
      path: "notes.txt",
      beginLine: 2,
      closeLine: 3,
      root: workspace,
    });

    expect(result.totalLines).toBe(4);
    expect(result.beginLine).toBe(2);
    expect(result.closeLine).toBe(3);
    expect(result.content).toBe(["2|beta", "3|gamma"].join("\n"));
  });

  it("throws when reading above the current working directory", async () => {
    const workspace = await createWorkspace();

    await expect(
      readFile({
        path: "../notes.txt",
        root: workspace,
      }),
    ).rejects.toThrow("Path must stay inside the current working directory");
  });
});

describe("editFile", () => {
  it("writes a new file from full content", async () => {
    const workspace = await createWorkspace();

    const result = await editFile({
      path: "nested/output.txt",
      content: "hello\nworld\n",
      root: workspace,
    });

    expect(result.operation).toBe("write");

    const saved = await readFile({
      path: "nested/output.txt",
      root: workspace,
    });

    expect(saved.content).toBe(["1|hello", "2|world"].join("\n"));
  });

  it("throws when writing above the current working directory", async () => {
    const workspace = await createWorkspace();

    await expect(
      editFile({
        path: "../outside.txt",
        content: "hello\n",
        root: workspace,
      }),
    ).rejects.toThrow("Path must stay inside the current working directory");
  });

  it("replaces oldString with newString", async () => {
    const workspace = await createWorkspace();
    await writeFsFile(join(workspace, "draft.txt"), "hello world\nhello bun\n");

    const result = await editFile({
      path: "draft.txt",
      oldString: "hello world",
      newString: "hi world",
      root: workspace,
    });

    expect(result.operation).toBe("edit");

    const saved = await readFile({ path: "draft.txt", root: workspace });
    expect(saved.content).toBe(["1|hi world", "2|hello bun"].join("\n"));
  });

  it("throws when oldString is not found", async () => {
    const workspace = await createWorkspace();
    await writeFsFile(join(workspace, "draft.txt"), "hello world\n");

    await expect(
      editFile({
        path: "draft.txt",
        oldString: "not found",
        newString: "replacement",
        root: workspace,
      }),
    ).rejects.toThrow("oldString not found in file");
  });

  it("throws when oldString matches multiple locations", async () => {
    const workspace = await createWorkspace();
    await writeFsFile(join(workspace, "draft.txt"), "hello\nhello\n");

    await expect(
      editFile({
        path: "draft.txt",
        oldString: "hello",
        newString: "hollo",
        root: workspace,
      }),
    ).rejects.toThrow("oldString found 2 times");
  });
});

describe("findFiles", () => {
  it("finds matching lines in files", async () => {
    const workspace = await createWorkspace();
    await writeFsFile(
      join(workspace, "app.ts"),
      "const foo = 1;\nconst bar = 2;\n",
      "utf8",
    );
    await writeFsFile(
      join(workspace, "util.ts"),
      "export const foo = 42;\n",
      "utf8",
    );

    const result = await findFiles({
      pattern: "foo",
      root: workspace,
    });

    expect(result.totalMatches).toBe(2);
    expect(result.matches).toEqual(
      expect.arrayContaining([
        { path: "app.ts", line: 1, content: "const foo = 1;" },
        { path: "util.ts", line: 1, content: "export const foo = 42;" },
      ]),
    );
  });

  it("filters by glob pattern", async () => {
    const workspace = await createWorkspace();
    await writeFsFile(join(workspace, "app.ts"), "const foo = 1;\n", "utf8");
    await writeFsFile(join(workspace, "app.js"), "const foo = 2;\n", "utf8");

    const result = await findFiles({
      pattern: "foo",
      glob: "*.js",
      root: workspace,
    });

    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]?.path).toBe("app.js");
  });

  it("supports case-insensitive search", async () => {
    const workspace = await createWorkspace();
    await writeFsFile(join(workspace, "app.ts"), "const FOO = 1;\n", "utf8");

    const result = await findFiles({
      pattern: "foo",
      ignoreCase: true,
      root: workspace,
    });

    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]?.content).toBe("const FOO = 1;");
  });

  it("returns empty matches when pattern is not found", async () => {
    const workspace = await createWorkspace();
    await writeFsFile(join(workspace, "app.ts"), "const bar = 1;\n", "utf8");

    const result = await findFiles({
      pattern: "notfound",
      root: workspace,
    });

    expect(result.totalMatches).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it("throws when searching above the current working directory", async () => {
    const workspace = await createWorkspace();

    await expect(
      findFiles({
        pattern: "foo",
        path: "..",
        root: workspace,
      }),
    ).rejects.toThrow("Path must stay inside the current working directory");
  });
});

describe("resolveFilePath", () => {
  it("allows paths inside the current working directory", async () => {
    const workspace = await createWorkspace();

    expect(
      resolveFilePath({ filePath: "docs/guide.md", root: workspace }),
    ).toBe(join(workspace, "docs/guide.md"));
  });

  it("throws when resolving a path above the current working directory", async () => {
    const workspace = await createWorkspace();

    expect(() =>
      resolveFilePath({ filePath: "../../outside.txt", root: workspace }),
    ).toThrow("Path must stay inside the current working directory");
  });
});
