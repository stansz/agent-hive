/**
 * Auto-route thinking level based on prompt complexity.
 *
 * Signals used:
 * - Prompt length (short = simple)
 * - Keyword matching (complexity indicators)
 * - Task type detection (fix bug vs build feature vs refactor)
 */

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

interface ComplexityScore {
  score: number; // 0-100
  signals: string[];
}

const COMPLEX_KEYWORDS: Record<string, number> = {
  // Architecture / complex tasks
  "architecture": 30,
  "redesign": 25,
  "refactor": 20,
  "migrate": 25,
  "implement": 15,
  "optimize": 20,
  "performance": 15,
  "scalable": 20,

  // Multi-file indicators
  "add support for": 25,
  "integrate": 20,
  "create a new": 15,
  "build a": 15,
  "full stack": 25,
  "end to end": 20,
  "api": 10,
  "database": 15,
  "authentication": 20,

  // Debugging / analysis
  "debug": 20,
  "investigate": 25,
  "analyze": 20,
  "figure out": 15,
  "why is": 15,
  "fix the": 10,
  "broken": 15,

  // Testing
  "test": 10,
  "tdd": 15,
  "unit test": 15,
  "integration test": 20,

  // Security
  "security": 25,
  "vulnerability": 30,
  "xss": 25,
  "sql injection": 25,
  "auth": 15,
};

const SIMPLE_KEYWORDS: string[] = [
  "rename",
  "delete",
  "remove",
  "format",
  "lint",
  "fix typo",
  "add comment",
  "update version",
  "bump",
  "what is",
  "how do i",
  "explain",
  "show me",
  "list",
];

export function autoThinkLevel(prompt: string): ThinkingLevel {
  const lower = prompt.toLowerCase();
  const complexity = analyzeComplexity(lower);

  // Check for explicit simplicity signals
  for (const kw of SIMPLE_KEYWORDS) {
    if (lower.includes(kw) && complexity.score < 30) {
      return "off";
    }
  }

  // Route based on score
  if (complexity.score >= 50) return "medium";
  if (complexity.score >= 30) return "low";
  if (complexity.score >= 15) return "minimal";
  return "off";
}

function analyzeComplexity(prompt: string): ComplexityScore {
  let score = 0;
  const signals: string[] = [];

  // Keyword matching
  for (const [keyword, points] of Object.entries(COMPLEX_KEYWORDS)) {
    if (prompt.includes(keyword)) {
      score += points;
      signals.push(`keyword: ${keyword} (+${points})`);
    }
  }

  // Prompt length (longer prompts tend to be more complex)
  if (prompt.length > 500) {
    score += 15;
    signals.push("long prompt (+15)");
  } else if (prompt.length > 200) {
    score += 5;
    signals.push("medium prompt (+5)");
  }

  // Multiple questions/tasks (presence of newlines, bullet points, numbered lists)
  const lines = prompt.split("\n").filter(l => l.trim());
  if (lines.length > 5) {
    score += 10;
    signals.push("multi-step (+10)");
  }

  // Code blocks (indicates the user is providing context)
  if (prompt.includes("```")) {
    score += 10;
    signals.push("includes code (+10)");
  }

  return { score: Math.min(score, 100), signals };
}

// Exported for testing
export { analyzeComplexity };
