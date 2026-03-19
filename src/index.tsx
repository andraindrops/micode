#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelMessage } from "ai";
import { Box, render, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { send } from "./lib/llm.js";
import { createExecTools } from "./tools/exec.js";
import { fileTools } from "./tools/file.js";
import { webTools } from "./tools/web.js";

function loadAgentsMd(): string | undefined {
  try {
    return readFileSync(resolve(process.cwd(), "AGENTS.md"), "utf-8");
  } catch {
    return undefined;
  }
}

type LogEntry = {
  type: "user" | "assistant" | "reasoning" | "tool" | "output" | "error";
  text: string;
};

function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [history, setHistory] = useState<ModelMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatOutput, setChatOutput] = useState("");
  const [toolOutput, setToolOutput] = useState("");
  const [status, setStatus] = useState("");
  const [confirmPrompt, setConfirmPrompt] = useState<string | null>(null);
  const [confirmSelected, setConfirmSelected] = useState<"yes" | "no">("yes");
  const confirmResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const [charOffset, setCharOffset] = useState<number | null>(null);
  const [systemPrompt] = useState(() => loadAgentsMd());

  useEffect(() => {
    const cols = process.stdout.columns || 80;
    const charWidth = 8;
    const startOffset = Math.max(0, Math.floor((cols - charWidth) / 2));
    setCharOffset(startOffset);

    let current = startOffset;
    const timer = setInterval(() => {
      current -= 2;
      if (current <= 0) {
        current = 0;
        clearInterval(timer);
      }
      setCharOffset(current);
    }, 50);

    return () => clearInterval(timer);
  }, []);

  const confirmExec = useCallback((command: string): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmPrompt(command);
      setConfirmSelected("yes");
    });
  }, []);

  useInput((_input, key) => {
    if (confirmPrompt == null) return;

    if (key.leftArrow || key.rightArrow) {
      setConfirmSelected((prev) => (prev === "yes" ? "no" : "yes"));
    }

    if (key.return) {
      const resolve = confirmResolveRef.current;
      confirmResolveRef.current = null;
      setConfirmPrompt(null);
      resolve?.(confirmSelected === "yes");
    }
  });

  const flushChatOutput = useCallback(() => {
    setChatOutput((prev) => {
      if (prev !== "") {
        setLogs((logs) => [...logs, { type: "reasoning", text: prev }]);
      }
      return "";
    });
  }, []);

  const flushToolOutput = useCallback(() => {
    setToolOutput((prev) => {
      if (prev !== "") {
        setLogs((logs) => [...logs, { type: "output", text: prev }]);
      }
      return "";
    });
  }, []);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry]);
  }, []);

  const historyRef = useRef(history);
  historyRef.current = history;

  const setToolOutputRef = useRef(setToolOutput);
  setToolOutputRef.current = setToolOutput;

  const tools = useMemo(
    () => ({
      ...fileTools,
      ...createExecTools({
        onStdout: (chunk) => setToolOutputRef.current((prev) => prev + chunk),
        onStderr: (chunk) => setToolOutputRef.current((prev) => prev + chunk),
        confirm: confirmExec,
      }),
      ...webTools,
    }),
    [confirmExec],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: ignore
  const handleSubmit = useCallback(
    async (value: string) => {
      if (value.trim() === "" || loading) return;

      if (value.trim() === "/exit") {
        process.exit(0);
      }

      setInput("");
      addLog({ type: "user", text: value });
      setLoading(true);
      setChatOutput("");
      setToolOutput("");
      setStatus("thinking...");

      try {
        const userMessage: ModelMessage = { role: "user", content: value };
        const messages: ModelMessage[] = [...historyRef.current, userMessage];

        const { text, responseMessages } = await send({
          messages,
          system: systemPrompt,
          onReasoningDelta: (delta) => {
            setStatus("");
            setChatOutput((prev) => prev + delta);
          },
          onToolCall: ({ toolName, args }) => {
            flushChatOutput();
            flushToolOutput();
            addLog({
              type: "tool",
              text: `[tool] ${toolName} ${JSON.stringify(args)}`,
            });
            setStatus(`running ${toolName}...`);
          },
          onToolResult: ({ toolName, result }) => {
            flushToolOutput();
            addLog({
              type: "output",
              text: `[${toolName}] ${JSON.stringify(result, null, 2)}`,
            });
          },
          tools,
        });
        flushChatOutput();
        flushToolOutput();
        addLog({ type: "assistant", text });
        setHistory((prev) => [...prev, userMessage, ...responseMessages]);
      } catch (err) {
        addLog({
          type: "error",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setChatOutput("");
        setToolOutput("");
        setStatus("");
        setLoading(false);
      }
    },
    [loading, addLog, flushChatOutput, flushToolOutput, tools],
  );

  return (
    <Box flexDirection="column" width="100%">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="#8BE9FD"
        paddingX={1}
      >
        {logs.length === 0 ? (
          <Box flexDirection="column">
            <Box marginLeft={charOffset ?? 0}>
              <Text bold color="#8BE9FD">
                {"█      █\n████████\n██ ██ ██\n████████\n████████"}
              </Text>
            </Box>
            <Text> </Text>
            <Text bold color="#8BE9FD">
              micoli
            </Text>
          </Box>
        ) : (
          // biome-ignore lint/suspicious/useIterableCallbackReturn: ignore
          logs.map((log, i) => {
            const key = `${i}`;
            switch (log.type) {
              case "user":
                return (
                  <Text key={key} color="#50FA7B">
                    {">"} {log.text}
                  </Text>
                );
              case "assistant":
                return (
                  <Text key={key} color="#F8F8F2">
                    {log.text}
                  </Text>
                );
              case "reasoning":
                return (
                  <Text key={key} color="#6272A4" dimColor>
                    {log.text}
                  </Text>
                );
              case "output":
                return (
                  <Text key={key} color="#BD93F9" dimColor>
                    {log.text}
                  </Text>
                );
              case "tool":
                return (
                  <Text key={key} color="#F1FA8C" dimColor>
                    {log.text}
                  </Text>
                );
              case "error":
                return (
                  <Text key={key} color="#FF5555">
                    {log.text}
                  </Text>
                );
            }
          })
        )}
        {chatOutput !== "" && (
          <Text color="#6272A4" dimColor>
            {chatOutput}
          </Text>
        )}
        {toolOutput !== "" && (
          <Text color="#BD93F9" dimColor>
            {toolOutput}
          </Text>
        )}
        {status !== "" && <Text color="#F1FA8C">{status}</Text>}
      </Box>
      {confirmPrompt != null ? (
        <Box paddingX={1} flexDirection="column">
          <Text color="#FFB86C">
            Run command: <Text bold>{confirmPrompt}</Text>
          </Text>
          <Box gap={2}>
            <Text
              color={confirmSelected === "yes" ? "#50FA7B" : "#6272A4"}
              bold={confirmSelected === "yes"}
            >
              {confirmSelected === "yes" ? "▸ " : "  "}yes
            </Text>
            <Text
              color={confirmSelected === "no" ? "#FF5555" : "#6272A4"}
              bold={confirmSelected === "no"}
            >
              {confirmSelected === "no" ? "▸ " : "  "}no
            </Text>
          </Box>
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color="#8BE9FD" bold>
            {">"}{" "}
          </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder="Type a message... (/exit to quit)"
          />
        </Box>
      )}
    </Box>
  );
}

render(<App />);
