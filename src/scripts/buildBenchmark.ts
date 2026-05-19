import fs from "node:fs";
import path from "node:path";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { logInfo } from "../lib/logger.js";
import type {
  BenchmarkCase,
  GitHubIssue,
  LinkedPullRequestRecord,
} from "../lib/types.js";

const ISSUES_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "issues",
  "issues.json",
);
const PULL_REQUESTS_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "pullRequests",
  "linkedPullRequests.json",
);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "evaluation",
  "benchmark.json",
);

type Args = {
  limit: number;
};

type CandidateCase = BenchmarkCase & {
  sortScore: number;
};

function parseArgs(argv: string[]): Args {
  let limit = 50;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--limit" && argv[index + 1]) {
      limit = Number(argv[index + 1]);
      index += 1;
    }
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number");
  }

  return { limit };
}

function loadJsonFile<T>(filePath: string, errorMessage: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(errorMessage);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function topComponentForFiles(files: string[]): string {
  const counts = new Map<string, number>();

  for (const filePath of files) {
    const component = mapFilePathToComponent(filePath);

    if (component === "Unknown") {
      continue;
    }

    counts.set(component, (counts.get(component) || 0) + 1);
  }

  let bestComponent = "Unknown";
  let bestCount = -1;

  for (const [component, count] of counts.entries()) {
    if (count > bestCount) {
      bestComponent = component;
      bestCount = count;
    }
  }

  return bestComponent;
}

function inferDifficulty(
  issue: GitHubIssue,
  files: string[],
  pullRequestCount: number,
): BenchmarkCase["difficulty"] {
  const bodyLength = (issue.body || "").length;

  if (files.length <= 2 && pullRequestCount === 1 && bodyLength < 500) {
    return "easy";
  }

  if (files.length >= 5 || pullRequestCount >= 2 || bodyLength >= 2000) {
    return "hard";
  }

  return "medium";
}

function difficultyWeight(difficulty: BenchmarkCase["difficulty"]): number {
  if (difficulty === "hard") return 3;
  if (difficulty === "medium") return 2;
  return 1;
}

function selectBalancedCases(
  cases: CandidateCase[],
  limit: number,
): BenchmarkCase[] {
  const byComponent = new Map<string, CandidateCase[]>();

  for (const benchmarkCase of cases) {
    const component = benchmarkCase.expected.component;
    const entries = byComponent.get(component) || [];
    entries.push(benchmarkCase);
    byComponent.set(component, entries);
  }

  for (const entries of byComponent.values()) {
    entries.sort(
      (left, right) =>
        right.sortScore - left.sortScore ||
        left.issue_number - right.issue_number,
    );
  }

  const components = Array.from(byComponent.keys()).sort((left, right) =>
    left.localeCompare(right),
  );
  const selected: BenchmarkCase[] = [];
  let added = true;

  while (selected.length < limit && added) {
    added = false;

    for (const component of components) {
      const pool = byComponent.get(component);

      if (!pool || pool.length === 0 || selected.length >= limit) {
        continue;
      }

      const nextCase = pool.shift();

      if (!nextCase) {
        continue;
      }

      selected.push({
        issue_number: nextCase.issue_number,
        title: nextCase.title,
        body: nextCase.body,
        labels: nextCase.labels,
        difficulty: nextCase.difficulty,
        expected: nextCase.expected,
      });
      added = true;
    }
  }

  return selected;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const issues = loadJsonFile<GitHubIssue[]>(
    ISSUES_PATH,
    "Missing issues dataset. Run fetch:issues first.",
  );
  const linkedPullRequests = loadJsonFile<LinkedPullRequestRecord[]>(
    PULL_REQUESTS_PATH,
    "Missing PR dataset. Run fetch:prs first.",
  );

  const issueMap = new Map<number, GitHubIssue>(
    issues.map((issue) => [issue.number, issue]),
  );
  const prsByIssue = new Map<number, LinkedPullRequestRecord[]>();

  for (const record of linkedPullRequests) {
    for (const issueNumber of record.linkedIssueNumbers) {
      const records = prsByIssue.get(issueNumber) || [];
      records.push(record);
      prsByIssue.set(issueNumber, records);
    }
  }

  const benchmarkCases: CandidateCase[] = [];

  for (const [issueNumber, records] of prsByIssue.entries()) {
    const issue = issueMap.get(issueNumber);

    if (!issue) {
      continue;
    }

    const files = Array.from(
      new Set(
        records.flatMap((record) => record.files.map((file) => file.filename)),
      ),
    ).sort((a, b) => a.localeCompare(b));
    const expectedComponent = topComponentForFiles(files);
    const pullRequestNumbers = Array.from(
      new Set(records.map((record) => record.pullRequest.number)),
    ).sort((a, b) => a - b);

    if (expectedComponent === "Unknown") {
      continue;
    }

    const difficulty = inferDifficulty(issue, files, pullRequestNumbers.length);
    const sortScore =
      difficultyWeight(difficulty) * 100 +
      files.length * 10 +
      pullRequestNumbers.length * 10 +
      Math.min((issue.body || "").length / 500, 10);

    benchmarkCases.push({
      issue_number: issue.number,
      title: issue.title,
      body: issue.body || "",
      labels: issue.labels
        .map((label) => label.name)
        .sort((a, b) => a.localeCompare(b)),
      difficulty,
      expected: {
        component: expectedComponent,
        files,
        pull_requests: pullRequestNumbers,
      },
      sortScore,
    });
  }

  const selectedCases = selectBalancedCases(benchmarkCases, args.limit);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(selectedCases, null, 2), "utf8");

  const componentBreakdown = selectedCases.reduce<Record<string, number>>(
    (accumulator, benchmarkCase) => {
      accumulator[benchmarkCase.expected.component] =
        (accumulator[benchmarkCase.expected.component] || 0) + 1;
      return accumulator;
    },
    {},
  );
  const difficultyBreakdown = selectedCases.reduce<Record<string, number>>(
    (accumulator, benchmarkCase) => {
      accumulator[benchmarkCase.difficulty] =
        (accumulator[benchmarkCase.difficulty] || 0) + 1;
      return accumulator;
    },
    {},
  );

  logInfo("Benchmark dataset created", {
    totalEligibleCases: benchmarkCases.length,
    selectedCaseCount: selectedCases.length,
    componentBreakdown,
    difficultyBreakdown,
    outputPath: OUTPUT_PATH,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
