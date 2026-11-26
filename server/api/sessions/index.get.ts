import database, { type StoredSession } from "../../utils/database";

interface SessionRow {
  id: string;
  title: string;
  mode: "quick" | "deep";
  created_at: string;
  updated_at: string;
}

export default defineEventHandler((): StoredSession[] => {
  const rows = database
    .prepare(
      `
      SELECT
        id,
        title,
        mode,
        created_at,
        updated_at
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT 50
    `,
    )
    .all() as SessionRow[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
});
