import database from "../../utils/database";
import { loadUserContext, storeUserContext } from "../../utils/council-context";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sessionId?: string; key?: string }>(event);
  const sessionId = body?.sessionId?.trim();
  const key = body?.key?.trim().toLowerCase();
  if (!sessionId || !key) throw createError({ statusCode: 400, message: "sessionId and key required." });
  if (!database.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId)) {
    throw createError({ statusCode: 404, message: "Session not found." });
  }
  const context = loadUserContext(sessionId);
  if (!context) return { context: null };
  context.facts = context.facts.filter((fact) => fact.key !== key);
  context.deletedKeys = [...new Set([...(context.deletedKeys ?? []), key])];
  storeUserContext(sessionId, context);
  return { context };
});
