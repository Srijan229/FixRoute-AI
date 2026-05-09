import dotenv from "dotenv";

dotenv.config();

export type Env = {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_API_BASE_URL: string;
  ISSUE_FETCH_LIMIT: number;
  LOG_LEVEL: string;
  NEO4J_URI: string;
  NEO4J_USERNAME: string;
  NEO4J_PASSWORD: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue || rawValue.trim() === "") {
    return fallback;
  }

  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number`);
  }

  return parsed;
}

export function loadEnv(): Env {
  return {
    GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),
    GITHUB_OWNER: process.env.GITHUB_OWNER?.trim() || "microsoft",
    GITHUB_REPO: process.env.GITHUB_REPO?.trim() || "vscode",
    GITHUB_API_BASE_URL: process.env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
    ISSUE_FETCH_LIMIT: parseNumberEnv("ISSUE_FETCH_LIMIT", 500),
    LOG_LEVEL: process.env.LOG_LEVEL?.trim() || "info",
    NEO4J_URI: requireEnv("NEO4J_URI"),
    NEO4J_USERNAME: requireEnv("NEO4J_USERNAME"),
    NEO4J_PASSWORD: requireEnv("NEO4J_PASSWORD")
  };
}
