/**
 * Lightweight gateway RPC helper for one-shot queries (skills.status, etc.).
 * Supports token auth + device auth (ed25519 signing) for gateways that require pairing.
 */
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import crypto, { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const match = rawHeader.trim().match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : nonEmpty(rawHeader);
}

function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;
  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);
  const authHeader = headerMapGetIgnoreCase(headers, "x-openclaw-auth") ?? headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((e) => (Buffer.isBuffer(e) ? e : Buffer.from(String(e), "utf8")))).toString("utf8");
  }
  return String(data ?? "");
}

/* ---- Device auth helpers (mirrored from execute.ts) ---- */

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key));
}

function buildDeviceAuthPayloadV3(p: {
  deviceId: string; clientId: string; clientMode: string; role: string;
  scopes: string[]; signedAtMs: number; token?: string | null; nonce: string;
}): string {
  return ["v3", p.deviceId, p.clientId, p.clientMode, p.role, p.scopes.join(","),
    String(p.signedAtMs), p.token ?? "", p.nonce, process.platform, ""].join("|");
}

interface DeviceIdentity {
  deviceId: string;
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
}

function resolveDeviceIdentity(config: Record<string, unknown>): DeviceIdentity | null {
  const pem = nonEmpty(config.devicePrivateKeyPem);
  if (!pem) return null;
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);
  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyRawBase64Url: base64UrlEncode(raw),
    privateKeyPem: pem,
  };
}

export interface GatewayRpcResult<T = unknown> {
  ok: boolean;
  payload?: T;
  error?: { code?: string; message?: string };
}

/**
 * Connect to the OpenClaw gateway, authenticate, send a single RPC call, and disconnect.
 * Returns the response payload or an error. Timeout defaults to 10 seconds.
 */
export async function gatewayRpc<T = unknown>(
  config: Record<string, unknown>,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<GatewayRpcResult<T>> {
  const rawConfig = parseObject(config);
  const headers = toStringRecord(rawConfig.headers);
  const authToken = resolveAuthToken(rawConfig, headers);
  const urlStr = nonEmpty(rawConfig.url);

  if (!urlStr) return { ok: false, error: { code: "NO_URL", message: "Gateway URL not configured" } };

  const role = nonEmpty(rawConfig.role) ?? "operator";
  const scopes = (() => {
    const raw = rawConfig.scopes;
    if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
    if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
    return ["operator.admin", "operator.read"];
  })();

  return new Promise((resolve) => {
    let done = false;
    const finish = (result: GatewayRpcResult<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, error: { code: "TIMEOUT", message: `Gateway RPC timed out after ${timeoutMs}ms` } }), timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(urlStr, { headers, maxPayload: 2 * 1024 * 1024 });
    } catch (e) {
      clearTimeout(timer);
      return resolve({ ok: false, error: { code: "WS_ERROR", message: e instanceof Error ? e.message : String(e) } });
    }

    const connectId = randomUUID();
    const rpcId = randomUUID();
    const device = resolveDeviceIdentity(rawConfig);
    const clientId = "gateway-client";
    const clientMode = "backend";

    ws.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(rawDataToString(raw)); } catch { return; }

      // Challenge → connect (with device auth if available)
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = String((frame.payload as Record<string, unknown>)?.nonce ?? "");
        const signedAtMs = Date.now();
        const connectParams: Record<string, unknown> = {
          minProtocol: 3, maxProtocol: 3,
          client: { id: clientId, version: "paperclip", platform: process.platform, mode: clientMode },
          role, scopes,
          ...(authToken ? { auth: { token: authToken } } : {}),
        };
        if (device && nonce) {
          const payload = buildDeviceAuthPayloadV3({
            deviceId: device.deviceId, clientId, clientMode, role, scopes, signedAtMs, token: authToken, nonce,
          });
          connectParams.device = {
            id: device.deviceId,
            publicKey: device.publicKeyRawBase64Url,
            signature: signDevicePayload(device.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          };
        }
        ws.send(JSON.stringify({ type: "req", id: connectId, method: "connect", params: connectParams }));
        return;
      }

      // Connect response → send RPC (or auto-pair if needed)
      if (frame.type === "res" && frame.id === connectId) {
        if (!frame.ok) {
          const err = frame.error as Record<string, unknown> | undefined;
          const errMsg = String(err?.message ?? "");
          const isPairingRequired = errMsg.toLowerCase().includes("pairing required");
          if (isPairingRequired && authToken && device) {
            // Auto-approve pairing then retry
            autoApprovePairing(urlStr, headers, authToken, device, role, scopes)
              .then((pairOk) => {
                if (pairOk) {
                  // Retry the whole RPC call after successful pairing
                  try { ws.close(); } catch { /* ignore */ }
                  gatewayRpc<T>(config, method, params, timeoutMs).then(finish);
                } else {
                  finish({ ok: false, error: { code: "PAIRING_FAILED", message: "Auto-pairing failed. Approve the device manually in OpenClaw." } });
                }
              })
              .catch(() => finish({ ok: false, error: { code: "PAIRING_ERROR", message: "Auto-pairing error" } }));
            return;
          }
          finish({ ok: false, error: { code: String(err?.code ?? "CONNECT_FAILED"), message: String(err?.message ?? "Gateway connect failed") } });
          return;
        }
        ws.send(JSON.stringify({ type: "req", id: rpcId, method, params }));
        return;
      }

      // RPC response → return result
      if (frame.type === "res" && frame.id === rpcId) {
        if (frame.ok) {
          finish({ ok: true, payload: frame.payload as T });
        } else {
          const err = frame.error as Record<string, unknown> | undefined;
          finish({ ok: false, error: { code: String(err?.code ?? "RPC_FAILED"), message: String(err?.message ?? `${method} failed`) } });
        }
      }
    });

    ws.on("error", () => finish({ ok: false, error: { code: "WS_ERROR", message: "WebSocket connection error" } }));
    ws.on("close", () => { if (!done) finish({ ok: false, error: { code: "WS_CLOSED", message: "Connection closed before response" } }); });
  });
}

