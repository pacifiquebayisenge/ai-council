const ollama = "http://localhost:11434";

export async function listOllamaModels() {
  const result = await $fetch<{ models: { name: string }[] }>(`${ollama}/api/tags`, {
    timeout: 3000,
    retry: 0,
  });
  return result.models.map(({ name }) => name);
}

interface Generation {
  model: string;
  prompt: string;
  options: Record<string, number>;
  keep_alive: number;
}

export async function generateCouncilReply(
  generation: Generation,
  signal: AbortSignal,
  onWriting: () => void,
) {
  const reply = await fetch(`${ollama}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...generation, format: "json", think: false, stream: true }),
    signal,
  });

  if (!reply.ok || !reply.body) {
    const failure = await reply.json().catch(() => null);
    throw new Error(failure?.error || `Ollama returned HTTP ${reply.status}.`);
  }

  const reader = reply.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let response = "";
  let finished = false;

  function consume(line: string) {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as { response?: string; done?: boolean; error?: string };
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.response) {
      if (!response) onWriting();
      response += chunk.response;
    }
    finished ||= chunk.done === true;
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (buffer + value).split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(consume);
    }
    if (!finished) consume(buffer);
    if (!finished || !response.trim()) throw new Error("Ollama returned an incomplete or empty response.");
    return response;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
