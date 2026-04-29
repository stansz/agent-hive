import { createEphemeralSession } from "../sessions/manager.js";

const REVIEW_PROMPT = `Review the following code/output thoroughly. Find bugs, logic errors, edge cases, security issues, and style problems. Give specific, actionable feedback.`;

const FIX_PROMPT = `Apply all fixes identified in this review. Fix every issue mentioned. Return the corrected code.`;

/**
 * Collect text output from a session by subscribing to text_delta events,
 * prompting, and returning the accumulated text. Disposes the session when done.
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

    // Step A: Review session
    const reviewSession = await createEphemeralSession({
      provider: options.provider,
      model: effectiveModel,
    });

    const reviewText = await collectText(
      reviewSession,
      `${REVIEW_PROMPT}\n\nCode/output to review:\n\`\`\`\n${currentOutput}\n\`\`\``
    );
    console.log(`Review cycle ${i + 1}: review output ${reviewText.length} chars`);

    // Step B: Fix session
    const fixSession = await createEphemeralSession({
      provider: options.provider,
      model: effectiveModel,
    });

    const fixPrompt = `Here is the review:\n\n${reviewText}\n\nHere is the original code/output:\n\`\`\`\n${currentOutput}\n\`\`\`\n\n${FIX_PROMPT}`;

    const fixedOutput = await collectText(fixSession, fixPrompt);
    console.log(`Review cycle ${i + 1}: fixed output ${fixedOutput.length} chars`);

    currentOutput = fixedOutput;
  }

  return currentOutput;
}
