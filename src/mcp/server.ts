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
  "Start a coding task on the Agent Hive VPS. Supports auto-review and auto-PR pipeline.",
  {
    prompt: z.string().min(1).describe("Task description"),
    repo: z.string().optional().describe("Git repo URL (optional)"),
    branch: z.string().optional().describe("Branch name (optional)"),
    model: z.string().optional().describe("Model override (e.g. deepseek/deepseek-v4-flash)"),
    provider: z.string().optional().describe("Provider override (e.g. openrouter, anthropic)"),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional().describe("Thinking level (auto-detected if omitted)"),
    autoReview: z.boolean().optional().describe("Auto self-review after completion (default: true)"),
    autoPR: z.boolean().optional().describe("Auto-commit changes and open PR after completion"),
  },
  async ({ prompt, repo, branch, model, provider, thinkingLevel, autoReview, autoPR }) => {
    const result = await api<{ sessionId: string; status: string; thinkingLevel?: string; pipeline?: string[] }>("/prompt", {
      prompt,
      repo,
      branch,
      model,
      provider,
      thinkingLevel,
      autoReview,
      autoPR,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "hive_prompt_pr",
  "Start a coding task with full pipeline: prompt → review → commit → PR. One-shot coding with auto-pull request.",
  {
    prompt: z.string().min(1).describe("Task description"),
    repo: z.string().optional().describe("Git repo to work in"),
    branch: z.string().optional().describe("Feature branch name"),
    baseBranch: z.string().optional().describe("Base branch for PR (default: main)"),
    prTitle: z.string().optional().describe("Custom PR title (auto-generated from task if omitted)"),
    model: z.string().optional().describe("Model override"),
    provider: z.string().optional().describe("Provider override"),
    autoReview: z.boolean().optional().describe("Self-review before commit (default: true)"),
  },
  async ({ prompt, repo, branch, baseBranch, prTitle, model, provider, autoReview }) => {
    const result = await api<{ sessionId: string; status: string; pipeline?: string[] }>("/prompt/pr", {
      prompt,
      repo,
      branch,
      baseBranch,
      prTitle,
      model,
      provider,
      autoReview,
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

// ── hive_guide: features catalog + presets + model recommendations ──

const GUIDE = {
  description: "Agent Hive — your self-hosted coding agent. Dispatch tasks, review code, and open PRs from any MCP client.",

  features: {
    autoReview: {
      key: "autoReview",
      label: "Auto-Review",
      description: "After the main prompt, Hive self-reviews its own changes for bugs, broken imports, and style issues. Fixes anything it finds.",
      default: true,
      availableIn: ["hive_prompt", "hive_prompt_pr"],
    },
    autoPR: {
      key: "autoPR",
      label: "Auto-PR",
      description: "After review, commits changes with a generated message and opens a pull request on GitHub. Requires a repo to be cloned on the VPS.",
      default: false,
      availableIn: ["hive_prompt", "hive_prompt_pr"],
    },
    thinkingLevel: {
      key: "thinkingLevel",
      label: "Thinking Level",
      description: "Controls how much the model thinks before responding. Higher = better reasoning but slower and more expensive.",
      default: "auto (detected from task complexity)",
      values: ["off", "minimal", "low", "medium", "high", "xhigh"],
      availableIn: ["hive_prompt", "hive_prompt_pr", "hive_snippet"],
    },
    gitHubWorkflow: {
      key: "repo",
      label: "GitHub Workflow",
      description: "Clone repos, create branches, push changes, and open PRs. Full GitHub integration via the REST API and MCP tools.",
      availableIn: ["hive_prompt", "hive_prompt_pr"],
    },
  },

  providers: {
    deepseek: {
      label: "DeepSeek (direct)",
      description: "DeepSeek V4 Pro/Flash, R1. Direct API access with OpenAI-compatible endpoint. Lower cost than routing through OpenRouter. Use model IDs: deepseek-v4-pro, deepseek-v4-flash (legacy: deepseek-chat, deepseek-reasoner).",
      status: "available",
      setupNote: "Set DEEPSEEK_API_KEY in .env on the VPS.",
    },
    zai: {
      label: "Z.AI (Zhipu AI)",
      description: "GLM-5.1, GLM-5-Turbo. Chinese AI lab with strong coding models. OpenAI-compatible API via coding plan endpoint.",
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

  models: {
    quick: [
      { id: "deepseek-v4-flash", provider: "deepseek", label: "DeepSeek V4 Flash (direct)", description: "Fast, cheap, great for refactors and simple tasks via DeepSeek direct API." },
      { id: "glm-5-turbo", provider: "zai", label: "GLM-5 Turbo (Z.AI)", description: "Fast GLM model via Z.AI coding plan. Good for quick edits and simple tasks." },
      { id: "google/gemini-2.5-flash", provider: "openrouter", label: "Gemini 2.5 Flash", description: "Fast with 1M context window. Good for large file analysis." },
      { id: "openai/gpt-4.1-nano", provider: "openrouter", label: "GPT-4.1 Nano", description: "Smallest GPT-4.1. Good for simple edits, cheapest OpenAI model." },
      { id: "meta-llama/llama-4-maverick", provider: "openrouter", label: "Llama 4 Maverick", description: "Meta's fast model. Good open-source option for straightforward tasks." },
      { id: "qwen/qwen3-coder", provider: "openrouter", label: "Qwen 3 Coder", description: "Specialized coding model. Strong at code generation and refactoring." },
    ],
    balanced: [
      { id: "deepseek-v4-pro", provider: "deepseek", label: "DeepSeek V4 Pro (direct)", description: "Strong reasoning, good for complex refactors and debugging via DeepSeek direct API." },
      { id: "deepseek-v4-flash", provider: "deepseek", label: "DeepSeek V4 Flash (direct)", description: "Fast, cheap, great for refactors and simple tasks via DeepSeek direct API." },
      { id: "glm-5.1", provider: "zai", label: "GLM-5.1 (Z.AI)", description: "Z.AI's flagship coding model. Strong reasoning and code quality via direct API." },
      { id: "anthropic/claude-sonnet-4-20250514", provider: "openrouter", label: "Claude Sonnet 4", description: "Excellent code quality and reasoning. Top-tier for architecture and review." },
      { id: "google/gemini-2.5-pro", provider: "openrouter", label: "Gemini 2.5 Pro", description: "1M context, strong coding. Great for large codebase analysis." },
      { id: "openai/gpt-4.1-mini", provider: "openrouter", label: "GPT-4.1 Mini", description: "Balanced cost/capability. Good for most coding tasks." },
      { id: "openai/o4-mini", provider: "openrouter", label: "o4 Mini", description: "OpenAI reasoning model. Strong at complex logic and debugging." },
    ],
    powerful: [
      { id: "deepseek-v4-pro", provider: "deepseek", label: "DeepSeek V4 Pro (direct)", description: "DeepSeek's strongest model. 1M context, strong reasoning via direct API." },
      { id: "glm-5.1", provider: "zai", label: "GLM-5.1 (Z.AI)", description: "Z.AI's flagship. Competitive code quality with generous context window via direct API." },
      { id: "anthropic/claude-sonnet-4-20250514", provider: "openrouter", label: "Claude Sonnet 4", description: "Best-in-class code generation. Use for architecture, complex features, and thorough reviews." },
      { id: "google/gemini-2.5-pro", provider: "openrouter", label: "Gemini 2.5 Pro", description: "1M context window. Analyze entire codebases in one pass." },
      { id: "openai/gpt-4.1", provider: "openrouter", label: "GPT-4.1", description: "OpenAI's latest flagship. Excellent instruction following and code quality." },
      { id: "openai/o3", provider: "openrouter", label: "o3", description: "OpenAI's most powerful reasoning model. Best for hard problems and novel solutions." },
      { id: "openai/o3-pro", provider: "openrouter", label: "o3 Pro", description: "Maximum reasoning depth. For the hardest problems where cost is no object." },
      { id: "anthropic/claude-opus-4-20250514", provider: "openrouter", label: "Claude Opus 4", description: "Anthropic's most capable model. Ultimate code quality and reasoning." },
    ],
  },

  presets: [
    {
      id: "review",
      label: "🔍 Review my code",
      prompt: "Review the following code thoroughly. Check for: bugs, logic errors, security vulnerabilities, performance issues, code style, and maintainability. Provide specific, actionable feedback with code examples where helpful.",
      features: { autoReview: false, autoPR: false },
    },
    {
      id: "tests",
      label: "🧪 Add unit tests",
      prompt: "Write comprehensive unit tests for the following code. Cover: happy paths, edge cases, error handling, boundary conditions. Use the project's existing test framework. Make sure tests are isolated and don't depend on external state.",
      features: { autoReview: true, autoPR: false },
    },
    {
      id: "refactor",
      label: "♻️ Refactor for readability",
      prompt: "Refactor the following code for readability and maintainability without changing its external behavior. Focus on: clear naming, extracting helper functions, reducing duplication, and simplifying complex logic. Explain your changes.",
      features: { autoReview: true, autoPR: false },
    },
    {
      id: "fix-bugs",
      label: "🐛 Find and fix bugs",
      prompt: "Find and fix all bugs in the following code. For each bug: explain what was wrong, how it manifests, and how your fix resolves it. Be thorough — check edge cases, async behavior, error handling, and state management.",
      features: { autoReview: true, autoPR: false },
    },
    {
      id: "docs",
      label: "📝 Write documentation",
      prompt: "Write clear, comprehensive documentation for the following code. Include: function/class descriptions, parameter and return types, usage examples, and any important caveats or edge cases. Follow the project's existing documentation style.",
      features: { autoReview: false, autoPR: false },
    },
    {
      id: "typescript",
      label: "🔷 Convert to TypeScript",
      prompt: "Convert the following JavaScript code to TypeScript. Add proper types, interfaces, and type guards. Avoid 'any' unless absolutely necessary. Ensure strict mode compatibility. Keep the same runtime behavior.",
      features: { autoReview: true, autoPR: false },
    },
    {
      id: "errors",
      label: "🛡️ Add error handling",
      prompt: "Add proper error handling to the following code. Use try/catch where appropriate, add meaningful error messages, create custom error types if needed, and ensure errors propagate correctly. Consider retry logic for transient failures.",
      features: { autoReview: true, autoPR: false },
    },
    {
      id: "perf",
      label: "⚡ Optimize performance",
      prompt: "Analyze the following code for performance bottlenecks and optimize it. Focus on: algorithmic complexity, unnecessary allocations, async patterns, caching opportunities, and database query efficiency. Explain trade-offs in your optimizations.",
      features: { autoReview: true, autoPR: false },
    },
    {
      id: "explain",
      label: "💡 Explain this code",
      prompt: "Explain the following code in detail. Cover: overall architecture, key design decisions, data flow, and any non-obvious patterns. Help me understand what it does and why it's written this way.",
      features: { autoReview: false, autoPR: false },
    },
    {
      id: "security",
      label: "🔒 Security audit",
      prompt: "Perform a security audit of the following code. Check for: injection vulnerabilities, authentication/authorization issues, data exposure, insecure dependencies, unsafe deserialization, and missing input validation. Provide specific fixes for each finding.",
      features: { autoReview: true, autoPR: false },
    },
    {
      id: "full-pr",
      label: "🚀 Full PR workflow",
      prompt: "Implement the changes described below. Write clean, well-tested code. After implementation, self-review your work, fix any issues, commit with a descriptive message, and open a pull request.",
      features: { autoReview: true, autoPR: true },
    },
    {
      id: "snippet",
      label: "📋 Quick snippet",
      prompt: null,
      description: "Use hive_snippet for quick, stateless code work — no repo needed. Good for: quick refactors, code explanations, one-off fixes, or generating utility functions.",
      features: {},
    },
  ],

  usage: {
    guided: 'Ask your AI assistant to "show me Hive presets" or "I want to review some code with Hive" — the assistant will present options and dispatch the right tool.',
    direct: 'Call hive_prompt or hive_prompt_pr directly with your task and desired features.',
    quick: 'Use hive_snippet for stateless code work without a repo.',
  },
};

server.tool(
  "hive_guide",
  "Get the Agent Hive features catalog, preset tasks, and model recommendations. Use this to guide users through available capabilities — present presets, help them toggle features, and pick the right model tier for their task. Then dispatch via hive_prompt, hive_prompt_pr, or hive_snippet.",
  {},
  async () => {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(GUIDE, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
