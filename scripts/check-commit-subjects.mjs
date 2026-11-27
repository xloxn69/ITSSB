#!/usr/bin/env node
// Fails when a commit in BASE..HEAD has a non-conventional subject
// (AGENTS.md "Git workflow").
//
// Usage: node scripts/check-commit-subjects.mjs <base> [head]
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONVENTIONAL =
  /^(feat|fix|docs|refactor|chore|test|perf|ci|build|style|revert)(\([^()\s][^()]*\))?!?: \S/;

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

export function problemsInRange(base, head) {
  const log = execFileSync("git", ["log", "--format=%h %s", `${base}..${head}`], {
    encoding: "utf8",
  });
  const problems = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [short, ...rest] = line.split(" ");
    const issue = subjectProblem(rest.join(" "));
    if (issue) problems.push(`${short}: ${issue}`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base) {
    console.error("Usage: node scripts/check-commit-subjects.mjs <base> [head]");
    process.exit(2);
  }
  const problems = problemsInRange(base, head);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(
      "\nAGENTS.md requires conventional commit subjects. Reword the subject " +
        "(git rebase -i, or git commit --amend for the last commit), then " +
        "force-push your branch with --force-with-lease.",
    );
    process.exit(1);
  }
  process.stdout.write(`OK: conventional subjects in ${base}..${head}\n`);
}
