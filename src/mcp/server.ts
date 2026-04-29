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
  "Start a coding task on the Agent Hive VPS.",
  {
    prompt: z.string().min(1).describe("Task description"),
    repo: z.string().optional().describe("Git repo URL (optional)"),
    branch: z.string().optional().describe("Branch name (optional)"),
    model: z.string().optional().describe("Model override (e.g. deepseek/deepseek-v4-flash)"),
    provider: z.string().optional().describe("Provider override (e.g. openrouter, anthropic)"),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional().describe("Thinking level. Omit for default."),
  },
  async ({ prompt, repo, branch, model, provider, thinkingLevel }) => {
    const result = await api<{ sessionId: string; status: string; thinkingLevel?: string; pipeline?: string[] }>("/prompt", {
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

server.tool(
  "hive_messages",
  "Get the full message history of a session",
  {
    sessionId: z.string().min(1).describe("Session ID"),
  },
  async ({ sessionId }) => {
    const result = await api<{ messages: Array<{ role: string; content: string }> }>(`/messages/${sessionId}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── hive_guide: features catalog + presets ──

const GUIDE = {
  description: "Agent Hive — your self-hosted coding agent. Dispatch tasks, review code, and open PRs from any MCP client.",
    thinkingLevel: {
      key: "thinkingLevel",
      label: "Thinking Level",
      description: "Controls how much the model thinks before responding. Higher = better reasoning but slower and more expensive.",
      default: "(omitted = session default)",
      values: ["off", "minimal", "low", "medium", "high", "xhigh"],
    },
    gitHubWorkflow: {
      key: "repo",
      label: "GitHub Workflow",
      description: "Clone repos, create branches, push changes, and open PRs. Full GitHub integration via the REST API and MCP tools.",
    },

  providers: {
    deepseek: {
      label: "DeepSeek (direct)",
      description: "Direct API access. Lower cost than routing through OpenRouter.",
      status: "available",
      setupNote: "Set DEEPSEEK_API_KEY in .env on the VPS.",
    },
    zai: {
      label: "Z.AI (Zhipu AI)",
      description: "Chinese AI lab with strong coding models. OpenAI-compatible API via coding plan endpoint.",
      status: "available",
      setupNote: "Set ZAI_CODE in .env on the VPS.",
    },
    openrouter: {
      label: "OpenRouter",
      description: "Multi-provider gateway. Access 250+ models from Anthropic, OpenAI, Google, DeepSeek, Meta, and more through a single API key.",
      status: "available",
      setupNote: "Set OPENROUTER_API_KEY in .env on the VPS.",
    },
  },

  presets: [
    {
      id: "review",
      label: "🔍 Review my code",
      prompt: "Review the following code thoroughly. Check for: bugs, logic errors, security vulnerabilities, performance issues, code style, and maintainability. Provide specific, actionable feedback with code examples where helpful.",
    },
    {
      id: "tests",
      label: "🧪 Add unit tests",
      prompt: "Write comprehensive unit tests for the following code. Cover: happy paths, edge cases, error handling, boundary conditions. Use the project's existing test framework. Make sure tests are isolated and don't depend on external state.",
    },
    {
      id: "refactor",
      label: "♻️ Refactor for readability",
      prompt: "Refactor the following code for readability and maintainability without changing its external behavior. Focus on: clear naming, extracting helper functions, reducing duplication, and simplifying complex logic. Explain your changes.",
    },
    {
      id: "fix-bugs",
      label: "🐛 Find and fix bugs",
      prompt: "Find and fix all bugs in the following code. For each bug: explain what was wrong, how it manifests, and how your fix resolves it. Be thorough — check edge cases, async behavior, error handling, and state management.",
    },
    {
      id: "docs",
      label: "📝 Write documentation",
      prompt: "Write clear, comprehensive documentation for the following code. Include: function/class descriptions, parameter and return types, usage examples, and any important caveats or edge cases. Follow the project's existing documentation style.",
    },
    {
      id: "typescript",
      label: "🔷 Convert to TypeScript",
      prompt: "Convert the following JavaScript code to TypeScript. Add proper types, interfaces, and type guards. Avoid 'any' unless absolutely necessary. Ensure strict mode compatibility. Keep the same runtime behavior.",
    },
    {
      id: "errors",
      label: "🛡️ Add error handling",
      prompt: "Add proper error handling to the following code. Use try/catch where appropriate, add meaningful error messages, create custom error types if needed, and ensure errors propagate correctly. Consider retry logic for transient failures.",
    },
    {
      id: "perf",
      label: "⚡ Optimize performance",
      prompt: "Analyze the following code for performance bottlenecks and optimize it. Focus on: algorithmic complexity, unnecessary allocations, async patterns, caching opportunities, and database query efficiency. Explain trade-offs in your optimizations.",
    },
    {
      id: "explain",
      label: "💡 Explain this code",
      prompt: "Explain the following code in detail. Cover: overall architecture, key design decisions, data flow, and any non-obvious patterns. Help me understand what it does and why it's written this way.",
    },
    {
      id: "security",
      label: "🔒 Security audit",
      prompt: "Perform a security audit of the following code. Check for: injection vulnerabilities, authentication/authorization issues, data exposure, insecure dependencies, unsafe deserialization, and missing input validation. Provide specific fixes for each finding.",
    },
    {
      id: "full-pr",
      label: "🚀 Full PR workflow",
      prompt: "Implement the changes described below. Write clean, well-tested code. After implementation, self-review your work, fix any issues, commit with a descriptive message, and open a pull request.",
    },
    {
      id: "snippet",
      label: "📋 Quick snippet",
      prompt: null,
      description: "Use hive_snippet for quick, stateless code work — no repo needed. Good for: quick refactors, code explanations, one-off fixes, or generating utility functions.",
    },
  ],

  usage: {
    guided: 'Ask your AI assistant to "show me Hive presets" or "I want to review some code with Hive" — the assistant will present options and dispatch the right tool.',
    direct: 'Call hive_prompt with your task and desired parameters.',
    quick: 'Use hive_snippet for stateless code work without a repo.',
  },
};

server.tool(
  "hive_guide",
  "Get the Agent Hive features, providers, and preset prompts. Then dispatch via hive_prompt or hive_snippet.",
  {},
  async () => {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(GUIDE, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
