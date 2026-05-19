import fs from "node:fs";
import path from "node:path";
import { loadGitHubEnv } from "../config/env.js";
import { loadCheckpoint, saveCheckpoint } from "../lib/checkpoint.js";
import { createGitHubClient } from "../lib/github.js";
import { logInfo } from "../lib/logger.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubTimelineCrossReferenceEvent,
  LinkedPullRequestRecord,
  PullRequestCommit,
  PullRequestFile,
} from "../lib/types.js";

type PullRequestCheckpoint = {
  page: number;
  linkedPullRequestCount: number;
  timelineIssueIndex?: number;
};

const ISSUES_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "issues",
  "issues.json",
);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "pullRequests",
  "linkedPullRequests.json",
);
const CHECKPOINT_NAME = "fetchPullRequests";
const PER_PAGE = Number(process.env.PULL_REQUESTS_PER_PAGE || 100);
const MAX_PR_PAGES = Number(process.env.PULL_REQUEST_FETCH_PAGE_LIMIT || 20);
const TIMELINE_ISSUE_LIMIT = Number(process.env.TIMELINE_ISSUE_LIMIT || 0);
const TIMELINE_SAVE_INTERVAL = 25;
const ISSUE_LINK_REGEX =
  /\b(?:fixes|fixed|fix|closes|closed|close|resolves|resolved|resolve)\s+(?:https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/|[\w.-]+\/[\w.-]+#|#)(\d+)\b/gi;

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

function extractLinkedIssueNumbers(
  text: string,
  issueNumbers: Set<number>,
): number[] {
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
  pullRequestNumber: number,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  let page = 1;

  while (true) {
    const pageFiles = await github.get<PullRequestFile[]>(
      `/repos/${owner}/${repo}/pulls/${pullRequestNumber}/files`,
      {
        query: {
          per_page: PER_PAGE,
          page,
        },
      },
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

async function fetchPullRequestByNumber(
  github: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  pullRequestNumber: number,
): Promise<GitHubPullRequest> {
  return github.get<GitHubPullRequest>(
    `/repos/${owner}/${repo}/pulls/${pullRequestNumber}`,
  );
}

async function fetchPullRequestCommits(
  github: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  pullRequestNumber: number,
): Promise<PullRequestCommit[]> {
  const commits: PullRequestCommit[] = [];
  let page = 1;

  while (true) {
    const pageCommits = await github.get<PullRequestCommit[]>(
      `/repos/${owner}/${repo}/pulls/${pullRequestNumber}/commits`,
      {
        query: {
          per_page: PER_PAGE,
          page,
        },
      },
    );

    if (pageCommits.length === 0) {
      break;
    }

    commits.push(...pageCommits);

    if (pageCommits.length < PER_PAGE) {
      break;
    }

    page += 1;
  }

  return commits;
}

async function fetchIssueTimelinePullRequestNumbers(
  github: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<number[]> {
  const events = await github.get<GitHubTimelineCrossReferenceEvent[]>(
    `/repos/${owner}/${repo}/issues/${issueNumber}/timeline`,
    {
      query: {
        per_page: 100,
      },
      headers: {
        Accept: "application/vnd.github+json",
      },
    },
  );
  const pullRequestNumbers = new Set<number>();

  for (const event of events) {
    if (event.event !== "cross-referenced") {
      continue;
    }

    const referencedIssue = event.source?.issue;

    if (
      !referencedIssue?.pull_request?.url ||
      typeof referencedIssue.number !== "number"
    ) {
      continue;
    }

    if (
      !referencedIssue.pull_request.url.includes(
        `/repos/${owner}/${repo}/pulls/`,
      )
    ) {
      continue;
    }

    pullRequestNumbers.add(referencedIssue.number);
  }

  return Array.from(pullRequestNumbers.values()).sort((a, b) => a - b);
}

async function hydrateLinkedPullRequest(
  github: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  linkedIssueNumbers: number[],
): Promise<LinkedPullRequestRecord> {
  const pullRequest = await fetchPullRequestByNumber(
    github,
    owner,
    repo,
    pullRequestNumber,
  );
  const files = await fetchPullRequestFiles(
    github,
    owner,
    repo,
    pullRequestNumber,
  );
  const commits = await fetchPullRequestCommits(
    github,
    owner,
    repo,
    pullRequestNumber,
  );

  return {
    pullRequest,
    linkedIssueNumbers,
    files,
    commits,
  };
}

function mergeLinkedIssueNumbers(
  record: LinkedPullRequestRecord,
  linkedIssueNumbers: number[],
): LinkedPullRequestRecord {
  return {
    ...record,
    linkedIssueNumbers: Array.from(
      new Set([...record.linkedIssueNumbers, ...linkedIssueNumbers]),
    ).sort((a, b) => a - b),
  };
}

async function main() {
  const env = loadGitHubEnv();
  const github = createGitHubClient();
  const issues = loadIssues();
  const issueNumbers = new Set<number>(issues.map((issue) => issue.number));
  const existingRecords = loadExistingLinkedPullRequests();
  const checkpoint = loadCheckpoint<PullRequestCheckpoint>(CHECKPOINT_NAME) ?? {
    page: 1,
    linkedPullRequestCount: existingRecords.length,
    timelineIssueIndex: 0,
  };

  const linkedPullRequestMap = new Map<number, LinkedPullRequestRecord>(
    existingRecords.map((record) => [record.pullRequest.number, record]),
  );

  let currentPage = checkpoint.page;

  logInfo("Starting pull request fetch", {
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    issueCount: issueNumbers.size,
    startingPage: currentPage,
    existingLinkedPullRequests: linkedPullRequestMap.size,
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
          page: currentPage,
        },
      },
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

      const prText = `${pullRequest.title}\n\n${pullRequest.body ?? ""}`;
      let linkedIssueNumbers = extractLinkedIssueNumbers(prText, issueNumbers);
      let commits: PullRequestCommit[] | undefined;

      if (linkedIssueNumbers.length === 0) {
        commits = await fetchPullRequestCommits(
          github,
          env.GITHUB_OWNER,
          env.GITHUB_REPO,
          pullRequest.number,
        );

        linkedIssueNumbers = extractLinkedIssueNumbers(
          commits.map((commit) => commit.commit.message).join("\n\n"),
          issueNumbers,
        );
      }

      if (linkedIssueNumbers.length === 0) {
        continue;
      }

      const files = await fetchPullRequestFiles(
        github,
        env.GITHUB_OWNER,
        env.GITHUB_REPO,
        pullRequest.number,
      );

      linkedPullRequestMap.set(pullRequest.number, {
        pullRequest,
        linkedIssueNumbers,
        files,
        commits,
      });

      linkedThisPage += 1;
    }

    saveLinkedPullRequests(Array.from(linkedPullRequestMap.values()));
    currentPage += 1;
    saveCheckpoint(CHECKPOINT_NAME, {
      page: currentPage,
      linkedPullRequestCount: linkedPullRequestMap.size,
      timelineIssueIndex: checkpoint.timelineIssueIndex ?? 0,
    });

    logInfo("Processed pull request page", {
      currentPage: currentPage - 1,
      linkedPullRequestsStored: linkedPullRequestMap.size,
      linkedThisPage,
    });
  }

  const linkedIssueNumbers = new Set<number>(
    Array.from(linkedPullRequestMap.values()).flatMap(
      (record) => record.linkedIssueNumbers,
    ),
  );
  let timelineIssueIndex = checkpoint.timelineIssueIndex ?? 0;
  let timelineLinkedCount = 0;

  const timelineIssueStopIndex =
    TIMELINE_ISSUE_LIMIT > 0
      ? Math.min(issues.length, timelineIssueIndex + TIMELINE_ISSUE_LIMIT)
      : issues.length;

  while (timelineIssueIndex < timelineIssueStopIndex) {
    const issue = issues[timelineIssueIndex];
    timelineIssueIndex += 1;

    if (linkedIssueNumbers.has(issue.number)) {
      if (timelineIssueIndex % TIMELINE_SAVE_INTERVAL === 0) {
        saveCheckpoint(CHECKPOINT_NAME, {
          page: currentPage,
          linkedPullRequestCount: linkedPullRequestMap.size,
          timelineIssueIndex,
        });
      }
      continue;
    }

    const timelinePrNumbers = await fetchIssueTimelinePullRequestNumbers(
      github,
      env.GITHUB_OWNER,
      env.GITHUB_REPO,
      issue.number,
    );

    if (timelinePrNumbers.length > 0) {
      for (const pullRequestNumber of timelinePrNumbers) {
        const existingRecord = linkedPullRequestMap.get(pullRequestNumber);

        if (existingRecord) {
          linkedPullRequestMap.set(
            pullRequestNumber,
            mergeLinkedIssueNumbers(existingRecord, [issue.number]),
          );
        } else {
          try {
            const hydratedRecord = await hydrateLinkedPullRequest(
              github,
              env.GITHUB_OWNER,
              env.GITHUB_REPO,
              pullRequestNumber,
              [issue.number],
            );
            linkedPullRequestMap.set(pullRequestNumber, hydratedRecord);
          } catch (error) {
            logInfo("Skipping invalid timeline-linked pull request", {
              issueNumber: issue.number,
              pullRequestNumber,
              message: error instanceof Error ? error.message : "Unknown error",
            });
            continue;
          }
        }
      }

      linkedIssueNumbers.add(issue.number);
      timelineLinkedCount += 1;
      saveLinkedPullRequests(Array.from(linkedPullRequestMap.values()));
    }

    if (timelineIssueIndex % TIMELINE_SAVE_INTERVAL === 0) {
      saveCheckpoint(CHECKPOINT_NAME, {
        page: currentPage,
        linkedPullRequestCount: linkedPullRequestMap.size,
        timelineIssueIndex,
      });

      logInfo("Processed issue timeline batch", {
        scannedIssueCount: timelineIssueIndex,
        linkedPullRequestsStored: linkedPullRequestMap.size,
        timelineLinkedCount,
      });
    }
  }

  saveLinkedPullRequests(Array.from(linkedPullRequestMap.values()));
  saveCheckpoint(CHECKPOINT_NAME, {
    page: currentPage,
    linkedPullRequestCount: linkedPullRequestMap.size,
    timelineIssueIndex,
  });

  logInfo("Pull request fetch complete", {
    totalLinkedPullRequestsStored: linkedPullRequestMap.size,
    timelineIssueIndex,
    timelineLinkedCount,
    outputPath: OUTPUT_PATH,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
