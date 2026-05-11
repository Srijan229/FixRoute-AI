import fs from "node:fs";
import path from "node:path";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { logInfo } from "../lib/logger.js";
import type { BenchmarkCase, GitHubIssue, HoldoutSplit, LinkedPullRequestRecord } from "../lib/types.js";

const ISSUES_PATH = path.resolve(process.cwd(), "data", "raw", "issues", "issues.json");
const PULL_REQUESTS_PATH = path.resolve(process.cwd(), "data", "raw", "pullRequests", "linkedPullRequests.json");
const OUTPUT_PATH = path.resolve(process.cwd(), "data", "processed", "evaluation", "holdout.json");

type Args = {
  ratio: number;
};

type CandidateCase = BenchmarkCase & {
  closedAt: string;
};

function parseArgs(argv: string[]): Args {
  let ratio = 0.7;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--ratio" && argv[index + 1]) {
      ratio = Number(argv[index + 1]);
      index += 1;
    }
  }

  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new Error("--ratio must be a number between 0 and 1");
  }

  return { ratio };
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

function inferDifficulty(issue: GitHubIssue, files: string[], pullRequestCount: number): BenchmarkCase["difficulty"] {
  const bodyLength = (issue.body || "").length;

  if (files.length <= 2 && pullRequestCount === 1 && bodyLength < 500) {
    return "easy";
  }

  if (files.length >= 5 || pullRequestCount >= 2 || bodyLength >= 2000) {
    return "hard";
  }

  return "medium";
}

function getDateRange(items: CandidateCase[]): HoldoutSplit["metadata"]["train_closed_at_range"] {
  if (items.length === 0) {
    return null;
  }

  return {
    start: items[0].closedAt,
    end: items[items.length - 1].closedAt
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const issues = loadJsonFile<GitHubIssue[]>(ISSUES_PATH, "Missing issues dataset. Run fetch:issues first.");
  const linkedPullRequests = loadJsonFile<LinkedPullRequestRecord[]>(
    PULL_REQUESTS_PATH,
    "Missing PR dataset. Run fetch:prs first."
  );

  const issueMap = new Map<number, GitHubIssue>(issues.map((issue) => [issue.number, issue]));
  const prsByIssue = new Map<number, LinkedPullRequestRecord[]>();

  for (const record of linkedPullRequests) {
    for (const issueNumber of record.linkedIssueNumbers) {
      const records = prsByIssue.get(issueNumber) || [];
      records.push(record);
      prsByIssue.set(issueNumber, records);
    }
  }

  const candidateCases: CandidateCase[] = [];

  for (const [issueNumber, records] of prsByIssue.entries()) {
    const issue = issueMap.get(issueNumber);

    if (!issue || !issue.closed_at) {
      continue;
    }

    const files = Array.from(new Set(records.flatMap((record) => record.files.map((file) => file.filename)))).sort(
      (a, b) => a.localeCompare(b)
    );
    const expectedComponent = topComponentForFiles(files);

    if (expectedComponent === "Unknown") {
      continue;
    }

    const pullRequestNumbers = Array.from(new Set(records.map((record) => record.pullRequest.number))).sort(
      (a, b) => a - b
    );

    candidateCases.push({
      issue_number: issue.number,
      title: issue.title,
      body: issue.body || "",
      labels: issue.labels.map((label) => label.name).sort((a, b) => a.localeCompare(b)),
      difficulty: inferDifficulty(issue, files, pullRequestNumbers.length),
      expected: {
        component: expectedComponent,
        files,
        pull_requests: pullRequestNumbers
      },
      closedAt: issue.closed_at
    });
  }

  candidateCases.sort(
    (left, right) => left.closedAt.localeCompare(right.closedAt) || left.issue_number - right.issue_number
  );

  if (candidateCases.length < 2) {
    throw new Error("Need at least two eligible resolved issues to build a holdout split.");
  }

  const rawTrainCount = Math.floor(candidateCases.length * args.ratio);
  const trainCount = Math.min(candidateCases.length - 1, Math.max(1, rawTrainCount));
  const trainCases = candidateCases.slice(0, trainCount);
  const testCases = candidateCases.slice(trainCount);

  const split: HoldoutSplit = {
    train_issue_numbers: trainCases.map((item) => item.issue_number),
    test_cases: testCases.map(({ closedAt: _closedAt, ...item }) => item),
    metadata: {
      eligible_case_count: candidateCases.length,
      train_case_count: trainCases.length,
      test_case_count: testCases.length,
      split_ratio: args.ratio,
      train_closed_at_range: getDateRange(trainCases),
      test_closed_at_range: getDateRange(testCases)
    }
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(split, null, 2), "utf8");

  logInfo("Holdout split created", {
    outputPath: OUTPUT_PATH,
    ...split.metadata
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
