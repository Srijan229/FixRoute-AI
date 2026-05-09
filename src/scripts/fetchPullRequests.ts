import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "../config/env.js";
import { loadCheckpoint, saveCheckpoint } from "../lib/checkpoint.js";
import { createGitHubClient } from "../lib/github.js";
import { logInfo } from "../lib/logger.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  LinkedPullRequestRecord,
  PullRequestFile
} from "../lib/types.js";

type PullRequestCheckpoint = {
  page: number;
  linkedPullRequestCount: number;
};

const ISSUES_PATH = path.resolve(process.cwd(), "data", "raw", "issues", "issues.json");
const OUTPUT_PATH = path.resolve(process.cwd(), "data", "raw", "pullRequests", "linkedPullRequests.json");
const CHECKPOINT_NAME = "fetchPullRequests";
const PER_PAGE = 100;
const MAX_PR_PAGES = 20;
const ISSUE_LINK_REGEX = /\b(?:fixes|fixed|fix|closes|closed|close|resolves|resolved|resolve)\s+#(\d+)\b/gi;

function ensureOutputDirectory(): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
}

function loadIssues(): GitHubIssue[] {
  if (!fs.existsSync(ISSUES_PATH)) {
    throw new Error("Missing issues dataset. Run fetch:issues first.");
  }

  const rawContents = fs.readFileSync(ISSUES_PATH, "utf8");
  return JSON.parse(rawContents) as GitHubIssue[];
}

function loadExistingLinkedPullRequests(): LinkedPullRequestRecord[] {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return [];
  }

  const rawContents = fs.readFileSync(OUTPUT_PATH, "utf8");
  return JSON.parse(rawContents) as LinkedPullRequestRecord[];
}

function saveLinkedPullRequests(records: LinkedPullRequestRecord[]): void {
  ensureOutputDirectory();
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(records, null, 2), "utf8");
}

function extractLinkedIssueNumbers(text: string, issueNumbers: Set<number>): number[] {
  const matches = new Set<number>();

  for (const match of text.matchAll(ISSUE_LINK_REGEX)) {
    const issueNumber = Number(match[1]);

    if (issueNumbers.has(issueNumber)) {
      matches.add(issueNumber);
    }
  }

  return Array.from(matches).sort((a, b) => a - b);
}

async function fetchPullRequestFiles(
  github: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  pullRequestNumber: number
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  let page = 1;

  while (true) {
    const pageFiles = await github.get<PullRequestFile[]>(
      `/repos/${owner}/${repo}/pulls/${pullRequestNumber}/files`,
      {
        query: {
          per_page: PER_PAGE,
          page
        }
      }
    );

    if (pageFiles.length === 0) {
      break;
    }

    files.push(...pageFiles);

    if (pageFiles.length < PER_PAGE) {
      break;
    }

    page += 1;
  }

  return files;
}

async function main() {
  const env = loadEnv();
  const github = createGitHubClient();
  const issues = loadIssues();
  const issueNumbers = new Set<number>(issues.map((issue) => issue.number));
  const existingRecords = loadExistingLinkedPullRequests();
  const checkpoint = loadCheckpoint<PullRequestCheckpoint>(CHECKPOINT_NAME) ?? {
    page: 1,
    linkedPullRequestCount: existingRecords.length
  };

  const linkedPullRequestMap = new Map<number, LinkedPullRequestRecord>(
    existingRecords.map((record) => [record.pullRequest.number, record])
  );

  let currentPage = checkpoint.page;

  logInfo("Starting pull request fetch", {
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    issueCount: issueNumbers.size,
    startingPage: currentPage,
    existingLinkedPullRequests: linkedPullRequestMap.size
  });

  while (currentPage < checkpoint.page + MAX_PR_PAGES) {
    const pullRequests = await github.get<GitHubPullRequest[]>(
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/pulls`,
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

    if (pullRequests.length === 0) {
      logInfo("No more pull requests returned from GitHub", { currentPage });
      break;
    }

    let linkedThisPage = 0;

    for (const pullRequest of pullRequests) {
      if (linkedPullRequestMap.has(pullRequest.number)) {
        continue;
      }

      const searchableText = `${pullRequest.title}\n${pullRequest.body ?? ""}`;
      const linkedIssueNumbers = extractLinkedIssueNumbers(searchableText, issueNumbers);

      if (linkedIssueNumbers.length === 0) {
        continue;
      }

      const files = await fetchPullRequestFiles(
        github,
        env.GITHUB_OWNER,
        env.GITHUB_REPO,
        pullRequest.number
      );

      linkedPullRequestMap.set(pullRequest.number, {
        pullRequest,
        linkedIssueNumbers,
        files
      });

      linkedThisPage += 1;
    }

    saveLinkedPullRequests(Array.from(linkedPullRequestMap.values()));
    currentPage += 1;
    saveCheckpoint(CHECKPOINT_NAME, {
      page: currentPage,
      linkedPullRequestCount: linkedPullRequestMap.size
    });

    logInfo("Processed pull request page", {
      currentPage: currentPage - 1,
      linkedPullRequestsStored: linkedPullRequestMap.size,
      linkedThisPage
    });
  }

  logInfo("Pull request fetch complete", {
    totalLinkedPullRequestsStored: linkedPullRequestMap.size,
    outputPath: OUTPUT_PATH
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
