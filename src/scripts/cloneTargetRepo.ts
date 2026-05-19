import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadGitHubEnv } from "../config/env.js";
import { logInfo } from "../lib/logger.js";

function repoDirectoryName(owner: string, repo: string): string {
  return `${owner}__${repo}`;
}

function runGit(args: string[], cwd: string): void {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
}

function main() {
  const env = loadGitHubEnv();
  const targetRoot = path.resolve(
    process.cwd(),
    process.env.TARGET_REPO_ROOT || "data/raw/repos",
  );
  const targetPath = path.join(
    targetRoot,
    repoDirectoryName(env.GITHUB_OWNER, env.GITHUB_REPO),
  );
  const cloneUrl = `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}.git`;

  fs.mkdirSync(targetRoot, { recursive: true });

  if (fs.existsSync(path.join(targetPath, ".git"))) {
    logInfo("Updating target repo", {
      targetPath,
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
    });
    runGit(["fetch", "--depth", "1", "origin"], targetPath);
    runGit(["pull", "--ff-only"], targetPath);
  } else {
    logInfo("Cloning target repo", {
      targetPath,
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      depth: 1,
    });
    runGit(["clone", "--depth", "1", cloneUrl, targetPath], process.cwd());
  }

  logInfo("Target repo ready", {
    targetPath,
  });
}

main();
