/**
 * GitHub Panel — repo browser with clone, fork, branch, commit, push.
 * Ported from the existing vanilla JS panel, converted to TypeScript.
 */

interface Repo {
  name: string;
  fullName?: string;
  description?: string;
  visibility?: string;
  stargazersCount?: number;
  language?: string;
  owner?: { login: string };
}

interface RepoStatus {
  branch?: string;
  status?: string;
  recentCommits?: string[];
}

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export class GitHubPanel {
  private token: string;
  private serverUrl: string;
  private repos: Repo[] = [];
  private searchResults: Repo[] = [];
  private activeRepo: string | null = null;
  private mode: "mine" | "search" = "mine";
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;
  private pushTarget: string | null = null;

  constructor(token: string, serverUrl: string) {
    this.token = token;
    this.serverUrl = serverUrl;
  }

  private api(path: string, opts: RequestInit = {}): Promise<Response> {
    return fetch(`${this.serverUrl}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
    });
  }

  async refresh(): Promise<void> {
    try {
      const res = await this.api("/api/github/repos");
      this.repos = await res.json();
      this.renderRepos();
    } catch (e) {
      console.error("Failed to load repos:", e);
    }
  }

  setMode(mode: "mine" | "search"): void {
    this.mode = mode;
    document.getElementById("modeMine")?.classList.toggle("active", mode === "mine");
    document.getElementById("modeSearch")?.classList.toggle("active", mode === "search");
    const input = document.getElementById("repoFilter") as HTMLInputElement;
    if (input) {
      input.value = "";
      input.placeholder = mode === "search"
        ? 'Search public repos (e.g. "fastapi web framework")'
        : "Filter repos...";
    }
    if (mode === "mine") this.renderRepos();
  }

  onFilterInput(): void {
    if (this.mode === "mine") {
      this.renderRepos();
      return;
    }
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    const input = document.getElementById("repoFilter") as HTMLInputElement;
    const q = input?.value?.trim() || "";
    if (q.length < 2) {
      const list = document.getElementById("repoList");
      if (list) list.innerHTML = "";
      return;
    }
    this.searchTimeout = setTimeout(() => this.searchRepos(q), 500);
  }

  private async searchRepos(q: string): Promise<void> {
    try {
      const res = await this.api(`/api/github/search?q=${encodeURIComponent(q)}`);
      this.searchResults = await res.json();
      this.renderSearchResults();
    } catch (e) {
      console.error("Search failed:", e);
    }
  }

  private renderSearchResults(): void {
    const list = document.getElementById("repoList");
    if (!list) return;
    list.innerHTML = "";
    if (!this.searchResults.length) {
      list.innerHTML = '<div style="padding:12px;color:var(--text2);font-size:13px">No results</div>';
      return;
    }
    this.searchResults.forEach((r) => {
      const div = document.createElement("div");
      div.className = "gh-repo-item";
      const stars = r.stargazersCount ? ` ⭐${r.stargazersCount}` : "";
      const lang = r.language ? ` <span style="color:var(--purple);font-size:11px">${r.language}</span>` : "";
      div.innerHTML = `<div class="gh-repo-name">${r.name}${stars}${lang}</div><div class="gh-repo-desc">${r.description || ""}</div>`;
      div.onclick = () => this.forkAndClone(r.fullName || r.name);
      list.appendChild(div);
    });
  }

  private renderRepos(): void {
    const filter = (document.getElementById("repoFilter") as HTMLInputElement)?.value?.toLowerCase() || "";
    const list = document.getElementById("repoList");
    if (!list) return;
    list.innerHTML = "";
    this.repos
      .filter((r) => !filter || r.name.toLowerCase().includes(filter) || (r.description || "").toLowerCase().includes(filter))
      .forEach((r) => {
        const div = document.createElement("div");
        div.className = "gh-repo-item" + (this.activeRepo === r.name ? " active" : "");
        div.innerHTML = `<div class="gh-repo-name">${r.name} ${r.visibility === "private" ? "🔒" : ""}</div><div class="gh-repo-desc">${r.description || ""}</div>`;
        div.onclick = () => this.selectRepo(r.name);
        list.appendChild(div);
      });
  }

  async selectRepo(name: string): Promise<void> {
    this.activeRepo = name;
    this.renderRepos();
    const empty = document.getElementById("ghEmpty");
    const content = document.getElementById("ghContent");
    if (empty) empty.style.display = "none";
    if (content) content.style.display = "flex";
    const nameEl = document.getElementById("ghRepoName");
    if (nameEl) nameEl.textContent = name;
    await Promise.all([this.loadRepoStatus(name), this.loadFiles(name)]);
  }

  private async loadRepoStatus(name: string): Promise<void> {
    try {
      const res = await this.api(`/api/github/status/${name}`);
      const data: RepoStatus & { error?: string } = await res.json();
      const actionsEl = document.getElementById("ghActions");
      const branchEl = document.getElementById("ghBranch");
      const statusEl = document.getElementById("ghStatus");
      const filesEl = document.getElementById("ghFiles");
      const logEl = document.getElementById("ghLog");

      if (!res.ok || data.error) {
        if (actionsEl) actionsEl.innerHTML = `<button onclick="window._ghPanel.cloneRepo('${name}')">📥 Clone</button>`;
        if (branchEl) branchEl.textContent = "";
        if (statusEl) statusEl.textContent = "Not cloned";
        if (filesEl) filesEl.innerHTML = '<div class="gh-empty">Clone this repo to get started</div>';
        if (logEl) logEl.style.display = "none";
        return;
      }

      if (branchEl) branchEl.textContent = data.branch || "";
      const changes = data.status ? data.status.split("\n").length : 0;
      if (statusEl) statusEl.textContent = changes > 0 ? `${changes} change(s)` : "Clean";
      if (actionsEl) {
        actionsEl.innerHTML = `
          <button onclick="window._ghPanel.pullRepo('${name}')">📥 Pull</button>
          <button onclick="window._ghPanel.newBranch('${name}')">🌿 Branch</button>
          <button onclick="window._ghPanel.openCommitModal('${name}')">📤 Push</button>
          <button onclick="window._ghPanel.refreshStatus('${name}')">🔄</button>
        `;
      }
      if (data.recentCommits && data.recentCommits[0] && logEl) {
        logEl.style.display = "block";
        logEl.textContent = data.recentCommits.join("\n");
      }
    } catch (e) {
      console.error("loadRepoStatus error:", e);
    }
  }

  private async loadFiles(name: string, path = ""): Promise<void> {
    try {
      const res = await this.api(`/api/github/files/${name}?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      const filesEl = document.getElementById("ghFiles");
      if (!filesEl) return;
      if (!res.ok || !data.files) {
        filesEl.innerHTML = '<div class="gh-empty">No files</div>';
        return;
      }
      filesEl.innerHTML = "";
      if (path) {
        const back = document.createElement("div");
        back.className = "gh-file";
        back.innerHTML = '<span class="icon dir">📁</span> ..';
        back.onclick = () => this.loadFiles(name, path.split("/").slice(0, -1).join("/"));
        filesEl.appendChild(back);
      }
      (data.files as FileEntry[]).forEach((f) => {
        const div = document.createElement("div");
        div.className = "gh-file";
        const icon = f.type === "dir" ? "📁" : this.getFileIcon(f.name);
        const iconClass = f.type === "dir" ? "dir" : "file";
        const size = f.type === "file" ? this.formatSize(f.size || 0) : "";
        div.innerHTML = `<span class="icon ${iconClass}">${icon}</span> ${f.name} <span class="size">${size}</span>`;
        if (f.type === "dir") {
          div.onclick = () => this.loadFiles(name, path ? `${path}/${f.name}` : f.name);
        }
        filesEl.appendChild(div);
      });
    } catch (e) {
      console.error("loadFiles error:", e);
    }
  }

  private getFileIcon(name: string): string {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const icons: Record<string, string> = {
      ts: "🔷", js: "📜", json: "📋", md: "📝", py: "🐍",
      html: "🌐", css: "🎨", sh: "⚡", yml: "⚙️", yaml: "⚙️",
      toml: "⚙️", sql: "🗃️",
    };
    return icons[ext] || "📄";
  }

  private formatSize(b: number): string {
    if (b < 1024) return b + "B";
    if (b < 1048576) return (b / 1024).toFixed(1) + "K";
    return (b / 1048576).toFixed(1) + "M";
  }

  async cloneRepo(name: string): Promise<void> {
    const repo = this.repos.find((r) => r.name === name);
    if (!repo) return;
    const fullName = repo.fullName || (repo.owner?.login ? `${repo.owner.login}/${name}` : name);
    const res = await this.api("/api/github/clone", {
      method: "POST",
      body: JSON.stringify({ repo: fullName }),
    });
    const data = await res.json();
    if (res.ok) {
      this.loadRepoStatus(name);
      this.loadFiles(name);
    } else {
      alert("Clone failed: " + data.error);
    }
  }

  async pullRepo(name: string): Promise<void> {
    const res = await this.api("/api/github/pull", {
      method: "POST",
      body: JSON.stringify({ repo: name }),
    });
    const data = await res.json();
    if (res.ok) {
      this.loadRepoStatus(name);
      this.loadFiles(name);
    } else {
      alert("Pull failed: " + data.error);
    }
  }

  async newBranch(name: string): Promise<void> {
    const branch = prompt("New branch name:");
    if (!branch) return;
    const res = await this.api("/api/github/branch", {
      method: "POST",
      body: JSON.stringify({ repo: name, branch }),
    });
    const data = await res.json();
    if (res.ok) {
      this.loadRepoStatus(name);
    } else {
      alert("Branch failed: " + data.error);
    }
  }

  openCommitModal(name: string): void {
    this.pushTarget = name;
    (document.getElementById("commitMsg") as HTMLInputElement).value = "";
    document.getElementById("commitModal")?.classList.add("active");
    document.getElementById("commitMsg")?.focus();
  }

  closeCommitModal(): void {
    document.getElementById("commitModal")?.classList.remove("active");
  }

  async confirmPush(): Promise<void> {
    const msg = (document.getElementById("commitMsg") as HTMLInputElement)?.value?.trim() || "Update from Hive UI";
    this.closeCommitModal();
    if (!this.pushTarget) return;
    const res = await this.api("/api/github/push", {
      method: "POST",
      body: JSON.stringify({ repo: this.pushTarget, message: msg }),
    });
    const data = await res.json();
    if (res.ok) {
      this.loadRepoStatus(this.pushTarget);
    } else {
      alert("Push failed: " + data.error);
    }
  }

  refreshStatus(name: string): void {
    this.loadRepoStatus(name);
    this.loadFiles(name);
  }

  private async forkAndClone(fullName: string): Promise<void> {
    const name = fullName.split("/").pop() || fullName;
    if (confirm(`Fork ${fullName} into oatclaw88 and clone?`)) {
      try {
        const res = await this.api("/api/github/fork", {
          method: "POST",
          body: JSON.stringify({ repo: fullName }),
        });
        const data = await res.json();
        if (res.ok) {
          await this.refresh();
          setTimeout(() => this.selectRepo(name), 1000);
        } else {
          alert("Fork failed: " + data.error);
        }
      } catch (e: any) {
        alert("Error: " + e.message);
      }
    }
  }
}
