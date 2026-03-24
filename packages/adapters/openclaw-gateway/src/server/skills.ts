import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { gatewayRpc } from "./gateway-rpc.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

interface GatewaySkillInfo {
  /** Canonical skill identifier (folder-based slug). */
  skillKey?: string;
  /** Display name from SKILL.md frontmatter. May contain spaces/caps. */
  name?: string;
  description?: string;
  /** Absolute path to SKILL.md on the gateway host. */
  filePath?: string;
  /** Absolute path to the skill directory on the gateway host. */
  baseDir?: string;
  source?: string;
  bundled?: boolean;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAllowlist?: boolean;
  missing?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
    os?: string[];
  };
  requirements?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
    os?: string[];
  };
}

interface GatewaySkillsPayload {
  skills?: GatewaySkillInfo[];
}

/**
 * Derive a stable slug key from the gateway skill data.
 * Prefers skillKey (already a slug). Falls back to deriving from baseDir,
 * then name (lowercased, spaces replaced).
 */
function deriveSkillSlug(gs: GatewaySkillInfo): string {
  if (gs.skillKey) {
    // If skillKey is already a clean slug, use it directly.
    // If it contains spaces (e.g. "Agent Browser"), derive from baseDir instead.
    if (!gs.skillKey.includes(" ")) return gs.skillKey;
  }
  if (gs.baseDir) {
    return path.basename(gs.baseDir);
  }
  // Last resort: slugify the name or skillKey
  const raw = gs.skillKey || gs.name || "unknown";
  return raw.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Query OpenClaw gateway for native skills via skills.status RPC.
 * Returns empty array on failure (non-blocking — gateway may be offline).
 * Retries once on timeout before giving up.
 */
async function queryGatewaySkills(config: Record<string, unknown>): Promise<GatewaySkillInfo[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await gatewayRpc<GatewaySkillsPayload>(config, "skills.status", {}, 15_000);
    if (!result.ok) {
      if (result.error?.code === "TIMEOUT" && attempt === 0) {
        console.warn("[openclaw-gateway] skills.status timed out, retrying…");
        continue;
      }
      console.error("[openclaw-gateway] skills.status RPC failed:", JSON.stringify(result.error));
      return [];
    }
    if (!result.payload?.skills) {
      console.error("[openclaw-gateway] skills.status returned no skills array");
      return [];
    }
    return result.payload.skills;
  }
  return [];
}

/**
 * Build a human-readable location label for a gateway skill.
 */
function buildGatewayLocationLabel(gs: GatewaySkillInfo): string {
  const isEnabled = gs.eligible !== false && gs.disabled !== true;
  if (isEnabled) return "Gateway: enabled";
  if (gs.blockedByAllowlist) return "Gateway: blocked by allowlist";
  if (gs.disabled) return "Gateway: disabled";
  const m = gs.missing;
  if (m) {
    if (m.os?.length) return `Gateway: unavailable (requires ${m.os.join(", ")})`;
    if (m.bins?.length || m.anyBins?.length || m.env?.length) return "Gateway: missing requirements";
  }
  return "Gateway: unavailable";
}

/**
 * Build a detail string explaining a gateway skill's status.
 */
