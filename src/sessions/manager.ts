import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel, type Model } from "@mariozechner/pi-ai";

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
}) {
  if (sessions.size >= MAX_CONCURRENT) {
    throw new Error("Max concurrent sessions reached");
  }

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
  });

  // Set model if specified
  if (opts.model) {
    // Auto-detect provider: explicit arg > DEFAULT_PROVIDER env > detect from available keys > openrouter
    const provider = (opts.provider
      || process.env.DEFAULT_PROVIDER
      || (process.env.OPENROUTER_API_KEY ? "openrouter" : undefined)
      || (process.env.ANTHROPIC_API_KEY ? "anthropic" : undefined)
      || "openrouter") as any;
    const model = getModel(provider, opts.model);
    if (model) {
      await session.setModel(model);
      console.log(`Model set: ${provider}/${opts.model}`);
    } else {
      console.warn(
        `Model not found: ${provider}/${opts.model}, using default`
      );
    }
  }

  if (opts.thinkingLevel) {
    session.setThinkingLevel(opts.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
  }

  const now = Date.now();
  const managed: ManagedSession = {
    sessionId: session.sessionId,
    session: session,
    model: session.model,
    thinkingLevel: opts.thinkingLevel || session.thinkingLevel,
    createdAt: now,
    lastActivity: now,
    unsubscribe: () => {},
  };

  // Store the real unsubscribe from subscribe
  managed.unsubscribe = session.subscribe((event) => {
    // Event forwarding handled by WebSocket routes
    // Just reset idle timer on activity
    managed.lastActivity = Date.now();
  });

  sessions.set(session.sessionId, managed);
  resetIdleTimer(session.sessionId);

  return session;
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
