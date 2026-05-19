import type { PatchHunk } from "./types.js";

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatchHunks(
  filePath: string,
  pullRequestNumber: number,
  patch?: string,
): PatchHunk[] {
  if (!patch) {
    return [];
  }

  const hunks: PatchHunk[] = [];
  const lines = patch.split("\n");
  let currentHunk: PatchHunk | null = null;
  let currentLines: string[] = [];

  function flushCurrentHunk(): void {
    if (!currentHunk) {
      return;
    }

    hunks.push({
      ...currentHunk,
      patchText: currentLines.join("\n"),
    });
  }

  for (const line of lines) {
    const headerMatch = line.match(HUNK_HEADER_REGEX);

    if (headerMatch) {
      flushCurrentHunk();

      currentHunk = {
        filePath,
        pullRequestNumber,
        oldStartLine: Number(headerMatch[1]),
        oldLineCount: Number(headerMatch[2] || 1),
        newStartLine: Number(headerMatch[3]),
        newLineCount: Number(headerMatch[4] || 1),
        patchText: "",
      };
      currentLines = [line];
      continue;
    }

    if (currentHunk) {
      currentLines.push(line);
    }
  }

  flushCurrentHunk();

  return hunks;
}
