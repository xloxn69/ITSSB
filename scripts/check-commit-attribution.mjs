#!/usr/bin/env node
// Fails when a commit in BASE..HEAD carries AI attribution or a
// non-conventional subject (AGENTS.md "No AI attribution", "Git workflow").
//
// Usage: node scripts/check-commit-attribution.mjs <base> <head>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DISALLOWED = [
  /^\s*(?:co-authored-by|signed-off-by):.*\b(?:claude|anthropic|chatgpt|openai|codex|gemini|copilot|ai assistant)\b/i,
  /^\s*(?:claude|chatgpt|codex|gemini|copilot)-session\s*:/i,
  /generated (?:with|by)\s+\[?(?:claude(?: code)?|chatgpt|codex|gemini|copilot|an? ai assistant)/i,
  /^\s*🤖/u,
];

const CONVENTIONAL =
  /^(feat|fix|docs|refactor|chore|test|perf|ci|build|style|revert)(\([^()\s][^()]*\))?!?: \S/;

/** Lines of a commit message that disclose AI or tool authorship. */
export function attributionLines(message) {
  return String(message ?? "")
    .split(/\r?\n/)
    .filter((line) => DISALLOWED.some((pattern) => pattern.test(line)));
}

/** Why a subject breaks the convention, or null. Git's own merge and revert subjects pass. */
export function subjectProblem(subject) {
  if (CONVENTIONAL.test(subject) || subject.startsWith("Merge ") || subject.startsWith('Revert "')) {
    return null;
  }
  return (
    `"${subject}" is not a conventional subject. Start it with a type and a colon, ` +
    'for example "fix(device): reuse the eventId on retry".'
  );
}

function commitsInRange(base, head) {
  const log = execFileSync("git", ["log", "--format=%H%x00%B%x00", `${base}..${head}`], {
    encoding: "utf8",
  });
  const fields = log.split("\0");
  const commits = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i].trim();
    if (sha) commits.push({ sha, message: fields[i + 1].trim() });
  }
  return commits;
}

export function problemsInRange(base, head) {
  const problems = [];
  for (const { sha, message } of commitsInRange(base, head)) {
    const short = sha.slice(0, 7);
    for (const line of attributionLines(message)) {
      problems.push(`${short}: AI attribution "${line.trim()}"`);
    }
    const subjectIssue = subjectProblem(message.split(/\r?\n/)[0] ?? "");
    if (subjectIssue) problems.push(`${short}: ${subjectIssue}`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base) {
    console.error("Usage: node scripts/check-commit-attribution.mjs <base> [head]");
    process.exit(2);
  }
  const problems = problemsInRange(base, head);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(
      "\nAGENTS.md forbids AI attribution and requires conventional subjects. " +
        "Remove the trailer or reword the subject (git rebase -i, or git commit --amend " +
        "for the last commit), then force-push your branch with --force-with-lease.",
    );
    process.exit(1);
  }
  process.stdout.write(`OK: no AI attribution or non-conventional subjects in ${base}..${head}\n`);
}
