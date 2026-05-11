import fs from "node:fs";
import path from "node:path";
import { loadGitHubEnv } from "../config/env.js";
import { loadCheckpoint, saveCheckpoint } from "../lib/checkpoint.js";
import { createGitHubClient } from "../lib/github.js";
import { logInfo } from "../lib/logger.js";
import type { GitHubIssue } from "../lib/types.js";

type IssuesCheckpoint = {
  page: number;
  fetchedCount: number;
};

const CHECKPOINT_NAME = "fetchIssues";
const OUTPUT_PATH = path.resolve(process.cwd(), "data", "raw", "issues", "issues.json");
const PER_PAGE = 100;

function ensureOutputDirectory(): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
}

function loadExistingIssues(): GitHubIssue[] {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return [];
  }

  const rawContents = fs.readFileSync(OUTPUT_PATH, "utf8");
  return JSON.parse(rawContents) as GitHubIssue[];
}

function saveIssues(issues: GitHubIssue[]): void {
  ensureOutputDirectory();
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(issues, null, 2), "utf8");
}

function isPullRequestIssue(issue: GitHubIssue): boolean {
  return Boolean(issue.pull_request);
}

async function main() {
  const env = loadGitHubEnv();
  const github = createGitHubClient();
  const existingIssues = loadExistingIssues();
  const checkpoint = loadCheckpoint<IssuesCheckpoint>(CHECKPOINT_NAME) ?? {
    page: 1,
    fetchedCount: existingIssues.length
  };

  const issueMap = new Map<number, GitHubIssue>(existingIssues.map((issue) => [issue.number, issue]));
  let currentPage = checkpoint.page;
  let fetchedCount = checkpoint.fetchedCount;

  logInfo("Starting issue fetch", {
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    issueFetchLimit: env.ISSUE_FETCH_LIMIT,
    startingPage: currentPage,
    existingIssues: issueMap.size
  });

  while (fetchedCount < env.ISSUE_FETCH_LIMIT) {
    const pageIssues = await github.get<GitHubIssue[]>(
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`,
      {
        query: {
          state: "closed",
          sort: "updated",
          direction: "desc",
          per_page: PER_PAGE,
          page: currentPage
        }
      }
    );

    if (pageIssues.length === 0) {
      logInfo("No more issues returned from GitHub", { currentPage });
      break;
    }

    let addedThisPage = 0;

    for (const issue of pageIssues) {
      if (isPullRequestIssue(issue)) {
        continue;
      }

      if (issueMap.has(issue.number)) {
        continue;
      }

      issueMap.set(issue.number, issue);
      fetchedCount += 1;
      addedThisPage += 1;

      if (fetchedCount >= env.ISSUE_FETCH_LIMIT) {
        break;
      }
    }

    saveIssues(Array.from(issueMap.values()));
    currentPage += 1;
    saveCheckpoint(CHECKPOINT_NAME, { page: currentPage, fetchedCount });

    logInfo("Processed issue page", {
      currentPage: currentPage - 1,
      fetchedCount,
      addedThisPage
    });
  }

  logInfo("Issue fetch complete", {
    totalIssuesStored: issueMap.size,
    outputPath: OUTPUT_PATH
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
