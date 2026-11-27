import database from "./database";

export interface UserFact {
  key: string;
  value: string;
  evidence: string;
  messageIndex: number;
}
export interface UserContext {
  facts: UserFact[];
  corrections: string[];
  unknowns: string[];
  latestUserMessage: string;
  deletedKeys?: string[];
}

/** Only user-authored statements can provide evidence. Agent text is never trusted. */
export function validateUserContext(
  candidate: unknown,
  userMessages: string[],
): UserContext {
  const input = candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : {};
  const proposed = Array.isArray(input.facts) ? input.facts : [];
  const facts = new Map<string, UserFact>();
  for (const item of proposed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim().toLowerCase() : "";
    const value = typeof row.value === "string" ? row.value.trim() : "";
    const evidence = typeof row.evidence === "string" ? row.evidence.trim() : "";
    const index = Number(row.messageIndex);
    if (!key || !value || !evidence || key.length > 100 || value.length > 300) continue;
    if (!Number.isInteger(index) || index < 0 || index >= userMessages.length) continue;
    if (!userMessages[index]?.toLocaleLowerCase().includes(evidence.toLocaleLowerCase())) continue;
    // Later statements supersede earlier ones for the same constraint.
    const prior = facts.get(key);
    if (!prior || index >= prior.messageIndex) {
      facts.set(key, { key, value, evidence, messageIndex: index });
    }
  }
  const safeStrings = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    facts: [...facts.values()],
    corrections: safeStrings(input.corrections),
    unknowns: safeStrings(input.unknowns),
    latestUserMessage: userMessages.at(-1) ?? "",
  };
}

export function storeUserContext(sessionId: string, context: UserContext) {
  database.prepare(`
    INSERT INTO council_user_context (session_id, context_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      context_json = excluded.context_json,
      updated_at = excluded.updated_at
  `).run(sessionId, JSON.stringify(context), new Date().toISOString());
}

export function loadUserContext(sessionId: string): UserContext | null {
  const row = database.prepare("SELECT context_json FROM council_user_context WHERE session_id = ?")
    .get(sessionId) as { context_json: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.context_json) as UserContext; } catch { return null; }
}
