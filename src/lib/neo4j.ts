import neo4j, { type Driver, type Session } from "neo4j-driver";
import { loadNeo4jEnv } from "../config/env.js";

export type Neo4jClient = {
  close: () => Promise<void>;
  getSession: () => Session;
  verifyConnection: () => Promise<void>;
};

function createDriver(uri: string, username: string, password: string): Driver {
  return neo4j.driver(uri, neo4j.auth.basic(username, password));
}

function fallbackBoltUri(uri: string): string | null {
  if (uri.startsWith("neo4j+s://")) {
    return uri.replace("neo4j+s://", "bolt+s://");
  }

  if (uri.startsWith("neo4j://")) {
    return uri.replace("neo4j://", "bolt://");
  }

  return null;
}

function isRoutingDiscoveryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("No routing servers available") ||
      error.message.includes("Could not perform discovery"))
  );
}

export function createNeo4jClient(): Neo4jClient {
  const env = loadNeo4jEnv();
  let activeDriver: Driver = createDriver(
    env.NEO4J_URI,
    env.NEO4J_USERNAME,
    env.NEO4J_PASSWORD,
  );
  let activeUri = env.NEO4J_URI;

  async function ensureConnectivity(): Promise<void> {
    try {
      await activeDriver.verifyConnectivity();
    } catch (error) {
      const fallbackUri = fallbackBoltUri(activeUri);

      if (!isRoutingDiscoveryError(error) || !fallbackUri) {
        throw error;
      }

      await activeDriver.close();
      activeDriver = createDriver(
        fallbackUri,
        env.NEO4J_USERNAME,
        env.NEO4J_PASSWORD,
      );
      activeUri = fallbackUri;
      await activeDriver.verifyConnectivity();
    }
  }

  return {
    close: async () => activeDriver.close(),
    getSession: () => activeDriver.session(),
    verifyConnection: async () => {
      await ensureConnectivity();
    },
  };
}
