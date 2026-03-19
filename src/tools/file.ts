import { spawn } from "node:child_process";
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { jsonSchema, type ToolSet, tool } from "ai";
import { globby } from "globby";

export type ListFilesInput = {
  path?: string;
  recursive?: boolean;
  maxDepth?: number;
};

export type FindFilesInput = {
  path?: string;
  pattern: string;
  glob?: string;
  ignoreCase?: boolean;
  maxResults?: number;
};

export type ReadFileInput = {
  path: string;
  beginLine?: number;
  closeLine?: number;
};

export type EditFileInput = {
  path: string;
  content?: string;
  oldString?: string;
  newString?: string;
};

type FileOptions = {
  root?: string;
};

type FileEntry = {
  path: string;
  type: "file" | "directory";
};

export function resolveFilePath({
  root = process.cwd(),
  filePath,
}: {
  filePath: string;
} & FileOptions): string {
  const workspaceRoot = resolve(root);
  const targetPath = resolve(workspaceRoot, filePath);
  const relativePath = relative(workspaceRoot, targetPath);

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("Path must stay inside the current working directory");
  }

  return targetPath;
}

export async function listFiles({
  path = ".",
  recursive = true,
  maxDepth = 3,
  root = process.cwd(),
}: ListFilesInput & FileOptions = {}): Promise<{
  path: string;
  recursive: boolean;
  maxDepth: number;
  entries: FileEntry[];
}> {
  if (maxDepth < 0) {
    throw new Error("maxDepth must be greater than or equal to 0");
  }

  const targetPath = resolveFilePath({ filePath: path, root });

  const basePath = toWorkspaceRelativePath({ targetPath, root });

  const matches = await globby(recursive ? ["**/*"] : ["*"], {
    cwd: targetPath,
    deep: recursive ? maxDepth + 1 : 1,
    expandDirectories: false,
    markDirectories: true,
    onlyFiles: false,
  });

  const entries: FileEntry[] = matches
    .sort((left, right) => left.localeCompare(right))
    .map((match) => {
      const isDirectory = match.endsWith("/");
      const relativePath = joinRelativePath({
        basePath,
        entryPath: isDirectory ? match.slice(0, -1) : match,
      });

      return {
        path: relativePath,
        type: isDirectory ? "directory" : "file",
      };
    });

  return {
    path: toWorkspaceRelativePath({ targetPath, root }),
    recursive,
    maxDepth,
    entries,
  };
}

export async function findFiles({
  path = ".",
  pattern,
  glob,
  ignoreCase = false,
  maxResults = 100,
  root = process.cwd(),
}: FindFilesInput & FileOptions): Promise<{
  path: string;
  pattern: string;
  totalMatches: number;
  truncated: boolean;
  matches: {
    path: string;
    line: number;
    content: string;
  }[];
}> {
  const targetPath = resolveFilePath({ filePath: path, root });

  const args = [
    "--no-heading",
    "--line-number",
    "--color",
    "never",
    ...(ignoreCase ? ["--ignore-case"] : []),
    ...(glob ? ["--glob", glob] : []),
    "--max-count",
    String(maxResults),
    "--",
    pattern,
    targetPath,
  ];

  const { stdout, exitCode } = await spawnRipgrep(args);

  const matches: {
    path: string;
    line: number;
    content: string;
  }[] = [];

  if (exitCode === 0 && stdout !== "") {
    for (const line of stdout.split("\n")) {
      if (line === "") continue;

      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (match == null) continue;

      matches.push({
        path: toWorkspaceRelativePath({
          targetPath: match[1] as string,
          root,
        }),
        line: Number(match[2]),
        content: match[3] as string,
      });
    }
  }

  const truncated = matches.length >= maxResults;

  return {
    pattern,
    path: toWorkspaceRelativePath({ targetPath, root }),
    totalMatches: matches.length,
    truncated,
    matches,
  };
}

export async function readFile({
  path,
  beginLine = 1,
  closeLine,
  root = process.cwd(),
}: ReadFileInput & FileOptions): Promise<{
  path: string;
  totalLines: number;
  beginLine: number;
  closeLine: number;
  content: string;
}> {
  if (beginLine < 1) {
    throw new Error("beginLine must be greater than or equal to 1");
  }

  if (closeLine !== undefined && closeLine < beginLine) {
    throw new Error("closeLine must be greater than or equal to beginLine");
  }

  const targetPath = resolveFilePath({ filePath: path, root });

  const text = await fsReadFile(targetPath, "utf8");

  const lines = toLines({ content: text });
  const totalLines = lines.length;

  const resultBeginLine = totalLines === 0 ? 0 : beginLine;
  const resultCloseLine =
    totalLines === 0 ? 0 : Math.min(closeLine ?? totalLines, totalLines);

  const selectedLines =
    totalLines === 0
      ? []
      : lines.slice(Math.max(resultBeginLine - 1, 0), resultCloseLine);

  return {
    path: toWorkspaceRelativePath({ targetPath, root }),
    totalLines,
    beginLine: resultBeginLine,
    closeLine: resultCloseLine,
    content: selectedLines
      .map((line, index) => `${resultBeginLine + index}|${line}`)
      .join("\n"),
  };
}

