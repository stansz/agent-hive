/**
 * Agent Hive UI — Main entry point
 *
 * Tabs: Chat (pi-web-ui ChatPanel + HiveAgentProxy) | GitHub (custom panel)
 * Token-based auth with localStorage persistence.
 */

import { ChatPanel } from "@mariozechner/pi-web-ui";
import "@mariozechner/pi-web-ui/app.css";
import { HiveAgentProxy } from "./hive-agent.js";
import { GitHubPanel } from "./github-panel.js";

// ---- Config ----

const STORAGE_KEY = "hive_token";

function getServerUrl(): string {
  return window.location.origin;
}

function getStoredToken(): string {
  return localStorage.getItem(STORAGE_KEY) || "";
}

function saveToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

function clearToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ---- State ----

let token = getStoredToken();
let user: { name: string } | null = null;
let agent: HiveAgentProxy | null = null;
let ghPanel: GitHubPanel | null = null;
let chatPanel: ChatPanel | null = null;
let currentTab = "chat";
const serverUrl = getServerUrl();

// ---- DOM helpers ----

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ---- API ----

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${serverUrl}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
}

// ---- Auth ----

async function validateToken(t: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function loadUser(): Promise<void> {
  try {
    const res = await api("/api/user");
    if (res.ok) {
      user = await res.json();
    }
  } catch {
    user = null;
  }
}

async function doLogin(): Promise<void> {
  const input = $("tokenInput") as HTMLInputElement;
  const t = input.value.trim();
  if (!t) return;

  const valid = await validateToken(t);
  if (!valid) {
    const err = $("tokenError");
    if (err) err.classList.add("visible");
    return;
  }

  token = t;
  saveToken(t);
  await loadUser();
  await renderApp();
}

// ---- Chat ----

function createAgent(): HiveAgentProxy {
  agent = new HiveAgentProxy({ serverUrl, token });
  return agent;
}

async function setupChatPanel(): Promise<void> {
  const container = $("chatContainer");
  if (!container) return;

  if (!agent) createAgent();

  try {
    // Try pi-web-ui ChatPanel with our HiveAgentProxy
    // ChatPanel calls setAgent() which expects a pi-agent-core Agent.
    // Our HiveAgentProxy implements the same interface (duck typing).
    chatPanel = new ChatPanel();
    chatPanel.style.flex = "1";
    chatPanel.style.display = "flex";
    chatPanel.style.flexDirection = "column";
    chatPanel.style.overflow = "hidden";

    container.innerHTML = "";
    container.appendChild(chatPanel);

    await (chatPanel as any).setAgent(agent, {
      onApiKeyRequired: async (_provider: string) => {
        // API keys managed server-side
        return true;
      },
    });
    console.log("pi-web-ui ChatPanel initialized successfully");
  } catch (e) {
    console.warn("pi-web-ui ChatPanel failed, using fallback:", e);
    setupFallbackChat(container);
  }
}

function setupFallbackChat(container: HTMLElement): void {
  container.innerHTML = `
    <div class="chat-area" id="fallbackChat" style="flex:1;overflow-y:auto;padding:16px;"></div>
    <div class="chat-input">
      <textarea id="fallbackInput" placeholder="Send a message..." style="flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px 12px;font-size:14px;resize:none;min-height:42px;max-height:120px;"></textarea>
      <button id="fallbackSend" style="padding:10px 20px;background:var(--accent);color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px;">Send</button>
    </div>
  `;

  const input = $("fallbackInput") as HTMLTextAreaElement;
  const send = $("fallbackSend") as HTMLButtonElement;
  const area = $("fallbackChat")!;

  const sendMsg = async () => {
    const text = input.value.trim();
    if (!text || !agent) return;
    input.value = "";
    send.disabled = true;

    const userDiv = document.createElement("div");
    userDiv.className = "msg user";
    userDiv.textContent = text;
    area.appendChild(userDiv);

    const streamDiv = document.createElement("div");
    streamDiv.className = "msg assistant streaming";
    area.appendChild(streamDiv);

    let buffer = "";
    const unsub = agent.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        buffer += event.assistantMessageEvent.delta;
        streamDiv.textContent = buffer;
        area.scrollTop = area.scrollHeight;
      }
      if (event.type === "agent_end") {
        streamDiv.classList.remove("streaming");
        send.disabled = false;
        unsub();
      }
    });

    try {
      await agent.prompt(text);
    } catch (e: any) {
      streamDiv.textContent = `Error: ${e.message}`;
      streamDiv.style.color = "#fca5a5";
      streamDiv.style.background = "#450a0a";
      send.disabled = false;
      unsub();
    }
  };

  send.onclick = sendMsg;
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMsg();
    }
  };
}

