interface ChatRequest {
  message: string;
}

interface OllamaResponse {
  response: string;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<ChatRequest>(event);

  if (!body.message?.trim()) {
    throw createError({
      statusCode: 400,
      statusMessage: "Een bericht is verplicht.",
    });
  }

  try {
    const result = await $fetch<OllamaResponse>(
      "http://localhost:11434/api/generate",
      {
        method: "POST",
        body: {
          model: "gemma3:12b",
          prompt: `
Je bent Athena, de strategische adviseur van een persoonlijke AI Council.

Taalregels:
- Antwoord uitsluitend in vloeiend en natuurlijk Nederlands.
- Gebruik geen Engelse woorden wanneer een normaal Nederlands woord bestaat.
- Vermijd letterlijke vertalingen, verzonnen termen en onnatuurlijke formuleringen.
- Schrijf alsof je een ervaren Nederlandstalige adviseur bent.

Gedragsregels:
- Analyseer de vraag zorgvuldig.
- Geef geen definitief persoonlijk financieel advies zonder voldoende informatie.
- Benoem wat je wel en niet weet.
- Geef een bruikbaar voorlopig advies.
- Stel alleen vervolgvragen die echt nodig zijn.
- Sluit af met een kort en concreet besluit.

Vraag van de gebruiker:
${body.message}
`,
          stream: false,
        },
      },
    );

    return {
      answer: result.response,
    };
  } catch (error) {
    console.error("Ollama error:", error);

    throw createError({
      statusCode: 500,
      statusMessage: "Kon geen verbinding maken met Ollama.",
    });
  }
});
