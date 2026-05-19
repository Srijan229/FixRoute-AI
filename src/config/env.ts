import dotenv from "dotenv";

dotenv.config();

export type GitHubEnv = {
  GITHUB_TOKEN?: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_API_BASE_URL: string;
  ISSUE_FETCH_LIMIT: number;
  LOG_LEVEL: string;
};

export type Neo4jEnv = {
  NEO4J_URI: string;
  NEO4J_USERNAME: string;
  NEO4J_PASSWORD: string;
};

export type SemanticEnv = {
  EMBEDDING_PROVIDER: "local" | "gemini";
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSION: number;
  EMBEDDINGS_FILE_PATH: string;
  GEMINI_API_KEY?: string;
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

export function loadGitHubEnv(): GitHubEnv {
  return {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN?.trim() || undefined,
    GITHUB_OWNER: process.env.GITHUB_OWNER?.trim() || "microsoft",
    GITHUB_REPO: process.env.GITHUB_REPO?.trim() || "vscode",
    GITHUB_API_BASE_URL:
      process.env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
    ISSUE_FETCH_LIMIT: parseNumberEnv("ISSUE_FETCH_LIMIT", 500),
    LOG_LEVEL: process.env.LOG_LEVEL?.trim() || "info",
  };
}

export function loadNeo4jEnv(): Neo4jEnv {
  return {
    NEO4J_URI: requireEnv("NEO4J_URI"),
    NEO4J_USERNAME: requireEnv("NEO4J_USERNAME"),
    NEO4J_PASSWORD: requireEnv("NEO4J_PASSWORD"),
  };
}

export function loadSemanticEnv(): SemanticEnv {
  const provider = (process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() ||
    "local") as "local" | "gemini";

  if (provider !== "local" && provider !== "gemini") {
    throw new Error("EMBEDDING_PROVIDER must be either 'local' or 'gemini'");
  }

  const dimension = parseNumberEnv(
    "EMBEDDING_DIMENSION",
    provider === "gemini" ? 768 : 256,
  );
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

  if (provider === "gemini" && !geminiApiKey) {
    throw new Error("Missing required environment variable: GEMINI_API_KEY");
  }

  return {
    EMBEDDING_PROVIDER: provider,
    EMBEDDING_MODEL:
      process.env.EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
    EMBEDDING_DIMENSION: dimension,
    EMBEDDINGS_FILE_PATH:
      process.env.EMBEDDINGS_FILE_PATH?.trim() ||
      "data/processed/embeddings/issues.embeddings.json",
    GEMINI_API_KEY: geminiApiKey,
  };
}
