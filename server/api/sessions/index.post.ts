import database, { type StoredSession } from "../../utils/database";

interface CreateSessionRequest {
  title?: string;
  mode?: "quick" | "deep";
}

export default defineEventHandler(async (event): Promise<StoredSession> => {
  const body = await readBody<CreateSessionRequest>(event);

  const now = new Date().toISOString();

  const session: StoredSession = {
    id: crypto.randomUUID(),
    title: body.title?.trim() || "Nieuwe raad",
    mode: body.mode === "deep" ? "deep" : "quick",
    createdAt: now,
    updatedAt: now,
  };

  database
    .prepare(
      `
        INSERT INTO sessions (
          id,
          title,
          mode,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run(
      session.id,
      session.title,
      session.mode,
      session.createdAt,
      session.updatedAt,
    );

  return session;
});
