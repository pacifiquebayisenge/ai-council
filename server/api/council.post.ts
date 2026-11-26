import { councillors } from "../data/councillors";
import database from "../utils/database";

type CouncilMode = "quick" | "deep";

interface UserProfile {
  country?: string;
  situation?: string;
  goals?: string;
  riskProfile?: string;
  timeHorizon?: string;
}

interface CouncilRequest {
  message: string;
  sessionId?: string;
  mode?: CouncilMode;
  selectedCouncillorIds?: string[];
  profile?: UserProfile;
}

interface OllamaResponse {
  response: string;
}

interface StructuredAdvice {
  summary: string;
  keyPoints: string[];
  advantages: string[];
  risks: string[];
  recommendation: string;
  missingInformation: string[];
  confidence: number;
}

interface CouncilAnswer {
  id: string;
  name: string;
  role: string;
  description: string;
  emoji: string;
  success: boolean;
  advice: StructuredAdvice | null;
  error?: string;
}

interface ChairmanConclusion {
  verdict: string;
  recommendedAction: string;
  reasoning: string;
  consensus: string[];
  disagreements: string[];
  nextSteps: string[];
  importantCaution: string;
  confidence: number;
}

interface SessionRow {
  id: string;
  title: string;
  mode: CouncilMode;
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

function parseJsonResponse<T>(response: string): T {
  const cleanedResponse = response
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleanedResponse) as T;
  } catch {
    const firstBrace = cleanedResponse.indexOf("{");
    const lastBrace = cleanedResponse.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      console.error("Ongeldige ruwe modeloutput:", response);

      throw new Error("Het model gaf geen geldige JSON terug.");
    }

    const extractedJson = cleanedResponse.slice(firstBrace, lastBrace + 1);

    try {
      return JSON.parse(extractedJson) as T;
    } catch (error) {
      console.error("Ruwe modeloutput:", response);
      console.error("Uitgehaalde JSON:", extractedJson);
      console.error("JSON parse error:", error);

      throw new Error("Het model gaf ongeldige of onvolledige JSON terug.");
    }
  }
}

function clampConfidence(value: unknown): number {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return 50;
  }

  return Math.min(100, Math.max(0, Math.round(numberValue)));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAdvice(advice: StructuredAdvice): StructuredAdvice {
  return {
    summary:
      typeof advice.summary === "string" && advice.summary.trim()
        ? advice.summary.trim()
        : "Geen samenvatting beschikbaar.",

    keyPoints: normalizeStringArray(advice.keyPoints),

    advantages: normalizeStringArray(advice.advantages),

    risks: normalizeStringArray(advice.risks),

    recommendation:
      typeof advice.recommendation === "string" && advice.recommendation.trim()
        ? advice.recommendation.trim()
        : "Er kon geen aanbeveling worden opgesteld.",

    missingInformation: normalizeStringArray(advice.missingInformation),

    confidence: clampConfidence(advice.confidence),
  };
}

function normalizeConclusion(
  conclusion: ChairmanConclusion,
): ChairmanConclusion {
  return {
    verdict:
      typeof conclusion.verdict === "string" && conclusion.verdict.trim()
        ? conclusion.verdict.trim()
        : "Geen besluit beschikbaar.",

    recommendedAction:
      typeof conclusion.recommendedAction === "string" &&
      conclusion.recommendedAction.trim()
        ? conclusion.recommendedAction.trim()
        : "Er kon geen concrete actie worden bepaald.",

    reasoning:
      typeof conclusion.reasoning === "string"
        ? conclusion.reasoning.trim()
        : "",

    consensus: normalizeStringArray(conclusion.consensus),

    disagreements: normalizeStringArray(conclusion.disagreements),

    nextSteps: normalizeStringArray(conclusion.nextSteps),

    importantCaution:
      typeof conclusion.importantCaution === "string"
        ? conclusion.importantCaution.trim()
        : "",

    confidence: clampConfidence(conclusion.confidence),
  };
}

