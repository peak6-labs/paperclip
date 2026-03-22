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

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a skill snapshot for the OpenClaw Gateway adapter.
 *
 * Paperclip-bundled skills are listed from the adapter's local skills directory
 * and injected into the wake message at execution time (hash-based dedup).
 *
 * OpenClaw native skills (from the gateway's `~/.openclaw/workspace/skills/`)
 * are NOT listed here — they are managed by the gateway itself. The adapter can
 * query them via `skills.status` RPC at execution time and inject prompt-based
 * enable/disable instructions per session.
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

  // Query OpenClaw gateway for native skills
  const gatewaySkills = await queryGatewaySkills(config);
  const hasExplicitDesired = Boolean(
    typeof config.paperclipSkillSync === "object" &&
    config.paperclipSkillSync !== null &&
    Array.isArray((config.paperclipSkillSync as Record<string, unknown>).desiredSkills),
  );
  for (const gs of gatewaySkills) {
    const key = `openclaw/${gs.key || gs.name || "unknown"}`;
    // If user has never synced (no explicit desiredSkills), default to gateway's enabled state.
    // Once the user has synced, only mark as desired if explicitly in the saved set.
    const isDesired = hasExplicitDesired ? desiredSet.has(key) : (gs.enabled !== false);
    if (isDesired && !desiredSet.has(key)) {
      desiredSkills.push(key);
      desiredSet.add(key);
    }
    entries.push({
      key,
      runtimeName: gs.name ?? gs.key ?? null,
      desired: isDesired,
      managed: false,
      state: isDesired ? "installed" : "available",
      origin: "user_installed",
      originLabel: "OpenClaw Gateway",
      readOnly: false,
      sourcePath: gs.location ?? undefined,
      targetPath: undefined,
      detail: gs.description ?? null,
    });
  }

  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableEntries.some((e) => e.key === desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
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
      detail: "Paperclip cannot find this skill in the adapter skills directory.",
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
