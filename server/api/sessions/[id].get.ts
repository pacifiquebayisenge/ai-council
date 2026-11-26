import database from "../../utils/database";

interface SessionRow {
  id: string;
  title: string;
  mode: "quick" | "deep";
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "council";
  content: string;
  metadata: string | null;
  created_at: string;
}

export default defineEventHandler((event) => {
  const sessionId = getRouterParam(event, "id");

  if (!sessionId) {
    throw createError({
      statusCode: 400,
      statusMessage: "Sessie-ID ontbreekt.",
    });
  }

  const session = database
    .prepare(
      `
      SELECT
        id,
        title,
        mode,
        created_at,
        updated_at
      FROM sessions
      WHERE id = ?
    `,
    )
    .get(sessionId) as SessionRow | undefined;

  if (!session) {
    throw createError({
      statusCode: 404,
      statusMessage: "Sessie niet gevonden.",
    });
  }

  const messages = database
    .prepare(
      `
      SELECT
        id,
        session_id,
        role,
        content,
        metadata,
        created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(sessionId) as MessageRow[];

  return {
    id: session.id,
    title: session.title,
    mode: session.mode,
    createdAt: session.created_at,
    updatedAt: session.updated_at,

    messages: messages.map((message) => ({
      id: message.id,
      sessionId: message.session_id,
      role: message.role,
      content: message.content,
      metadata: message.metadata ? JSON.parse(message.metadata) : null,
      createdAt: message.created_at,
    })),
  };
});
