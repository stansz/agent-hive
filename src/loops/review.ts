import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createEphemeralSession } from "../sessions/manager.js";

const execFileAsync = promisify(execFile);

// Code review prompts
const REVIEW_PROMPT = `You are reviewing a git diff from a coding task. Perform a thorough code review.

Check for:
1. **Bugs** — logic errors, off-by-one, null/undefined, race conditions
2. **Security** — injection, auth issues, data exposure, unsafe deserialization
3. **Edge cases** — empty inputs, boundary conditions, error paths
4. **Style** — naming, consistency with surrounding code, unnecessary complexity
5. **Correctness** — does the change actually do what the task asked for?

For each issue found, give:
- File and approximate location
- Severity (critical / warning / nit)
- What's wrong
- Suggested fix (code snippet)

If the code looks good, say "LGTM" with a brief summary of what changed.`;

const FIX_PROMPT = `You are applying fixes from a code review. The repo is at {{REPO_DIR}}.

Here is the review feedback:
{{REVIEW}}

Here is the original diff for context:
{{DIFF}}

Apply ALL critical and warning fixes directly in the repo. Read the files, make the edits, and save them. Skip nits unless they're trivial. After fixing, run a quick mental check that the fix doesn't break anything else.`;

/**
 * Run git diff in a repo directory
 */
async function gitDiff(repoDir: string, baseSha: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", baseSha], {
      cwd: repoDir,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    // If diff fails (e.g. no commits yet), try diff against empty tree
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--cached"], {
        cwd: repoDir,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch {
      throw new Error(`Failed to get diff: ${err.message}`);
    }
  }
}

/**
 * Collect text output from a session by subscribing to text_delta events.
 * Disposes the session when done.
 */
async function collectText(session: any, promptText: string): Promise<string> {
  let text = "";
  const unsub = session.subscribe((event: any) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(promptText);
  } finally {
    unsub();
    try {
      session.dispose();
    } catch {
      // ignore dispose errors on ephemeral sessions
    }
  }

  return text;
}

/**
 * Proper code review: diff-based review + in-repo fixes.
 * 
 * 1. Gets the actual git diff of changes
 * 2. Review session analyzes the diff
 * 3. If issues found, fix session edits files directly in the repo
 * 4. Commits the fixes
 */
