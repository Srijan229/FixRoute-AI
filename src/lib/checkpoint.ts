import fs from "node:fs";
import path from "node:path";

const CHECKPOINTS_DIR = path.resolve(process.cwd(), "data", "checkpoints");

function getCheckpointPath(name: string): string {
  return path.join(CHECKPOINTS_DIR, `${name}.json`);
}

export function loadCheckpoint<T>(name: string): T | null {
  const checkpointPath = getCheckpointPath(name);

  if (!fs.existsSync(checkpointPath)) {
    return null;
  }

  const rawContents = fs.readFileSync(checkpointPath, "utf8");
  return JSON.parse(rawContents) as T;
}

export function saveCheckpoint(name: string, value: unknown): void {
  const checkpointPath = getCheckpointPath(name);
  fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify(value, null, 2), "utf8");
}