export default defineEventHandler(async (event) => {
  const body = await readBody<CouncilRequest>(event);
  const message = body.message?.trim();

  if (!message) {
    throw createError({
      statusCode: 400,
      statusMessage: "Een vraag is verplicht.",
    });
  }

  let sessionId = body.sessionId?.trim();

  if (sessionId) {
    const existingSession = database
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

    if (!existingSession) {
      throw createError({
        statusCode: 404,
        statusMessage: "Sessie niet gevonden.",
      });
    }
  } else {
    sessionId = crypto.randomUUID();

    const now = new Date().toISOString();
    const generatedTitle =
      message.length > 60 ? `${message.slice(0, 57)}...` : message;

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
        sessionId,
        generatedTitle,
        body.mode === "deep" ? "deep" : "quick",
        now,
        now,
      );
  }

  const mode: CouncilMode = body.mode === "deep" ? "deep" : "quick";

  const selectedCouncillors = body.selectedCouncillorIds?.length
    ? councillors.filter((councillor) =>
        body.selectedCouncillorIds?.includes(councillor.id),
      )
    : councillors;

  if (!selectedCouncillors.length) {
    throw createError({
      statusCode: 400,
      statusMessage: "Selecteer minstens één raadslid.",
    });
  }

  const previousMessages = database
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
    ORDER BY created_at DESC
    LIMIT 8
  `,
    )
    .all(sessionId) as MessageRow[];

  previousMessages.reverse();

  const conversationContext = previousMessages.length
    ? previousMessages
        .map((storedMessage) => {
          if (storedMessage.role === "user") {
            return `Gebruiker: ${storedMessage.content}`;
          }

          try {
            const metadata = storedMessage.metadata
              ? JSON.parse(storedMessage.metadata)
              : null;

            const conclusion =
              metadata?.conclusion?.verdict ||
              metadata?.conclusion?.recommendedAction;

            return conclusion
              ? `Vorige conclusie van de raad: ${conclusion}`
              : `Vorige reactie van de raad: ${storedMessage.content}`;
          } catch {
            return `Vorige reactie van de raad: ${storedMessage.content}`;
          }
        })
        .join("\n\n")
    : "Er is nog geen eerdere gesprekscontext.";

  const profile = body.profile ?? {};

  const profileContext = `
Land of context: ${profile.country || "Niet opgegeven"}
Persoonlijke situatie: ${profile.situation || "Niet opgegeven"}
Doelen: ${profile.goals || "Niet opgegeven"}
Risicoprofiel: ${profile.riskProfile || "Niet opgegeven"}
Tijdshorizon: ${profile.timeHorizon || "Niet opgegeven"}
`.trim();

  console.log(
    `🏛️ Raad gestart met ${selectedCouncillors.length} raadsleden in ${mode}-modus`,
  );

  const userMessageId = crypto.randomUUID();
  const userMessageCreatedAt = new Date().toISOString();

  database
    .prepare(
      `
    INSERT INTO messages (
      id,
      session_id,
      role,
      content,
      metadata,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(userMessageId, sessionId, "user", message, null, userMessageCreatedAt);

  const answers = await Promise.all(
    selectedCouncillors.map(async (councillor): Promise<CouncilAnswer> => {
      console.log(`▶ ${councillor.name} begint`);

      try {
        const result = await $fetch<OllamaResponse>(
          "http://localhost:11434/api/generate",
          {
            method: "POST",

            body: {
              model: councillor.model,
              stream: false,
              format: "json",

              prompt: `
${councillor.systemPrompt}

Persoonlijke context:
${profileContext}

Eerdere context uit deze sessie:
${conversationContext}

Nieuwe vraag van de gebruiker:
${message}

Geef een onafhankelijke analyse vanuit uitsluitend jouw eigen specialisatie.

Belangrijke regels:
- Geef geen introductie.
- Herhaal de vraag niet.
- Geef geen algemene encyclopedische uitleg.
- Houd de samenvatting onder 40 woorden.
- Geef maximaal drie kernpunten.
- Geef maximaal twee voordelen.
- Geef maximaal twee risico's.
- Geef maximaal drie ontbrekende gegevens.
- Houd ieder lijstpunt onder 25 woorden.
- Houd de aanbeveling onder 60 woorden.
- Verzin geen actuele wetten, belastingen, rentevoeten of marktgegevens.
- Doe geen concrete fiscale uitspraken zonder voldoende informatie.
- Zeg bij fiscale onzekerheid dat dit afzonderlijk voor België moet worden gecontroleerd.
- Behandel de S&P 500 niet automatisch als een defensieve belegging.
- Maak onderscheid tussen gegarandeerde besparing en verwacht rendement.
- Antwoord uitsluitend in natuurlijk Nederlands.
- Begin direct met {
- Eindig direct met }
- Gebruik geen Markdown-codeblok.
- Gebruik geen tekst vóór of na de JSON.
- Gebruik dubbele aanhalingstekens voor alle JSON-sleutels en teksten.
- Geef uitsluitend geldige en volledige JSON terug.

Gebruik exact deze structuur:
{
  "summary": "Korte conclusie",
  "keyPoints": [
    "Punt 1",
    "Punt 2"
  ],
  "advantages": [
    "Voordeel 1",
    "Voordeel 2"
  ],
  "risks": [
    "Risico 1",
    "Risico 2"
  ],
  "recommendation": "Concrete aanbeveling",
  "missingInformation": [
    "Ontbrekend gegeven"
  ],
  "confidence": 75
}
`,

              options: {
                ...councillor.options,

                num_predict: mode === "deep" ? 1400 : 900,
              },
            },
          },
        );

        console.log(`📦 Ruwe output van ${councillor.name}:`);
        console.log(result.response);

        const advice = normalizeAdvice(
          parseJsonResponse<StructuredAdvice>(result.response),
        );

        console.log(`✓ ${councillor.name} klaar`);

        return {
          id: councillor.id,
          name: councillor.name,
          role: councillor.role,
          description: councillor.description,
          emoji: councillor.emoji,
          success: true,
          advice,
        };
      } catch (error) {
        console.error(`❌ ${councillor.name} mislukt`, error);

        return {
          id: councillor.id,
          name: councillor.name,
          role: councillor.role,
          description: councillor.description,
          emoji: councillor.emoji,
          success: false,
          advice: null,
          error:
            "Dit raadslid kon geen geldig advies genereren. Probeer de vraag opnieuw.",
        };
      }
    }),
  );

  const successfulAnswers = answers.filter(
    (answer) => answer.success && answer.advice,
  );

  let conclusion: ChairmanConclusion | null = null;

  if (successfulAnswers.length) {
    try {
      console.log("▶ Voorzitter analyseert de adviezen");

      const compactAdvice = successfulAnswers.map((answer) => ({
        name: answer.name,
        role: answer.role,
        summary: answer.advice?.summary,
        keyPoints: answer.advice?.keyPoints,
        advantages: answer.advice?.advantages,
        risks: answer.advice?.risks,
        recommendation: answer.advice?.recommendation,
        missingInformation: answer.advice?.missingInformation,
        confidence: answer.advice?.confidence,
      }));

      const chairmanResult = await $fetch<OllamaResponse>(
        "http://localhost:11434/api/generate",
        {
          method: "POST",

          body: {
            model: "gemma3:12b",
            stream: false,
            format: "json",

            prompt: `
Je bent de voorzitter van een persoonlijke AI Council.

Je krijgt adviezen van gespecialiseerde raadsleden.

Je taak:
- Formuleer één praktisch eindadvies.
- Herhaal de volledige analyses niet.
- Vergelijk de aanbevelingen.
- Benoem overeenstemming en echte meningsverschillen.
- Geef een concrete volgende actie.

vraag:
${message}

Persoonlijke context:
${profileContext}

Eerdere context uit deze sessie:
${conversationContext}


Adviezen:
${JSON.stringify(compactAdvice, null, 2)}

Belangrijke regels:
- Geef een duidelijk en concreet oordeel.
- Houd het kernbesluit onder 50 woorden.
- Houd de aanbevolen actie onder 60 woorden.
- Houd de onderbouwing onder 100 woorden.
- Geef maximaal drie punten van overeenstemming.
- Geef maximaal drie meningsverschillen.
- Geef maximaal vier volgende stappen.
- Houd ieder lijstpunt onder 25 woorden.
- Maak onderscheid tussen gegarandeerde voordelen en verwachte rendementen.
- Verzin geen actuele Belgische wetgeving, belastingen of marktgegevens.
- Doe geen concrete fiscale uitspraken zonder voldoende informatie.
- Benoem ontbrekende cijfers wanneer die de conclusie kunnen veranderen.
- Behandel de S&P 500 niet automatisch als een defensieve belegging.
- Antwoord uitsluitend in natuurlijk Nederlands.
- Begin direct met {
- Eindig direct met }
- Gebruik geen Markdown-codeblok.
- Gebruik geen tekst vóór of na de JSON.
- Gebruik dubbele aanhalingstekens voor alle JSON-sleutels en teksten.
- Geef uitsluitend geldige en volledige JSON terug.

Gebruik exact deze structuur:
{
  "verdict": "Kernbesluit",
  "recommendedAction": "Concrete aanbevolen actie",
  "reasoning": "Korte onderbouwing",
  "consensus": [
    "Punt van overeenstemming"
  ],
  "disagreements": [
    "Meningsverschil"
  ],
  "nextSteps": [
    "Concrete volgende stap"
  ],
  "importantCaution": "Belangrijkste waarschuwing",
  "confidence": 75
}
`,

            options: {
              temperature: 0.2,
              top_p: 0.8,
              top_k: 25,
              repeat_penalty: 1.15,
              num_ctx: 8192,

              num_predict: mode === "deep" ? 1200 : 800,
            },
          },
        },
      );

      console.log("📦 Ruwe output van de voorzitter:");
      console.log(chairmanResult.response);

      const parsedConclusion = parseJsonResponse<ChairmanConclusion>(
        chairmanResult.response,
      );

      conclusion = normalizeConclusion(parsedConclusion);

      console.log("✓ Voorzitter klaar");
    } catch (error) {
      console.error("❌ Voorzitter mislukt", error);
    }
  }

  const councilResponse = {
    id: crypto.randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    question: message,
    mode,
    totalCouncillors: answers.length,
    successfulAnswers: successfulAnswers.length,
    answers,
    conclusion,
  };

  database
    .prepare(
      `
    INSERT INTO messages (
      id,
      session_id,
      role,
      content,
      metadata,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      councilResponse.id,
      sessionId,
      "council",
      conclusion?.verdict || "De raad heeft geantwoord.",
      JSON.stringify(councilResponse),
      councilResponse.createdAt,
    );

  database
    .prepare(
      `
    UPDATE sessions
    SET
      mode = ?,
      updated_at = ?
    WHERE id = ?
  `,
    )
    .run(mode, councilResponse.createdAt, sessionId);

  return councilResponse;
});
