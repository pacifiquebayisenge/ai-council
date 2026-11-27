import { getQuery, createError } from "h3";
import database from "../../utils/database";
import { loadUserContext } from "../../utils/council-context";

export default defineEventHandler((event) => {
  const { sessionId } = getQuery(event);
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw createError({ statusCode: 400, message: "sessionId is required." });
  }
  const session = database.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (!session) throw createError({ statusCode: 404, message: "Session not found." });
  return { sessionId, context: loadUserContext(sessionId) };
});
