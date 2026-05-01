/**
 * HiveAgentProxy — Bridges pi-web-ui's ChatPanel to the Agent Hive server.
 *
 * Mimics the pi-agent-core Agent interface so ChatPanel can render messages,
 * stream tokens, and display tool calls — but all LLM work happens on the server.
 *
 * Flow:
 *   ChatPanel.setAgent(proxy)
 *   User types → ChatPanel calls proxy.prompt(text)
 *   proxy → POST /prompt → server creates session
 *   proxy → WS /events/:id → server streams pi-agent-core events
 *   proxy re-emits events → ChatPanel renders messages
 *   agent_end → promise resolves
 */

export interface HiveAgentConfig {
  /** Base URL of the Agent Hive server (e.g. https://hive.ogsapps.cc) */
  serverUrl: string;
  /** Bearer token for authentication */
  token: string;
}

type Subscriber = (event: any) => void;

export class HiveAgentProxy {
  readonly sessionId: string;

  config: HiveAgentConfig;
  state: {
    messages: any[];
    model: any;
    thinkingLevel: string;
    tools: any[];
    systemPrompt?: string;
  };

  private _subscribers: Set<Subscriber> = new Set();
  private _ws: WebSocket | null = null;
  private _activeSessionId: string | null = null;
  private _promiseResolve: (() => void) | null = null;
  private _promiseReject: ((err: Error) => void) | null = null;
  private _streaming = false;
  private _currentMessageId: string | null = null;
  private _disposed = false;

  constructor(config: HiveAgentConfig) {
    this.sessionId = crypto.randomUUID();
    this.config = config;
    this.state = {
      messages: [],
      model: null,
      thinkingLevel: "off",
      tools: [],
    };
  }

  /** Connect to the server's WebSocket for a session and relay events */
  private _connectWebSocket(sessionId: string): void {
    const wsUrl = this.config.serverUrl.replace(/^http/, "ws");
    const url = `${wsUrl}/events/${sessionId}?token=${encodeURIComponent(this.config.token)}`;

    this._ws = new WebSocket(url);
    this._ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        this._handleEvent(event);
      } catch {
        // ignore malformed messages
      }
    };
    this._ws.onerror = () => {
      // WebSocket errors are noisy but usually recoverable
    };
    this._ws.onclose = () => {
      if (!this._disposed) {
        this._emit({ type: "agent_end" });
      }
      this._resolve();
    };
  }

  /** Process events from the server, update state, and relay to subscribers */
  private _handleEvent(event: any): void {
    if (this._disposed) return;

    // Track streaming state
    if (event.type === "agent_start") {
      this._streaming = true;
    } else if (event.type === "agent_end") {
      this._streaming = false;
    }

    // Track message IDs for text deltas
    if (event.type === "message_start") {
      this._currentMessageId = event.messageId;
    } else if (event.type === "message_end") {
      this._currentMessageId = null;
    }

    // Accumulate text deltas into the state's messages
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      const delta = event.assistantMessageEvent.delta;
      if (delta && this._currentMessageId) {
        // Find or create the current assistant message in state
        let msg = this.state.messages.find(
          (m: any) => m.id === this._currentMessageId
        );
        if (!msg) {
          msg = {
            id: this._currentMessageId,
            role: "assistant",
            content: "",
            timestamp: Date.now(),
          };
          this.state.messages.push(msg);
        }
        // Accumulate streaming content
        if (typeof msg.content === "string") {
          msg.content += delta;
        }
      }
    }

    // Handle tool calls
    if (event.type === "tool_call") {
      const toolMsg = {
        id: event.toolCallId || crypto.randomUUID(),
        role: "tool_use" as const,
        name: event.name || event.toolName,
        input: event.input || event.args || {},
        timestamp: Date.now(),
      };
      this.state.messages.push(toolMsg);
    }

    if (event.type === "tool_result") {
      // Attach result to the matching tool call message
      const toolMsg = this.state.messages.find(
        (m: any) => m.role === "tool_use" && m.id === event.toolCallId
      );
      if (toolMsg) {
        (toolMsg as any).result = event.result || event.output;
      }
    }

    // Handle state-update events (server sends full state snapshots)
    if (event.type === "state-update" && event.state) {
      // Merge server messages — the server is the source of truth
      if (event.state.messages) {
        this.state.messages = event.state.messages;
      }
      if (event.state.model) {
        this.state.model = event.state.model;
      }
      if (event.state.thinkingLevel) {
        this.state.thinkingLevel = event.state.thinkingLevel;
      }
    }

    // Relay the raw event to ChatPanel subscribers
    this._emit(event);
  }

  private _emit(event: any): void {
    for (const sub of this._subscribers) {
      try {
        sub(event);
      } catch {
        // subscriber errors shouldn't break others
      }
    }
  }

  private _resolve(): void {
    if (this._promiseResolve) {
      this._promiseResolve();
      this._promiseResolve = null;
      this._promiseReject = null;
    }
  }

  private _reject(err: Error): void {
    if (this._promiseReject) {
      this._promiseReject(err);
      this._promiseResolve = null;
      this._promiseReject = null;
    }
  }

  // ---- Public API (matches pi-agent-core Agent) ----

  /** Send a message to the agent. Returns a promise that resolves when done. */
  async prompt(
    text: string | { role: string; content: any; attachments?: any[]; timestamp?: number }
  ): Promise<void> {
    if (this._disposed) throw new Error("Agent is disposed");

    const content = typeof text === "string" ? text : text.content;

    // Add user message to state
    this.state.messages.push({
      role: "user",
      content: typeof content === "string" ? content : JSON.stringify(content),
      timestamp: Date.now(),
    });

    // Call server API
    const resp = await fetch(`${this.config.serverUrl}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      body: JSON.stringify({ prompt: typeof content === "string" ? content : content }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || "Prompt failed");
    }

    const data = await resp.json();
    this._activeSessionId = data.sessionId;

    // Connect WebSocket for streaming
    this._connectWebSocket(data.sessionId);

    // Return a promise that resolves when the agent loop finishes
    return new Promise<void>((resolve, reject) => {
      this._promiseResolve = resolve;
      this._promiseReject = reject;
    });
  }

  /** Cancel the current agent run */
  async abort(): Promise<void> {
    if (!this._activeSessionId) return;

    try {
      await fetch(`${this.config.serverUrl}/abort/${this._activeSessionId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
        },
      });
    } catch {
      // best effort
    }

    this._ws?.close();
  }

  /** Subscribe to agent events */
  subscribe(callback: Subscriber): () => void {
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  /** Check if streaming */
  get isStreaming(): boolean {
    return this._streaming;
  }

  /** Get messages */
  get messages(): any[] {
    return this.state.messages;
  }

  /** Set model (updates state) */
  setModel(model: any): void {
    this.state.model = model;
  }

  /** Set thinking level */
  setThinkingLevel(level: string): void {
    this.state.thinkingLevel = level;
  }

  /** Queue a custom message (e.g. from steer) */
  queueMessage(message: any): void {
    this.state.messages.push(message);
  }

  /** Steer: inject a message during streaming */
  steer(message: any): void {
    this.state.messages.push(message);
  }

  /** Cleanup */
  dispose(): void {
    this._disposed = true;
    this._ws?.close();
    this._subscribers.clear();
    this._resolve();
  }

  /** Alias for dispose */
  destroy(): void {
    this.dispose();
  }
}
