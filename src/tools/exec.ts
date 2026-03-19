import { spawn } from "node:child_process";
import { posix, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { jsonSchema, type ToolSet, tool } from "ai";

export type ExecInput = {
  command: string;
  cwd?: string;
  networkEnabled?: boolean;
};

type ExecOptions = {
  root?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  confirm?: (command: string) => Promise<boolean>;
};

const CONTAINER_WORKSPACE_ROOT = "/workspace";
const DOCKER_IMAGE = "node:lts";

export async function execCommand({
  root = process.cwd(),
  command,
  cwd,
  networkEnabled,
  onStdout,
  onStderr,
  confirm,
}: ExecInput & ExecOptions): Promise<{
  blocked: boolean;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}> {
  const { containerCwd, workspaceCwd, workspaceRoot } = resolveExecPaths({
    cwd,
    root,
  });

  if (confirm) {
    const approved = await confirm(command);
    if (!approved) {
      return {
        blocked: true,
        command,
        cwd: workspaceCwd,
        stdout: "",
        stderr: "Execution denied by user.\n",
        exitCode: 126,
        success: false,
      };
    }
  }

  const args = createDockerArgs({
    command,
    containerCwd,
    networkEnabled: networkEnabled ?? false,
    workspaceRoot,
  });

  if (args[0] == null) {
    throw new Error("Failed to construct Docker command arguments.");
  }

  const spawnedProcess = spawn(args[0], args.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exitCodePromise = new Promise<number>((resolve) => {
    spawnedProcess.on("close", (code) => resolve(code ?? 1));
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readAndMirrorStream({
      stream: spawnedProcess.stdout,
      write: (chunk) => {
        if (onStdout) onStdout(chunk.toString("utf8"));
        else process.stdout.write(chunk);
      },
    }),
    readAndMirrorStream({
      stream: spawnedProcess.stderr,
      write: (chunk) => {
        if (onStderr) onStderr(chunk.toString("utf8"));
        else process.stderr.write(chunk);
      },
    }),
    exitCodePromise,
  ]);

  return {
    blocked: false,
    command,
    cwd: workspaceCwd,
    stdout,
    stderr,
    exitCode,
    success: exitCode === 0,
  };
}

async function readAndMirrorStream({
  stream,
  write,
}: {
  stream: Readable | null;
  write: (chunk: Buffer) => void;
}): Promise<string> {
  if (stream == null) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buf);
    write(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createDockerArgs({
  command,
  containerCwd,
  networkEnabled,
  workspaceRoot,
}: {
  command: string;
  containerCwd: string;
  networkEnabled: boolean;
  workspaceRoot: string;
}): string[] {
  return [
    "docker",
    "run",
    "--rm",
    "--interactive=false",
    ...(networkEnabled ? [] : ["--network", "none"]),
    "--env",
    "CI=true",
    "--volume",
    `${workspaceRoot}:${CONTAINER_WORKSPACE_ROOT}`,
    "--workdir",
    containerCwd,
    "--entrypoint",
    "sh",
    DOCKER_IMAGE,
    "-lc",
    command,
  ];
}

function resolveExecPaths({
  cwd,
  root = process.cwd(),
}: Pick<ExecInput, "cwd"> & ExecOptions): {
  workspaceRoot: string;
  workspaceCwd: string;
  containerCwd: string;
} {
  const workspaceRoot = resolve(root);
  const hostCwd = cwd ? resolve(workspaceRoot, cwd) : workspaceRoot;
  const relativeCwd = relative(workspaceRoot, hostCwd);

  if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) {
    throw new Error("Path must stay inside the current working directory");
  }

  const workspaceCwd = relativeCwd || ".";
  const containerCwd =
    workspaceCwd === "."
      ? CONTAINER_WORKSPACE_ROOT
      : posix.join(
          CONTAINER_WORKSPACE_ROOT,
          workspaceCwd.split(sep).join(posix.sep),
        );

  return {
    workspaceRoot,
    workspaceCwd,
    containerCwd,
  };
}

const execInputSchema = jsonSchema<ExecInput>({
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Shell command to execute.",
    },
    cwd: {
      type: "string",
      description: "Working directory relative to the current workspace.",
    },
    networkEnabled: {
      type: "boolean",
      description:
        "Whether to allow outbound network access from the Docker sandbox.",
    },
  },
  required: ["command", "networkEnabled"],
  additionalProperties: false,
});

export function createExecTools({
  root,
  onStdout,
  onStderr,
  confirm,
}: ExecOptions = {}): ToolSet {
  return {
    exec: tool({
      description: "Execute a shell command inside a Docker sandbox.",
      inputSchema: execInputSchema,
      execute: async (input) =>
        execCommand({ ...input, root, onStdout, onStderr, confirm }),
    }),
  };
}

export const execTools: ToolSet = createExecTools();
