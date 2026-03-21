import type { AdapterModel } from "./types.js";
import WebSocket from "ws";

/**
 * Fetch available models from an OpenClaw gateway via WebSocket RPC.
 *
 * Uses OPENCLAW_WS_URL (default ws://localhost:18799/v1/ws) and optional
 * OPENCLAW_TOKEN env vars. Results are cached for 60 seconds.
 */

const CACHE_TTL_MS = 60_000;
const CONNECT_TIMEOUT_MS = 8_000;

const cacheByUrl = new Map<string, { expiresAt: number; models: AdapterModel[] }>();

function resolveWsUrl(): string {
  return (
    process.env.OPENCLAW_WS_URL?.trim() ||
    (process.env.OPENCLAW_GATEWAY_PORT
      ? `ws://localhost:${process.env.OPENCLAW_GATEWAY_PORT}/v1/ws`
      : "ws://localhost:18799/v1/ws")
  );
}

function resolveToken(): string | null {
  return (
    process.env.OPENCLAW_TOKEN?.trim() ||
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    null
  );
}

interface GatewayModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

function toAdapterModel(m: GatewayModel): AdapterModel {
  const ctx = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : "";
  const reasoning = m.reasoning ? " 🧠" : "";
  return {
    id: `${m.provider}/${m.id}`,
    label: `${m.provider}/${m.name}${ctx}${reasoning}`,
  };
}

function fetchModelsViaWs(wsUrl: string, token: string | null): Promise<AdapterModel[]> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    let settled = false;

    const finish = (models: AdapterModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(models);
    };

    const timer = setTimeout(() => finish([]), CONNECT_TIMEOUT_MS);

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.warn("[openclaw-models] WebSocket creation failed:", err);
      finish([]);
      return;
    }

    ws.on("error", (err) => {
      console.warn("[openclaw-models] WebSocket error:", err);
      finish([]);
    });
    ws.on("close", () => finish([]));

    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(String(data));
        if (frame.type === "event" && frame.event === "connect.challenge") {
          ws.send(JSON.stringify({
            type: "req", id: "c1", method: "connect",
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: "gateway-client", version: "paperclip", platform: "node", mode: "backend" },
              role: "operator", scopes: ["operator.admin"],
              ...(token ? { auth: { token } } : {}),
            },
          }));
          return;
        }
        if (frame.type === "res" && frame.id === "c1") {
          if (!frame.ok) {
            console.warn("[openclaw-models] Connect failed:", frame.error?.message ?? "unknown");
            finish([]);
            return;
          }
          ws.send(JSON.stringify({ type: "req", id: "ml", method: "models.list", params: {} }));
          return;
        }
        if (frame.type === "res" && frame.id === "ml") {
          if (!frame.ok) {
            console.warn("[openclaw-models] models.list failed:", frame.error?.message ?? "unknown");
            finish([]);
            return;
          }
          const models = ((frame.payload as { models?: GatewayModel[] }).models ?? []).map(toAdapterModel);
          finish(models);
        }
      } catch (err) {
        console.warn("[openclaw-models] Message parse error:", err);
      }
    });
  });
}

export async function listOpenClawModels(): Promise<AdapterModel[]> {
  const wsUrl = resolveWsUrl();
  const entry = cacheByUrl.get(wsUrl);
  if (entry && Date.now() < entry.expiresAt) return entry.models;

  const token = resolveToken();
  const models = await fetchModelsViaWs(wsUrl, token);

  if (models.length > 0) {
    cacheByUrl.set(wsUrl, { expiresAt: Date.now() + CACHE_TTL_MS, models });
  }
  return models;
}

export function resetOpenClawModelsCacheForTests(): void {
  cacheByUrl.clear();
}
