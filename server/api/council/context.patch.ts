import database from "../../utils/database";
import { loadUserContext, storeUserContext } from "../../utils/council-context";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sessionId?: string; key?: string; value?: string }>(event);
  const sessionId = body?.sessionId?.trim();
  const key = body?.key?.trim().toLowerCase();
  const value = body?.value?.trim();
  if (!sessionId || !key || !value || key.length > 100 || value.length > 300) {
    throw createError({ statusCode: 400, message: "Valid sessionId, key and value required." });
  }
  if (!database.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId)) {
    throw createError({ statusCode: 404, message: "Session not found." });
  }
  const context = loadUserContext(sessionId);
  if (!context) throw createError({ statusCode: 404, message: "No saved memory." });
  const fact = context.facts.find((entry) => entry.key === key);
  if (!fact) throw createError({ statusCode: 404, message: "Fact not found." });
  fact.value = value;
  fact.evidence = "[Manually corrected by user]";
  storeUserContext(sessionId, context);
  return { context };
});
