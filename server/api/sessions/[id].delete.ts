import database from "../../utils/database";

export default defineEventHandler((event) => {
  const sessionId = getRouterParam(event, "id");

  if (!sessionId) {
    throw createError({
      statusCode: 400,
      statusMessage: "Sessie-ID ontbreekt.",
    });
  }

  const result = database
    .prepare(
      `
      DELETE FROM sessions
      WHERE id = ?
    `,
    )
    .run(sessionId);

  if (result.changes === 0) {
    throw createError({
      statusCode: 404,
      statusMessage: "Sessie niet gevonden.",
    });
  }

  return {
    success: true,
  };
});
