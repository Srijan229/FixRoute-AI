import { loadGitHubEnv } from "../config/env.js";
import { withRateLimitRetry } from "./rateLimit.js";

type RequestOptions = {
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
};

function buildUrl(baseUrl: string, requestPath: string, query?: Record<string, string | number>): string {
  const url = new URL(requestPath, baseUrl);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

class GitHubRateLimitError extends Error {
  retryAfterMs?: number;
}

export function createGitHubClient() {
  const env = loadGitHubEnv();

  async function get<T>(requestPath: string, options?: RequestOptions): Promise<T> {
    const url = buildUrl(env.GITHUB_API_BASE_URL, requestPath, options?.query);

    return withRateLimitRetry(async () => {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": "FixRoute-AI",
          ...options?.headers
        }
      });

      if (!response.ok) {
        const body = await response.text();

        if (response.status === 403 && body.toLowerCase().includes("rate limit exceeded")) {
          const resetHeader = response.headers.get("x-ratelimit-reset");
          const retryAfterHeader = response.headers.get("retry-after");
          const error = new GitHubRateLimitError(
            `GitHub rate limit exceeded: ${response.status} ${response.statusText} ${body}`
          );

          if (retryAfterHeader) {
            const retryAfterSeconds = Number(retryAfterHeader);

            if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
              error.retryAfterMs = retryAfterSeconds * 1000;
            }
          } else if (resetHeader) {
            const resetEpochSeconds = Number(resetHeader);

            if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) {
              const waitMs = resetEpochSeconds * 1000 - Date.now();
              error.retryAfterMs = Math.max(waitMs + 1000, 1000);
            }
          }

          throw error;
        }

        throw new Error(`GitHub request failed: ${response.status} ${response.statusText} ${body}`);
      }

      return (await response.json()) as T;
    });
  }

  return {
    get
  };
}
