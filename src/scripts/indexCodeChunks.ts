import fs from "node:fs";
import path from "node:path";
import { loadGitHubEnv } from "../config/env.js";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { logInfo } from "../lib/logger.js";
import type { CodeChunk, CodeChunkDataset } from "../lib/types.js";

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "code",
  "codeChunks.json",
);
const MAX_FILE_BYTES = Number(process.env.CODE_INDEX_MAX_FILE_BYTES || 200000);
const FILE_LIMIT = Number(process.env.CODE_INDEX_FILE_LIMIT || 0);
const MAX_CHUNK_LINES = Number(process.env.CODE_INDEX_MAX_CHUNK_LINES || 80);
const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
]);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  "data",
  ".vscode-test",
  "coverage",
  ".next",
]);

function repoDirectoryName(owner: string, repo: string): string {
  return `${owner}__${repo}`;
}

function getSourcePath(owner: string, repo: string): string {
  return path.resolve(
    process.cwd(),
    process.env.TARGET_REPO_PATH ||
      path.join("data", "raw", "repos", repoDirectoryName(owner, repo)),
  );
}

function walkFiles(root: string): string[] {
  const files: string[] = [];

  function walk(currentPath: string): void {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(entryPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        continue;
      }

      const stats = fs.statSync(entryPath);

      if (stats.size <= MAX_FILE_BYTES) {
        files.push(entryPath);
      }
    }
  }

  walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function languageForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".ts" || extension === ".tsx") return "typescript";
  if (extension === ".js" || extension === ".jsx") return "javascript";
  if (extension === ".json") return "json";
  if (extension === ".md") return "markdown";
  if (extension === ".css" || extension === ".scss") return "css";
  if (extension === ".html") return "html";
  return "text";
}

function symbolNameForLine(line: string): string | null {
  const patterns = [
    /\bexport\s+class\s+([A-Za-z0-9_$]+)/,
    /\bclass\s+([A-Za-z0-9_$]+)/,
    /\bexport\s+function\s+([A-Za-z0-9_$]+)/,
    /\bfunction\s+([A-Za-z0-9_$]+)/,
    /\bexport\s+const\s+([A-Za-z0-9_$]+)/,
    /\bconst\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/,
    /\b(public|private|protected)?\s*(async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);

    if (!match) {
      continue;
    }

    return match[3] || match[1];
  }

  return null;
}

function makeChunkId(
  filePath: string,
  startLine: number,
  endLine: number,
  symbolName: string | null,
): string {
  return `${filePath}:${startLine}:${endLine}:${symbolName || "block"}`;
}

function chunkFile(
  root: string,
  absoluteFilePath: string,
  owner: string,
  repo: string,
): CodeChunk[] {
  const relativePath = path
    .relative(root, absoluteFilePath)
    .split(path.sep)
    .join("/");
  const text = fs.readFileSync(absoluteFilePath, "utf8");
  const lines = text.split(/\r?\n/);
  const chunks: CodeChunk[] = [];
  let index = 0;

  while (index < lines.length) {
    const startLine = index + 1;
    const firstLine = lines[index] || "";
    const symbolName = symbolNameForLine(firstLine);
    const endLine = Math.min(lines.length, startLine + MAX_CHUNK_LINES - 1);
    const chunkText = lines
      .slice(startLine - 1, endLine)
      .join("\n")
      .trim();

    if (chunkText.length > 0) {
      chunks.push({
        id: makeChunkId(relativePath, startLine, endLine, symbolName),
        repoOwner: owner,
        repoName: repo,
        filePath: relativePath,
        component: mapFilePathToComponent(relativePath),
        language: languageForPath(relativePath),
        chunkType: symbolName ? "symbol" : "block",
        symbolName,
        startLine,
        endLine,
        text: chunkText,
      });
    }

    index += MAX_CHUNK_LINES;
  }

  return chunks;
}

function saveDataset(dataset: CodeChunkDataset): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(dataset, null, 2), "utf8");
}

function main() {
  const env = loadGitHubEnv();
  const sourcePath = getSourcePath(env.GITHUB_OWNER, env.GITHUB_REPO);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Missing target repo at ${sourcePath}. Run clone:target-repo first or set TARGET_REPO_PATH.`,
    );
  }

  const allFiles = walkFiles(sourcePath);
  const selectedFiles =
    FILE_LIMIT > 0 ? allFiles.slice(0, FILE_LIMIT) : allFiles;
  const chunks = selectedFiles.flatMap((filePath) =>
    chunkFile(sourcePath, filePath, env.GITHUB_OWNER, env.GITHUB_REPO),
  );
  const dataset: CodeChunkDataset = {
    chunks,
    metadata: {
      repoOwner: env.GITHUB_OWNER,
      repoName: env.GITHUB_REPO,
      sourcePath,
      fileCount: selectedFiles.length,
      chunkCount: chunks.length,
      generatedAt: new Date().toISOString(),
    },
  };

  saveDataset(dataset);

  logInfo("Code chunk index complete", {
    outputPath: OUTPUT_PATH,
    ...dataset.metadata,
  });
}

main();
