import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { type Model } from "@mariozechner/pi-ai";

// Provider configs for auto-registration (OpenAI-compatible APIs)
export const PROVIDER_CONFIGS: Record<
  string,
  { envKey: string; baseUrl: string }
> = {
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  zai: { envKey: "ZAI_CODE", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  deepseek: {
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
  },
};

/** Auto-detect provider: explicit arg > DEFAULT_PROVIDER env > detect from available keys > openrouter */
export function resolveProvider(explicit?: string): string {
  return (
    explicit ||
    process.env.DEFAULT_PROVIDER ||
    (process.env.ZAI_CODE ? "zai" : undefined) ||
    (process.env.DEEPSEEK_API_KEY ? "deepseek" : undefined) ||
    (process.env.OPENROUTER_API_KEY ? "openrouter" : undefined) ||
    (process.env.ANTHROPIC_API_KEY ? "anthropic" : undefined) ||
    "openrouter"
  );
}

interface ManagedSession {
  sessionId: string;
  session: any;
  model?: any;
  thinkingLevel: string;
  createdAt: number;
  lastActivity: number;
  unsubscribe: () => void;
}

const sessions = new Map<string, ManagedSession>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

const MAX_CONCURRENT = parseInt(
  process.env.MAX_CONCURRENT_SESSIONS || "3",
  10
);
const IDLE_TIMEOUT = parseInt(
  process.env.SESSION_IDLE_TIMEOUT_MS || "1800000",
  10
);
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || "openrouter";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "";
const DEFAULT_THINKING = process.env.DEFAULT_THINKING || "off";

function resetIdleTimer(sessionId: string) {
  clearTimeout(idleTimers.get(sessionId));
  idleTimers.set(
    sessionId,
    setTimeout(() => destroySession(sessionId), IDLE_TIMEOUT)
  );
}

export async function createManagedSession(opts: {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  cwd?: string;  // Working directory for AGENTS.md auto-discovery
}) {
  if (sessions.size >= MAX_CONCURRENT) {
    throw new Error("Max concurrent sessions reached");
  }

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // Register custom provider API keys with AuthStorage
  for (const [provider, providerEnv] of Object.entries(PROVIDER_CONFIGS)) {
    const key = process.env[providerEnv.envKey];
    if (key && !authStorage.hasAuth(provider)) {
      try {
        await authStorage.setRuntimeApiKey(provider, key);
        console.log(`Registered API key for custom provider: ${provider}`);
      } catch (e: any) {
        console.warn(`Failed to register key for ${provider}: ${e.message}`);
      }
    }
  }

  // Resolve model upfront (supports DEFAULT_MODEL from env)
  const modelName = opts.model || DEFAULT_MODEL;
  const provider = resolveProvider(opts.provider);
  let model: any = undefined;
  const thinkingLevel = (opts.thinkingLevel || DEFAULT_THINKING) as any;

  if (modelName) {
    // Try ModelRegistry first (finds built-in + custom models)
    model = modelRegistry.find(provider as any, modelName);

    // Fallback: auto-register unknown models for known OpenAI-compatible providers
    if (!model && PROVIDER_CONFIGS[provider]) {
      const cfg = PROVIDER_CONFIGS[provider];
      if (process.env[cfg.envKey]) {
        const customModel: Model<"openai-completions"> = {
          id: modelName,
          name: modelName,
          api: "openai-completions",
          provider,
          baseUrl: cfg.baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        };
        model = customModel;
        console.log(`Registered unknown ${provider} model on-the-fly: ${modelName}`);
      }
    }

    if (model) {
      console.log(`Model resolved: ${provider}/${modelName}`);
    } else {
      console.warn(`Model not found: ${provider}/${modelName}, using default`);
    }
  }

  // Pass cwd so pi auto-discovers AGENTS.md from the repo
  const sessionOpts: any = {
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model,
    thinkingLevel,
  };
  if (opts.cwd) {
    sessionOpts.cwd = opts.cwd;
  }

  const { session } = await createAgentSession(sessionOpts);
  console.log(`Session created: model=${session.model?.id || "default"}, thinking=${thinkingLevel}`);

  const now = Date.now();
  const managed: ManagedSession = {
    sessionId: session.sessionId,
    session: session,
    model: session.model,
    thinkingLevel: thinkingLevel,
    createdAt: now,
    lastActivity: now,
    unsubscribe: () => {},
  };

  managed.unsubscribe = session.subscribe((event) => {
    managed.lastActivity = Date.now();
  });

  sessions.set(session.sessionId, managed);
  resetIdleTimer(session.sessionId);

  return managed;
}

export function getSession(id: string) {
  return sessions.get(id);
}

export function destroySession(id: string) {
  const managed = sessions.get(id);
  if (managed) {
    clearTimeout(idleTimers.get(id));
    idleTimers.delete(id);
    managed.unsubscribe();
    managed.session.dispose();
    sessions.delete(id);
    console.log(`Session ${id} destroyed (idle timeout)`);
  }
}

export function touchIdleTimer(sessionId: string) {
  if (sessions.has(sessionId)) {
    sessions.get(sessionId)!.lastActivity = Date.now();
    resetIdleTimer(sessionId);
  }
}

export function getSessionCount() {
  return sessions.size;
}

/**
 * Create a session without registering it in the sessions Map.
 * Used for ephemeral sub-sessions (e.g. review/fix cycles) that don't need
 * idle timers or WebSocket streaming.
 */
export async function createEphemeralSession(opts: {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}) {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  for (const [provider, providerEnv] of Object.entries(PROVIDER_CONFIGS)) {
    const key = process.env[providerEnv.envKey];
    if (key && !authStorage.hasAuth(provider)) {
      try {
        await authStorage.setRuntimeApiKey(provider, key);
      } catch (e: any) {
        console.warn(`Failed to register key for ${provider}: ${e.message}`);
      }
    }
  }

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
  });

  if (opts.model) {
    const provider = resolveProvider(opts.provider) as any;
    let model = modelRegistry.find(provider, opts.model);

    if (!model && PROVIDER_CONFIGS[provider]) {
      const cfg = PROVIDER_CONFIGS[provider];
      if (process.env[cfg.envKey]) {
        const customModel: Model<"openai-completions"> = {
          id: opts.model,
          name: opts.model,
          api: "openai-completions",
          provider,
          baseUrl: cfg.baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        };
        model = customModel;
      }
    }

    if (model) {
      await session.setModel(model);
    }
  }

  if (opts.thinkingLevel) {
    session.setThinkingLevel(
      opts.thinkingLevel as
        | "off"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
    );
  }

  return session;
}
