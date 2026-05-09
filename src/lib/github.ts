import { loadEnv } from "../config/env.js";
import { withRateLimitRetry } from "./rateLimit.js";

type RequestOptions = {
  query?: Record<string, string | number>;
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

export function createGitHubClient() {
  const env = loadEnv();

  async function get<T>(requestPath: string, options?: RequestOptions): Promise<T> {
    const url = buildUrl(env.GITHUB_API_BASE_URL, requestPath, options?.query);

    return withRateLimitRetry(async () => {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "User-Agent": "FixRoute-AI"
        }
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub request failed: ${response.status} ${response.statusText} ${body}`);
      }

      return (await response.json()) as T;
    });
  }

  return {
    get
  };
}
