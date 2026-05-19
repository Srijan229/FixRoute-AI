import fs from "node:fs";
import path from "node:path";
import { loadGitHubEnv } from "../config/env.js";
import { loadCheckpoint, saveCheckpoint } from "../lib/checkpoint.js";
import { createGitHubClient } from "../lib/github.js";
import { logInfo } from "../lib/logger.js";
import type {
  GitHubIssue,
  GitHubIssueComment,
  IssueCommentRecord,
} from "../lib/types.js";

type IssueCommentsCheckpoint = {
  issueIndex: number;
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
  "issueComments",
  "issueComments.json",
);
const CHECKPOINT_NAME = "fetchIssueComments";
const PER_PAGE = 100;
const ISSUE_LIMIT = Number(process.env.ISSUE_COMMENTS_FETCH_LIMIT || 0);
const SAVE_INTERVAL = 25;

function loadIssues(): GitHubIssue[] {
  if (!fs.existsSync(ISSUES_PATH)) {
    throw new Error("Missing issues dataset. Run fetch:issues first.");
  }

  return JSON.parse(fs.readFileSync(ISSUES_PATH, "utf8")) as GitHubIssue[];
}

function loadExistingRecords(): IssueCommentRecord[] {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return [];
  }

  return JSON.parse(
    fs.readFileSync(OUTPUT_PATH, "utf8"),
  ) as IssueCommentRecord[];
}

function saveRecords(records: IssueCommentRecord[]): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(records, null, 2), "utf8");
}

async function fetchAllComments(
  github: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssueComment[]> {
  const comments: GitHubIssueComment[] = [];
  let page = 1;

  while (true) {
    const pageComments = await github.get<GitHubIssueComment[]>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        query: {
          per_page: PER_PAGE,
          page,
        },
      },
    );

    if (pageComments.length === 0) {
      break;
    }

    comments.push(...pageComments);

    if (pageComments.length < PER_PAGE) {
      break;
    }

    page += 1;
  }

  return comments;
}

async function main() {
  const env = loadGitHubEnv();
  const github = createGitHubClient();
  const issues = loadIssues();
  const existingRecords = loadExistingRecords();
  const checkpoint = loadCheckpoint<IssueCommentsCheckpoint>(
    CHECKPOINT_NAME,
  ) ?? { issueIndex: 0 };
  const recordMap = new Map<number, IssueCommentRecord>(
    existingRecords.map((record) => [record.issueNumber, record]),
  );
  const stopIndex =
    ISSUE_LIMIT > 0
      ? Math.min(issues.length, checkpoint.issueIndex + ISSUE_LIMIT)
      : issues.length;
  let issueIndex = checkpoint.issueIndex;

  logInfo("Starting issue comments fetch", {
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    issueCount: issues.length,
    startingIssueIndex: issueIndex,
    stopIndex,
    existingRecords: recordMap.size,
  });

  while (issueIndex < stopIndex) {
    const issue = issues[issueIndex];

    if (!recordMap.has(issue.number)) {
      const comments = await fetchAllComments(
        github,
        env.GITHUB_OWNER,
        env.GITHUB_REPO,
        issue.number,
      );
      recordMap.set(issue.number, {
        issueNumber: issue.number,
        comments,
      });
    }

    issueIndex += 1;

    if (issueIndex % SAVE_INTERVAL === 0) {
      saveRecords(
        Array.from(recordMap.values()).sort(
          (a, b) => a.issueNumber - b.issueNumber,
        ),
      );
      saveCheckpoint(CHECKPOINT_NAME, { issueIndex });
      logInfo("Processed issue comments batch", {
        scannedIssueCount: issueIndex,
        recordsStored: recordMap.size,
      });
    }
  }

  saveRecords(
    Array.from(recordMap.values()).sort(
      (a, b) => a.issueNumber - b.issueNumber,
    ),
  );
  saveCheckpoint(CHECKPOINT_NAME, { issueIndex });

  logInfo("Issue comments fetch complete", {
    scannedIssueCount: issueIndex,
    recordsStored: recordMap.size,
    outputPath: OUTPUT_PATH,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