function buildGatewayDetail(gs: GatewaySkillInfo): string | null {
  const isEnabled = gs.eligible !== false && gs.disabled !== true;
  const parts: string[] = [];

  if (gs.description) parts.push(gs.description);

  if (!isEnabled) {
    const reasons: string[] = [];
    if (gs.blockedByAllowlist) {
      reasons.push("Not in the gateway's skill allowlist (skills.allowBundled in openclaw.json)");
    }
    const m = gs.missing;
    if (m) {
      if (m.os?.length) reasons.push(`Requires OS: ${m.os.join(", ")}`);
      if (m.bins?.length) reasons.push(`Missing binaries: ${m.bins.join(", ")}`);
      if (m.anyBins?.length) reasons.push(`Missing any of: ${m.anyBins.join(", ")}`);
      if (m.env?.length) reasons.push(`Missing env vars: ${m.env.join(", ")}`);
      if (m.config?.length) reasons.push(`Missing config: ${m.config.join(", ")}`);
    }
    if (reasons.length > 0) {
      parts.push(`⚠ ${reasons.join(". ")}.`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Build a skill snapshot for the OpenClaw Gateway adapter.
 *
 * Two skill sources:
 * 1. Paperclip-bundled skills — listed from the adapter's local skills directory,
 *    injected into the wake message at execution time (hash-based dedup).
 * 2. OpenClaw native skills — queried via skills.status RPC from the gateway.
 *    ALL skills are included (eligible and ineligible) for full visibility.
 *    Toggles saved in Paperclip config, enforced via prompt instruction at
 *    execution time (soft control).
 */
async function buildOpenClawSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);

  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be injected into the agent session on the next run (message-based, hash-deduped)."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));

  // Query OpenClaw gateway for native skills (includes all — eligible and ineligible)
  const gatewaySkills = await queryGatewaySkills(config);

  // Build canonical key map for stale desiredSkills migration.
  // e.g. "openclaw/agent browser" → "openclaw/agent-browser"
  const canonicalKeyMap = new Map<string, string>();
  for (const gs of gatewaySkills) {
    const slug = deriveSkillSlug(gs);
    const canonical = `openclaw/${slug}`;
    // Map any variant the old code might have produced
    if (gs.skillKey && gs.skillKey.includes(" ")) {
      canonicalKeyMap.set(`openclaw/${gs.skillKey}`, canonical);
      canonicalKeyMap.set(`openclaw/${gs.skillKey.toLowerCase()}`, canonical);
      canonicalKeyMap.set(`openclaw/${gs.skillKey.toLowerCase().replace(/\s+/g, "-")}`, canonical);
    }
    if (gs.name && gs.name !== slug) {
      canonicalKeyMap.set(`openclaw/${gs.name}`, canonical);
      canonicalKeyMap.set(`openclaw/${gs.name.toLowerCase()}`, canonical);
    }
  }

  // Migrate stale keys in desiredSkills
  for (let i = 0; i < desiredSkills.length; i++) {
    const mapped = canonicalKeyMap.get(desiredSkills[i]!);
    if (mapped && mapped !== desiredSkills[i]) {
      console.info(`[openclaw-gateway] Migrating stale desired skill key: "${desiredSkills[i]}" → "${mapped}"`);
      desiredSet.delete(desiredSkills[i]!);
      desiredSkills[i] = mapped;
      desiredSet.add(mapped);
    }
  }

  const hasExplicitDesired = Boolean(
    typeof config.paperclipSkillSync === "object" &&
    config.paperclipSkillSync !== null &&
    Array.isArray((config.paperclipSkillSync as Record<string, unknown>).desiredSkills),
  );
  for (const gs of gatewaySkills) {
    const slug = deriveSkillSlug(gs);
    const key = `openclaw/${slug}`;
    const displayName = gs.name ?? gs.skillKey ?? slug;
    const isGatewayEnabled = gs.eligible !== false && gs.disabled !== true;

    // If user has never synced (no explicit desiredSkills), default to gateway's enabled state.
    // Once the user has synced, only mark as desired if explicitly in the saved set.
    const isDesired = hasExplicitDesired ? desiredSet.has(key) : isGatewayEnabled;
    if (isDesired && !desiredSet.has(key)) {
      desiredSkills.push(key);
      desiredSet.add(key);
    }

    const locationLabel = buildGatewayLocationLabel(gs);
    const detail = buildGatewayDetail(gs);

    // Ineligible skills: show as available but read-only with explanation
    entries.push({
      key,
      runtimeName: displayName !== slug ? `${slug} (${displayName})` : displayName,
      desired: isDesired,
      managed: false,
      state: isDesired ? "installed" : "available",
      origin: "user_installed",
      originLabel: "OpenClaw Gateway",
      readOnly: !isGatewayEnabled,
      sourcePath: gs.filePath ?? gs.baseDir ?? undefined,
      targetPath: undefined,
      detail,
      locationLabel,
    });
  }

  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (entries.some((e) => e.key === desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "openclaw_gateway",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listOpenClawSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenClawSkillSnapshot(ctx.config);
}

export async function syncOpenClawSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Write the explicitly requested skills, then rebuild the full snapshot.
  // Temporarily override the config's desiredSkills so buildOpenClawSkillSnapshot
  // uses the new set instead of auto-adding enabled gateway skills.
  const patchedConfig = {
    ...ctx.config,
    paperclipSkillSync: {
      ...(typeof ctx.config.paperclipSkillSync === "object" && ctx.config.paperclipSkillSync !== null
        ? ctx.config.paperclipSkillSync as Record<string, unknown>
        : {}),
      desiredSkills,
    },
  };
  return buildOpenClawSkillSnapshot(patchedConfig);
}
