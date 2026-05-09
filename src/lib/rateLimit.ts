function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (attempt < 5) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;

      if (attempt >= 5) {
        throw error;
      }

      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
      await sleep(backoffMs);
    }
  }

  throw new Error("Retry loop exited unexpectedly");
}
