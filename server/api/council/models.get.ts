import { listOllamaModels } from "../../utils/council-ollama";

export default defineEventHandler(async () => {
  try {
    return { models: await listOllamaModels() };
  } catch {
    throw createError({ statusCode: 503, message: "Ollama is niet bereikbaar." });
  }
});
