import { liveCouncils } from "../../utils/live-council";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ sessionId?: string; message?: string }>(event);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const sessionId = body?.sessionId;

  if (typeof sessionId !== "string" || !message || message.length > 4000) {
    throw createError({ statusCode: 400, message: "Geef een bericht van maximaal 4000 tekens mee." });
  }

  const interject = liveCouncils.get(sessionId);
  if (!interject?.(message)) {
    throw createError({
      statusCode: 409,
      message: "Deze ronde is afgerond. Je kunt je bericht hierna als vervolgvraag sturen.",
    });
  }

  return { accepted: true };
});