export async function runCodeReview(
  repoDir: string,
  baseSha: string,
  options: {
    cycles: number;
    provider: string;
    reviewModel?: string;
    mainModel?: string;
  }
): Promise<{ reviewed: boolean; issuesFound: boolean; diffSize: number }> {
  const effectiveModel = options.reviewModel || options.mainModel;

  // Get the actual diff
  const diff = await gitDiff(repoDir, baseSha);
  
  if (!diff || diff.trim().length === 0) {
    console.log("No changes to review");
    return { reviewed: false, issuesFound: false, diffSize: 0 };
  }

  console.log(`Review: diff is ${diff.length} chars against ${baseSha.substring(0, 8)}`);
  let issuesFound = false;

  for (let i = 0; i < options.cycles; i++) {
    console.log(`Review cycle ${i + 1}/${options.cycles} (model: ${effectiveModel || "default"})`);

    // Step A: Review the actual diff
    const reviewSession = await createEphemeralSession({
      provider: options.provider,
      model: effectiveModel,
    });

    const reviewText = await collectText(
      reviewSession,
      `${REVIEW_PROMPT}\n\nDiff to review:\n\`\`\`diff\n${diff}\n\`\`\``
    );
    console.log(`Review cycle ${i + 1}: review output ${reviewText.length} chars`);

    // Check if review found issues (LGTM = no issues)
    const isLgtm = /^(LGTM|looks good|no issues|clean)/i.test(reviewText.trim());
    
    if (isLgtm && i === 0) {
      console.log(`Review cycle ${i + 1}: LGTM, skipping fix pass`);
      break;
    }

    issuesFound = true;

    // Step B: Fix session works directly in the repo
    // Create a session with cwd=repoDir so it can read/write files
    const { createManagedSession } = await import("../sessions/manager.js");
    
    // Use ephemeral approach but with cwd set
    const { createAgentSession, AuthStorage, ModelRegistry, SessionManager } = await import("@mariozechner/pi-coding-agent");
    const { Model } = await import("@mariozechner/pi-ai");
    
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    
    // Register provider keys
    const { PROVIDER_CONFIGS } = await import("../sessions/manager.js");
    for (const [provider, providerEnv] of Object.entries(PROVIDER_CONFIGS)) {
      const key = process.env[providerEnv.envKey];
      if (key && !authStorage.hasAuth(provider)) {
        try {
          await authStorage.setRuntimeApiKey(provider, key);
        } catch {}
      }
    }

    const { session: fixSession } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      cwd: repoDir,
    } as any);

    // Set model
    if (effectiveModel) {
      const provider = options.provider as any;
      let model = modelRegistry.find(provider, effectiveModel);
      if (!model && PROVIDER_CONFIGS[provider]) {
        const cfg = PROVIDER_CONFIGS[provider];
        if (process.env[cfg.envKey]) {
          model = {
            id: effectiveModel,
            name: effectiveModel,
            api: "openai-completions",
            provider,
            baseUrl: cfg.baseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384,
          };
        }
      }
      if (model) await fixSession.setModel(model);
    }

    const fixPrompt = FIX_PROMPT
      .replace("{{REPO_DIR}}", repoDir)
      .replace("{{REVIEW}}", reviewText)
      .replace("{{DIFF}}", diff);

    // Collect output and wait for completion
    let fixOutput = "";
    const fixUnsub = fixSession.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        fixOutput += event.assistantMessageEvent.delta;
      }
    });

    try {
      await fixSession.prompt(fixPrompt);
    } finally {
      fixUnsub();
      try { fixSession.dispose(); } catch {}
    }

    console.log(`Review cycle ${i + 1}: fix output ${fixOutput.length} chars`);

    // Commit the fixes
    try {
      await execFileAsync("git", ["add", "-A"], { cwd: repoDir, timeout: 10000 });
      await execFileAsync("git", ["commit", "-m", `review: apply fixes from cycle ${i + 1}`, "--allow-empty"], {
        cwd: repoDir,
        timeout: 10000,
      });
      console.log(`Review cycle ${i + 1}: fixes committed`);
    } catch (err: any) {
      console.warn(`Review cycle ${i + 1}: commit failed or no changes: ${err.message}`);
    }
  }

  return { reviewed: true, issuesFound, diffSize: diff.length };
}

/**
 * Legacy text-based review (kept for non-repo / snippet tasks).
 * Reviews LLM text output, not actual code diffs.
 */
export async function runReviewLoop(
  initialOutput: string,
  options: {
    cycles: number;
    provider: string;
    reviewModel?: string;
    mainModel?: string;
  }
): Promise<string> {
  let currentOutput = initialOutput;
  const effectiveModel = options.reviewModel || options.mainModel;

  for (let i = 0; i < options.cycles; i++) {
    console.log(
      `Review cycle ${i + 1}/${options.cycles} (model: ${effectiveModel || "default"})`
    );

    const reviewSession = await createEphemeralSession({
      provider: options.provider,
      model: effectiveModel,
    });

    const reviewText = await collectText(
      reviewSession,
      `Review the following code/output thoroughly. Find bugs, logic errors, edge cases, security issues, and style problems. Give specific, actionable feedback.\n\nCode/output to review:\n\`\`\`\n${currentOutput}\n\`\`\``
    );
    console.log(`Review cycle ${i + 1}: review output ${reviewText.length} chars`);

    const fixSession = await createEphemeralSession({
      provider: options.provider,
      model: effectiveModel,
    });

    const fixPrompt = `Here is the review:\n\n${reviewText}\n\nHere is the original code/output:\n\`\`\`\n${currentOutput}\n\`\`\`\n\nApply all fixes identified in this review. Fix every issue mentioned. Return the corrected code.`;

    const fixedOutput = await collectText(fixSession, fixPrompt);
    console.log(`Review cycle ${i + 1}: fixed output ${fixedOutput.length} chars`);

    currentOutput = fixedOutput;
  }

  return currentOutput;
}
