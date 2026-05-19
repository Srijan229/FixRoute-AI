import fs from "node:fs";
import path from "node:path";
import type {
  GitHubIssue,
  IssueCommentRecord,
  IssueTimelineRecord,
  LinkedPullRequestRecord,
  PatchHunk,
  PullRequestReviewCommentRecord,
  PullRequestReviewRecord,
  RichDataset,
} from "../lib/types.js";
import { logInfo } from "../lib/logger.js";

const ISSUES_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "issues",
  "issues.json",
);
const ISSUE_COMMENTS_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "issueComments",
  "issueComments.json",
);
const ISSUE_TIMELINE_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "issueTimeline",
  "issueTimeline.json",
);
const PULL_REQUESTS_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "pullRequests",
  "linkedPullRequests.json",
);
const PULL_REQUEST_REVIEWS_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "pullRequestReviews",
  "pullRequestReviews.json",
);
const PULL_REQUEST_REVIEW_COMMENTS_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "pullRequestReviewComments",
  "pullRequestReviewComments.json",
);
const PATCH_HUNKS_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "patches",
  "patchHunks.json",
);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "normalized",
  "richDataset.json",
);

function loadJsonFile<T>(filePath: string, missingFileMessage: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(missingFileMessage);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function loadOptionalJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function saveRichDataset(dataset: RichDataset): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(dataset, null, 2), "utf8");
}

function main() {
  const issues = loadJsonFile<GitHubIssue[]>(
    ISSUES_PATH,
    "Missing issue dataset. Run fetch:issues first.",
  );
  const linkedPullRequests = loadJsonFile<LinkedPullRequestRecord[]>(
    PULL_REQUESTS_PATH,
    "Missing pull request dataset. Run fetch:prs first.",
  );
  const issueComments = loadOptionalJsonFile<IssueCommentRecord[]>(
    ISSUE_COMMENTS_PATH,
    [],
  );
  const issueTimeline = loadOptionalJsonFile<IssueTimelineRecord[]>(
    ISSUE_TIMELINE_PATH,
    [],
  );
  const pullRequestReviews = loadOptionalJsonFile<PullRequestReviewRecord[]>(
    PULL_REQUEST_REVIEWS_PATH,
    [],
  );
  const pullRequestReviewComments = loadOptionalJsonFile<
    PullRequestReviewCommentRecord[]
  >(PULL_REQUEST_REVIEW_COMMENTS_PATH, []);
  const patchHunks = loadOptionalJsonFile<PatchHunk[]>(PATCH_HUNKS_PATH, []);

  const commentMap = new Map(
    issueComments.map((record) => [record.issueNumber, record.comments]),
  );
  const timelineMap = new Map(
    issueTimeline.map((record) => [record.issueNumber, record.events]),
  );
  const reviewMap = new Map(
    pullRequestReviews.map((record) => [
      record.pullRequestNumber,
      record.reviews,
    ]),
  );
  const reviewCommentMap = new Map(
    pullRequestReviewComments.map((record) => [
      record.pullRequestNumber,
      record.reviewComments,
    ]),
  );
  const hunkMap = new Map<number, PatchHunk[]>();

  for (const hunk of patchHunks) {
    const hunksForPullRequest = hunkMap.get(hunk.pullRequestNumber) ?? [];
    hunksForPullRequest.push(hunk);
    hunkMap.set(hunk.pullRequestNumber, hunksForPullRequest);
  }

  const dataset: RichDataset = {
    issues: issues.map((issue) => ({
      issue,
      comments: commentMap.get(issue.number) ?? [],
      timelineEvents: timelineMap.get(issue.number) ?? [],
    })),
    pullRequests: linkedPullRequests.map((record) => ({
      ...record,
      reviews: reviewMap.get(record.pullRequest.number) ?? [],
      reviewComments: reviewCommentMap.get(record.pullRequest.number) ?? [],
      patchHunks: hunkMap.get(record.pullRequest.number) ?? [],
    })),
    metadata: {
      issueCount: issues.length,
      pullRequestCount: linkedPullRequests.length,
      issueCommentCount: issueComments.reduce(
        (count, record) => count + record.comments.length,
        0,
      ),
      issueTimelineEventCount: issueTimeline.reduce(
        (count, record) => count + record.events.length,
        0,
      ),
      pullRequestReviewCount: pullRequestReviews.reduce(
        (count, record) => count + record.reviews.length,
        0,
      ),
      pullRequestReviewCommentCount: pullRequestReviewComments.reduce(
        (count, record) => count + record.reviewComments.length,
        0,
      ),
      patchHunkCount: patchHunks.length,
      generatedAt: new Date().toISOString(),
    },
  };

  saveRichDataset(dataset);

  logInfo("Rich dataset normalization complete", {
    ...dataset.metadata,
    outputPath: OUTPUT_PATH,
  });
}

main();
