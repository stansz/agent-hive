import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HIVE_URL = process.env.HIVE_URL;
const HIVE_TOKEN = process.env.HIVE_TOKEN;

if (!HIVE_URL || !HIVE_TOKEN) {
  console.error("FATAL: HIVE_URL and HIVE_TOKEN must be set");
  process.exit(1);
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HIVE_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${HIVE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Hive API error ${res.status}: ${err}`);
  }
  return res.json() as Promise<T>;
}

const server = new McpServer({
  name: "agent-hive",
  version: "1.0.0",
});

server.tool(
  "hive_prompt",
  "Start a coding task on the Agent Hive VPS",
  {
    prompt: z.string().min(1).describe("Task description"),
    repo: z.string().optional().describe("Git repo URL (optional)"),
    branch: z.string().optional().describe("Branch name (optional)"),
    model: z.string().optional().describe("Model override (e.g. deepseek/deepseek-v4-flash)"),
    provider: z.string().optional().describe("Provider override (e.g. openrouter, anthropic)"),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional().describe("Thinking level"),
  },
  async ({ prompt, repo, branch, model, provider, thinkingLevel }) => {
    const result = await api<{ sessionId: string; status: string }>("/prompt", {
      prompt,
      repo,
      branch,
      model,
      provider,
      thinkingLevel,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "hive_status",
  "Check status of a running or completed session",
  {
    sessionId: z.string().min(1).describe("Session ID from hive_prompt"),
  },
  async ({ sessionId }) => {
    const result = await api<Record<string, unknown>>(`/status/${sessionId}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "hive_abort",
  "Cancel a running session",
  {
    sessionId: z.string().min(1).describe("Session ID to abort"),
  },
  async ({ sessionId }) => {
    const result = await api<{ sessionId: string; status: string }>(`/abort/${sessionId}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "hive_snippet",
  "Quick code task without a repo — send code + prompt, get result back",
  {
    prompt: z.string().min(1).describe("What to do with the code"),
    code: z.string().describe("Source code to work with"),
    language: z.string().optional().describe("Programming language (e.g. typescript, python)"),
    model: z.string().optional().describe("Model override"),
    provider: z.string().optional().describe("Provider override"),
  },
  async ({ prompt, code, language, model, provider }) => {
    const result = await api<{ result: string }>("/snippet", {
      prompt,
      code,
      language,
      model,
      provider,
    });
    return {
      content: [{ type: "text" as const, text: result.result }],
    };
  }
);

server.tool(
  "hive_result",
  "Get the full output of a completed session",
  {
    sessionId: z.string().min(1).describe("Session ID"),
  },
  async ({ sessionId }) => {
    const result = await api<Record<string, unknown>>(`/status/${sessionId}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
