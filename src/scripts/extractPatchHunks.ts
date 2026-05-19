import fs from "node:fs";
import path from "node:path";
import { parsePatchHunks } from "../lib/patchHunks.js";
import { logInfo } from "../lib/logger.js";
import type { LinkedPullRequestRecord, PatchHunk } from "../lib/types.js";

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
  "patches",
  "patchHunks.json",
);

function loadLinkedPullRequests(): LinkedPullRequestRecord[] {
  if (!fs.existsSync(PULL_REQUESTS_PATH)) {
    throw new Error("Missing pull request dataset. Run fetch:prs first.");
  }

  return JSON.parse(
    fs.readFileSync(PULL_REQUESTS_PATH, "utf8"),
  ) as LinkedPullRequestRecord[];
}

function savePatchHunks(hunks: PatchHunk[]): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(hunks, null, 2), "utf8");
}

function main() {
  const linkedPullRequests = loadLinkedPullRequests();
  const hunks = linkedPullRequests.flatMap((record) =>
    record.files.flatMap((file) =>
      parsePatchHunks(file.filename, record.pullRequest.number, file.patch),
    ),
  );

  savePatchHunks(hunks);

  logInfo("Patch hunk extraction complete", {
    pullRequestCount: linkedPullRequests.length,
    hunkCount: hunks.length,
    outputPath: OUTPUT_PATH,
  });
}

main();