export async function editFile({
  path,
  content,
  oldString,
  newString,
  root = process.cwd(),
}: EditFileInput & FileOptions): Promise<{
  path: string;
  operation: "write" | "edit";
  bytesWritten: number;
}> {
  const targetPath = resolveFilePath({ filePath: path, root });

  if (oldString != null && newString != null) {
    const current = await fsReadFile(targetPath, "utf8");
    const count = current.split(oldString).length - 1;

    if (count === 0) {
      throw new Error("oldString not found in file");
    }
    if (count > 1) {
      throw new Error(
        `oldString found ${count} times in file — provide more context to make it unique`,
      );
    }

    const nextContent = current.replace(oldString, newString);
    await fsWriteFile(targetPath, nextContent, "utf8");

    return {
      path: toWorkspaceRelativePath({ targetPath, root }),
      operation: "edit",
      bytesWritten: Buffer.byteLength(nextContent, "utf8"),
    };
  }

  if (content == null) {
    throw new Error("Either content or oldString/newString must be provided");
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await fsWriteFile(targetPath, content, "utf8");

  return {
    path: toWorkspaceRelativePath({ targetPath, root }),
    operation: "write",
    bytesWritten: Buffer.byteLength(content, "utf8"),
  };
}

function spawnRipgrep(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

export function createFileTools({ root }: FileOptions = {}): ToolSet {
  return {
    listFiles: tool({
      description: "List files and directories.",
      inputSchema: listFilesInputSchema,
      execute: async (input) => listFiles({ ...input, root }),
    }),
    findFiles: tool({
      description: "Find files and directories.",
      inputSchema: findFilesInputSchema,
      execute: async (input) => findFiles({ ...input, root }),
    }),
    readFile: tool({
      description: "Read a file with optional begin and close lines.",
      inputSchema: readFileInputSchema,
      execute: async (input) => readFile({ ...input, root }),
    }),
    editFile: tool({
      description:
        "Write or edit a file. To create/overwrite, provide content. To edit an existing file, provide oldString and newString for search-and-replace. oldString must match exactly one location in the file.",
      inputSchema: editFileInputSchema,
      execute: async (input) => editFile({ ...input, root }),
    }),
  };
}

function toWorkspaceRelativePath({
  targetPath,
  root,
}: {
  targetPath: string;
  root: string;
}): string {
  const relativePath = relative(resolve(root), targetPath);
  return relativePath === "" ? "." : relativePath;
}

function joinRelativePath({
  basePath,
  entryPath,
}: {
  basePath: string;
  entryPath: string;
}): string {
  if (basePath === ".") {
    return entryPath;
  }

  return `${basePath}/${entryPath}`;
}

function toLines({ content }: { content: string }): string[] {
  if (content === "") {
    return [];
  }

  const lines = content.split(/\r?\n/u);

  if (content.endsWith("\n") || content.endsWith("\r")) {
    lines.pop();
  }

  return lines;
}

const listFilesInputSchema = jsonSchema<ListFilesInput>({
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Directory path relative to the current workspace.",
    },
    recursive: {
      type: "boolean",
      description: "Whether to include nested files and directories.",
      default: true,
    },
    maxDepth: {
      type: "integer",
      description: "Maximum directory depth when recursive is true.",
      minimum: 0,
      default: 3,
    },
  },
  additionalProperties: false,
});

const findFilesInputSchema = jsonSchema<FindFilesInput>({
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Directory path relative to the current workspace.",
      default: ".",
    },
    pattern: {
      type: "string",
      description: "Regex pattern to search for in file contents.",
    },
    glob: {
      type: "string",
      description: 'Glob pattern to filter files (e.g. "*.ts", "*.{js,jsx}").',
    },
    ignoreCase: {
      type: "boolean",
      description: "Whether to perform case-insensitive matching.",
      default: false,
    },
    maxResults: {
      type: "integer",
      description: "Maximum number of matching lines per file.",
      minimum: 1,
      default: 100,
    },
  },
  required: ["pattern"],
  additionalProperties: false,
});

const readFileInputSchema = jsonSchema<ReadFileInput>({
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "File path relative to the current workspace.",
    },
    beginLine: {
      type: "integer",
      description: "1-based begin line number, inclusive.",
      minimum: 1,
      default: 1,
    },
    closeLine: {
      type: "integer",
      description: "1-based close line number, inclusive.",
      minimum: 1,
    },
  },
  required: ["path"],
  additionalProperties: false,
});

const editFileInputSchema = jsonSchema<EditFileInput>({
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "File path relative to the current workspace.",
    },
    content: {
      type: "string",
      description:
        "Full file content to write. Use this to create a new file or overwrite an existing file.",
    },
    oldString: {
      type: "string",
      description:
        "The exact text to find in the file for search-and-replace editing. Must match exactly one location.",
    },
    newString: {
      type: "string",
      description: "The replacement text. Used together with oldString.",
    },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fileTools: ToolSet = createFileTools();