// ---- Tabs ----

function switchTab(tab: string): void {
  currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", (panel as HTMLElement).dataset.tab === tab);
  });

  if (tab === "github" && ghPanel) {
    ghPanel.setMode((ghPanel as any)._mode || "mine");
    ghPanel.refresh();
  }
}

// ---- Token Gate ----

function renderTokenGate(): void {
  const app = $("app")!;
  app.innerHTML = `
    <div class="token-gate">
      <div class="token-gate-inner">
        <h2>🐝 Agent Hive</h2>
        <p>Enter your API token to continue</p>
        <input type="password" id="tokenInput" placeholder="hive_token_..." autofocus>
        <button onclick="window._login()">Connect</button>
        <div class="token-error" id="tokenError">Invalid token — check your connection and try again</div>
      </div>
    </div>
  `;
  $("tokenInput")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") doLogin();
  });
}

// ---- Main Layout ----

async function renderMainLayout(): Promise<void> {
  const app = $("app")!;

  if (!agent) createAgent();
  ghPanel = new GitHubPanel(token, serverUrl);

  (window as any)._ghPanel = ghPanel;
  (window as any)._login = doLogin;
  (window as any)._switchTab = switchTab;
  (window as any)._logout = () => { clearToken(); location.reload(); };

  const userName = user?.name || "User";

  app.innerHTML = `
    <div class="header">
      <div class="header-left">
        <h1>🐝 <span>Agent Hive</span></h1>
        <div class="tabs">
          <button class="tab-btn active" data-tab="chat" onclick="window._switchTab('chat')">💬 Chat</button>
          <button class="tab-btn" data-tab="github" onclick="window._switchTab('github')">🐙 GitHub</button>
        </div>
      </div>
      <div class="header-right">
        <span class="user-badge">${userName}</span>
        <button onclick="window._logout()" style="background:none;border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;">Logout</button>
      </div>
    </div>
    <div class="main">
      <div class="tab-panel active" data-tab="chat" id="chatContainer"
           style="display:flex;flex-direction:column;overflow:hidden;">
      </div>

      <div class="tab-panel" data-tab="github">
        <div class="gh-layout">
          <div class="gh-sidebar">
            <div class="gh-sidebar-header">
              <div class="gh-mode-toggle">
                <button class="gh-mode-btn active" id="modeMine" data-mode="mine"
                        onclick="window._ghPanel.setMode('mine')">My Repos</button>
                <button class="gh-mode-btn" id="modeSearch" data-mode="search"
                        onclick="window._ghPanel.setMode('search')">Search</button>
              </div>
              <input type="text" id="repoFilter" placeholder="Filter repos..."
                     oninput="window._ghPanel.onFilterInput()">
            </div>
            <div class="gh-repo-list" id="repoList"></div>
            <div class="gh-actions" id="ghActions">
              <button onclick="window._ghPanel.refresh()">🔄 Refresh</button>
            </div>
          </div>
          <div class="gh-main">
            <div class="gh-toolbar">
              <strong id="ghRepoName" style="color:var(--accent)">Select a repo</strong>
              <span class="branch" id="ghBranch"></span>
              <span class="status" id="ghStatus"></span>
            </div>
            <div id="ghEmpty" class="gh-empty">Select a repository from the sidebar</div>
            <div id="ghContent" style="display:none;flex-direction:column;flex:1;overflow:hidden;">
              <div class="gh-files" id="ghFiles"></div>
            </div>
            <div class="gh-log" id="ghLog" style="display:none;"></div>
          </div>
        </div>
        <div class="modal-overlay" id="commitModal">
          <div class="modal">
            <h3>Commit & Push</h3>
            <input type="text" id="commitMsg" placeholder="Commit message" maxlength="200">
            <div class="modal-btns">
              <button class="cancel" onclick="window._ghPanel.closeCommitModal()">Cancel</button>
              <button class="confirm" onclick="window._ghPanel.confirmPush()">Push</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  ghPanel.refresh();
  await setupChatPanel();
}

// ---- Init ----

async function renderApp(): Promise<void> {
  if (!token) {
    renderTokenGate();
    return;
  }

  const valid = await validateToken(token);
  if (!valid) {
    clearToken();
    token = "";
    renderTokenGate();
    return;
  }

  await loadUser();
  await renderMainLayout();
}

renderApp();
