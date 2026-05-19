import http from "node:http";
import { generateRecommendation } from "./lib/recommendation.js";

type RecommendationRequestBody = {
  title?: string;
  description?: string;
  topK?: number;
};

const PORT = Number(process.env.PORT || 3001);

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(
  request: http.IncomingMessage,
): Promise<RecommendationRequestBody> {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk;
    });

    request.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody) as RecommendationRequestBody);
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });

    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "POST" && request.url === "/api/recommend") {
      const body = await readJsonBody(request);
      const recommendation = await generateRecommendation({
        title: body.title || "",
        description: body.description || "",
        topK: body.topK,
      });

      sendJson(response, 200, recommendation);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown server error";
    sendJson(response, 400, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ status: "listening", port: PORT }));
});
