import neo4j, { type Driver, type Session } from "neo4j-driver";
import { loadNeo4jEnv } from "../config/env.js";

export type Neo4jClient = {
  close: () => Promise<void>;
  getSession: () => Session;
  verifyConnection: () => Promise<void>;
};

export function createNeo4jClient(): Neo4jClient {
  const env = loadNeo4jEnv();
  const driver: Driver = neo4j.driver(
    env.NEO4J_URI,
    neo4j.auth.basic(env.NEO4J_USERNAME, env.NEO4J_PASSWORD)
  );

  return {
    close: async () => driver.close(),
    getSession: () => driver.session(),
    verifyConnection: async () => {
      await driver.verifyConnectivity();
    }
  };
}