/**
 * Attempt to auto-approve a pending device pairing request.
 * Opens a separate WS connection with pairing scopes, finds pending request, approves it.
 */
async function autoApprovePairing(
  url: string,
  headers: Record<string, string>,
  authToken: string,
  device: DeviceIdentity,
  role: string,
  scopes: string[],
): Promise<boolean> {
  const approvalScopes = [...new Set([...scopes, "operator.pairing"])];
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); try { pairWs.close(); } catch { /* */ } resolve(ok); } };
    const timer = setTimeout(() => finish(false), 15_000);

    let pairWs: WebSocket;
    try { pairWs = new WebSocket(url, { headers, maxPayload: 2 * 1024 * 1024 }); } catch { return resolve(false); }

    const connId = randomUUID();
    const listId = randomUUID();
    const approveId = randomUUID();

    pairWs.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(rawDataToString(raw)); } catch { return; }

      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = String((frame.payload as Record<string, unknown>)?.nonce ?? "");
        const signedAtMs = Date.now();
        const payload = buildDeviceAuthPayloadV3({
          deviceId: device.deviceId, clientId: "gateway-client", clientMode: "backend",
          role, scopes: approvalScopes, signedAtMs, token: authToken, nonce,
        });
        pairWs.send(JSON.stringify({
          type: "req", id: connId, method: "connect",
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: "gateway-client", version: "paperclip", platform: process.platform, mode: "backend" },
            role, scopes: approvalScopes,
            auth: { token: authToken },
            device: {
              id: device.deviceId, publicKey: device.publicKeyRawBase64Url,
              signature: signDevicePayload(device.privateKeyPem, payload),
              signedAt: signedAtMs, nonce,
            },
          },
        }));
        return;
      }

      if (frame.type === "res" && frame.id === connId) {
        if (!frame.ok) { finish(false); return; }
        pairWs.send(JSON.stringify({ type: "req", id: listId, method: "device.pair.list", params: {} }));
        return;
      }

      if (frame.type === "res" && frame.id === listId) {
        if (!frame.ok) { finish(false); return; }
        const pending = Array.isArray((frame.payload as Record<string, unknown>)?.pending)
          ? ((frame.payload as Record<string, unknown>).pending as Array<Record<string, unknown>>)
          : [];
        const match = pending.find((e) => String(e.deviceId ?? "") === device.deviceId) ?? pending[pending.length - 1];
        const requestId = match ? String(match.requestId ?? "") : "";
        if (!requestId) { finish(false); return; }
        pairWs.send(JSON.stringify({ type: "req", id: approveId, method: "device.pair.approve", params: { requestId } }));
        return;
      }

      if (frame.type === "res" && frame.id === approveId) {
        finish(frame.ok === true);
      }
    });

    pairWs.on("error", () => finish(false));
    pairWs.on("close", () => { if (!done) finish(false); });
  });
}
