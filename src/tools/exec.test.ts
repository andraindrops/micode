import { mkdir, mkdtemp, readFile as readFsFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { execCommand, execTools } from "./exec";

const tempDirectories: string[] = [];
const DOCKER_TIMEOUT_MS = 60_000;
const NETWORK_PROBE_COMMAND =
  "if awk '$2 == \"00000000\" { found = 1 } END { exit(found ? 0 : 1) }' /proc/net/route; then echo connected; else echo isolated >&2; exit 9; fi";

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exec-tools-"));
  tempDirectories.push(directory);
  return directory;
}

describe("execTools", () => {
  it("defines the exec tool", () => {
    expect(Object.keys(execTools)).toEqual(["exec"]);
  });
});

describe("execCommand", () => {
  it(
    "runs a shell command and returns stdout",
    async () => {
      const workspace = await createWorkspace();

      const result = await execCommand({
        command: "printf 'hello\\nworld\\n'",
        root: workspace,
      });

      expect(result.blocked).toBe(false);
      expect(result.cwd).toBe(".");
      expect(result.stdout).toBe("hello\nworld\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    },
    { timeout: DOCKER_TIMEOUT_MS },
  );

  it(
    "mounts the workspace into the container",
    async () => {
      const workspace = await createWorkspace();

      const result = await execCommand({
        command: "printf 'created in docker\\n' > mounted.txt",
        root: workspace,
      });

      expect(result.exitCode).toBe(0);
      await expect(
        readFsFile(join(workspace, "mounted.txt"), "utf8"),
      ).resolves.toBe("created in docker\n");
    },
    { timeout: DOCKER_TIMEOUT_MS },
  );

  it(
    "runs the command in a relative working directory",
    async () => {
      const workspace = await createWorkspace();
      await mkdir(join(workspace, "nested"), { recursive: true });

      const result = await execCommand({
        command: 'basename "$PWD"',
        cwd: "nested",
        root: workspace,
      });

      expect(result.cwd).toBe("nested");
      expect(result.stdout.trim()).toBe("nested");
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    },
    { timeout: DOCKER_TIMEOUT_MS },
  );

  it(
    "captures stderr and non-zero exit codes",
    async () => {
      const workspace = await createWorkspace();

      const result = await execCommand({
        command: "printf 'failed\\n' >&2; exit 7",
        root: workspace,
      });

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("failed\n");
      expect(result.exitCode).toBe(7);
      expect(result.success).toBe(false);
    },
    { timeout: DOCKER_TIMEOUT_MS },
  );

  it(
    "mirrors stdout and stderr to the host cli",
    async () => {
      const workspace = await createWorkspace();
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      const mirroredStdout: Uint8Array[] = [];
      const mirroredStderr: Uint8Array[] = [];

      process.stdout.write = ((chunk: string | Uint8Array) => {
        mirroredStdout.push(
          typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
        );
        return true;
      }) as typeof process.stdout.write;

      process.stderr.write = ((chunk: string | Uint8Array) => {
        mirroredStderr.push(
          typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
        );
        return true;
      }) as typeof process.stderr.write;

      try {
        const result = await execCommand({
          command:
            "printf 'hello from stdout\\n'; printf 'hello from stderr\\n' >&2",
          root: workspace,
        });

        expect(result.stdout).toBe("hello from stdout\n");
        expect(result.stderr).toBe("hello from stderr\n");
        expect(Buffer.concat(mirroredStdout).toString("utf8")).toContain(
          "hello from stdout\n",
        );
        expect(Buffer.concat(mirroredStderr).toString("utf8")).toContain(
          "hello from stderr\n",
        );
      } finally {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      }
    },
    { timeout: DOCKER_TIMEOUT_MS },
  );

  it(
    "disables outbound network access by default",
    async () => {
      const workspace = await createWorkspace();

      const result = await execCommand({
        command: NETWORK_PROBE_COMMAND,
        root: workspace,
      });

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("isolated\n");
      expect(result.exitCode).toBe(9);
      expect(result.success).toBe(false);
    },
    { timeout: DOCKER_TIMEOUT_MS },
  );

  it(
    "allows outbound network access when networkEnabled is true",
    async () => {
      const workspace = await createWorkspace();

      const result = await execCommand({
        command: NETWORK_PROBE_COMMAND,
        networkEnabled: true,
        root: workspace,
      });

      expect(result.stdout).toBe("connected\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    },
    { timeout: DOCKER_TIMEOUT_MS },
  );

  it("blocks execution when confirm returns false", async () => {
    const workspace = await createWorkspace();

    const result = await execCommand({
      command: "printf 'should not run\\n' > skipped.txt",
      root: workspace,
      confirm: async () => false,
    });

    expect(result.blocked).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Execution denied by user.\n");
    expect(result.exitCode).toBe(126);
    expect(result.success).toBe(false);
  });

  it(
    "runs when confirm returns true",
    async () => {
      const workspace = await createWorkspace();

      const result = await execCommand({
        command: "printf 'approved\\n'",
        root: workspace,
        confirm: async () => true,
      });

      expect(result.blocked).toBe(false);
      expect(result.stdout).toBe("approved\n");
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    },
    { timeout: DOCKER_TIMEOUT_MS },
  );

  it("throws when cwd resolves above the current working directory", async () => {
    const workspace = await createWorkspace();

    await expect(
      execCommand({
        command: "pwd",
        cwd: "..",
        root: workspace,
      }),
    ).rejects.toThrow("Path must stay inside the current working directory");
  });
});
