import { councillors } from "../../data/councillors";
import database from "../../utils/database";

type CouncilMode = "quick" | "deep";
type ActivityStatus =
  | "waiting"
  | "reading"
  | "thinking"
  | "typing"
  | "speaking"
  | "done"
  | "error";

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

interface CouncilChatMessage {
  id: string;
  councillorId: string;
  name: string;
  emoji: string;
  role: string;
  round: number;
  kind: "opening" | "reply" | "chairman";
  replyTo: string[];
  message: string;
  recommendation?: string;
  confidence: number;
  createdAt: string;
}

interface DebateReply {
  message: string;
  revisedRecommendation: string;
  confidence: number;
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

interface MessageRow {
  role: "user" | "council";
  content: string;
  metadata: string | null;
}

function parseJsonResponse<T>(response: string): T {
  const cleaned = response
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start === -1 || end <= start) {
      throw new Error("Het model gaf geen geldige JSON terug.");
    }

    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
}

function clampConfidence(value: unknown): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 50;
  }

  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function normalizeArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function normalizeAdvice(value: StructuredAdvice): StructuredAdvice {
  return {
    summary: value.summary?.trim() || "Geen samenvatting beschikbaar.",
    keyPoints: normalizeArray(value.keyPoints),
    advantages: normalizeArray(value.advantages),
    risks: normalizeArray(value.risks),
    recommendation:
      value.recommendation?.trim() ||
      "Er kon geen aanbeveling worden opgesteld.",
    missingInformation: normalizeArray(value.missingInformation),
    confidence: clampConfidence(value.confidence),
  };
}

function normalizeConclusion(
  value: ChairmanConclusion,
): ChairmanConclusion {
  return {
    verdict: value.verdict?.trim() || "Geen besluit beschikbaar.",
    recommendedAction:
      value.recommendedAction?.trim() ||
      "Er kon geen concrete actie worden bepaald.",
    reasoning: value.reasoning?.trim() || "",
    consensus: normalizeArray(value.consensus),
    disagreements: normalizeArray(value.disagreements),
    nextSteps: normalizeArray(value.nextSteps),
    importantCaution: value.importantCaution?.trim() || "",
    confidence: clampConfidence(value.confidence),
  };
}

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export default defineEventHandler(async (event) => {
  const body = await readBody<CouncilRequest>(event);
  const question = body.message?.trim();

  if (!question) {
    throw createError({
      statusCode: 400,
      statusMessage: "Een vraag is verplicht.",
    });
  }

  const mode: CouncilMode = body.mode === "deep" ? "deep" : "quick";

  const selectedCouncillors = body.selectedCouncillorIds?.length
    ? councillors.filter((member) =>
        body.selectedCouncillorIds?.includes(member.id),
      )
    : councillors;

  if (!selectedCouncillors.length) {
    throw createError({
      statusCode: 400,
      statusMessage: "Selecteer minstens één raadslid.",
    });
  }

  let sessionId = body.sessionId?.trim();

  if (sessionId) {
    const existingSession = database
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .get(sessionId);

    if (!existingSession) {
      throw createError({
        statusCode: 404,
        statusMessage: "Sessie niet gevonden.",
      });
    }
  } else {
    sessionId = crypto.randomUUID();

    const now = new Date().toISOString();
    const title =
      question.length > 60 ? `${question.slice(0, 57)}...` : question;

    database
      .prepare(`
        INSERT INTO sessions (
          id,
          title,
          mode,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(sessionId, title, mode, now, now);
  }

  const finalSessionId = sessionId;

  const previousMessages = database
    .prepare(`
      SELECT
        role,
        content,
        metadata
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `)
    .all(finalSessionId) as MessageRow[];

  previousMessages.reverse();

  const previousContext = previousMessages.length
    ? previousMessages
        .map((storedMessage) => {
          if (storedMessage.role === "user") {
            return `Gebruiker: ${storedMessage.content}`;
          }

          try {
            const metadata = storedMessage.metadata
              ? JSON.parse(storedMessage.metadata)
              : null;

            const conclusion = metadata?.conclusion?.verdict
              ? `Vorige conclusie: ${metadata.conclusion.verdict}`
              : `Vorige reactie: ${storedMessage.content}`;

            const recentDebate = Array.isArray(metadata?.chatMessages)
              ? metadata.chatMessages
                  .slice(-4)
                  .map(
                    (chatMessage: CouncilChatMessage) =>
                      `${chatMessage.name}: ${chatMessage.message}`,
                  )
                  .join("\n")
              : "";

            return recentDebate
              ? `${conclusion}\nLaatste debat:\n${recentDebate}`
              : conclusion;
          } catch {
            return `Vorige reactie: ${storedMessage.content}`;
          }
        })
        .join("\n\n")
    : "Nog geen eerdere gesprekscontext.";

  const profile = body.profile ?? {};

  const profileContext = `
Land: ${profile.country || "Niet opgegeven"}
Situatie: ${profile.situation || "Niet opgegeven"}
Doelen: ${profile.goals || "Niet opgegeven"}
Risicoprofiel: ${profile.riskProfile || "Niet opgegeven"}
Tijdshorizon: ${profile.timeHorizon || "Niet opgegeven"}
`.trim();

  database
    .prepare(`
      INSERT INTO messages (
        id,
        session_id,
        role,
        content,
        metadata,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      crypto.randomUUID(),
      finalSessionId,
      "user",
      question,
      null,
      new Date().toISOString(),
    );

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const emit = (type: string, payload: unknown) => {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type,
                payload,
                timestamp: new Date().toISOString(),
              })}\n`,
            ),
          );
        };

        const chatMessages: CouncilChatMessage[] = []

        try {
          emit("session", {
            sessionId: finalSessionId,
            question,
            mode,
          });

          for (const member of selectedCouncillors) {
            emit("member_status", {
              id: member.id,
              phase: "analysis",
              status: "waiting" satisfies ActivityStatus,
            });

            emit("debate_status", {
              id: member.id,
              status: "waiting" satisfies ActivityStatus,
            });
          }

          emit("chairman_status", {
            status: "waiting" satisfies ActivityStatus,
          });

          // RONDE 1: onafhankelijke analyse
          const roundOneAnswers = await Promise.all(
            selectedCouncillors.map(
              async (member): Promise<CouncilAnswer> => {
                emit("member_status", {
                  id: member.id,
                  phase: "analysis",
                  status: "thinking" satisfies ActivityStatus,
                });

                try {
                  const result = await $fetch<OllamaResponse>(
                    "http://localhost:11434/api/generate",
                    {
                      method: "POST",
                      body: {
                        model: member.model,
                        stream: false,
                        format: "json",
                        prompt: `
${member.systemPrompt}

Persoonlijke context:
${profileContext}

Context uit eerdere vragen en besluiten:
${previousContext}

Nieuwe vraag:
${question}

Geef een onafhankelijke analyse vanuit jouw specialisatie.

Regels:
- Geen introductie.
- Maximaal drie kernpunten.
- Maximaal twee voordelen en twee risico's.
- Houd ieder punt kort.
- Verzin geen actuele wetten, belastingen of marktgegevens.
- Behandel de S&P 500 niet automatisch als defensief.
- Antwoord uitsluitend in natuurlijk Nederlands.
- Geef uitsluitend volledige en geldige JSON terug.

Structuur:
{
  "summary": "Jouw kernstandpunt in maximaal twee zinnen",
  "keyPoints": ["Punt 1", "Punt 2"],
  "advantages": ["Voordeel 1"],
  "risks": ["Risico 1"],
  "recommendation": "Concrete aanbeveling",
  "missingInformation": ["Ontbrekend gegeven"],
  "confidence": 75
}
`,
                        options: {
                          ...member.options,
                          num_predict: mode === "deep" ? 1400 : 950,
                        },
                      },
                    },
                  );

                  const advice = normalizeAdvice(
                    parseJsonResponse<StructuredAdvice>(result.response),
                  );

                  emit("member_status", {
                    id: member.id,
                    phase: "analysis",
                    status: "typing" satisfies ActivityStatus,
                  });

                  await delay(400);

                  const openingMessage: CouncilChatMessage = {
                    id: crypto.randomUUID(),
                    councillorId: member.id,
                    name: member.name,
                    emoji: member.emoji,
                    role: member.role,
                    round: 1,
                    kind: "opening",
                    replyTo: [],
                    message: advice.summary,
                    recommendation: advice.recommendation,
                    confidence: advice.confidence,
                    createdAt: new Date().toISOString(),
                  };

                  emit("member_status", {
                    id: member.id,
                    phase: "analysis",
                    status: "speaking" satisfies ActivityStatus,
                  });

                  emit("chat_message", openingMessage);
                  chatMessages.push(openingMessage);

                  await delay(650);

                  emit("member_result", {
                    id: member.id,
                    name: member.name,
                    role: member.role,
                    description: member.description,
                    emoji: member.emoji,
                    success: true,
                    advice,
                  });

                  emit("member_status", {
                    id: member.id,
                    phase: "analysis",
                    status: "done" satisfies ActivityStatus,
                  });

                  return {
                    id: member.id,
                    name: member.name,
                    role: member.role,
                    description: member.description,
                    emoji: member.emoji,
                    success: true,
                    advice,
                  };
                } catch (error) {
                  emit("member_status", {
                    id: member.id,
                    phase: "analysis",
                    status: "error" satisfies ActivityStatus,
                  });

                  emit("member_error", {
                    id: member.id,
                    phase: "analysis",
                    message:
                      error instanceof Error
                        ? error.message
                        : "Onbekende fout.",
                  });

                  return {
                    id: member.id,
                    name: member.name,
                    role: member.role,
                    description: member.description,
                    emoji: member.emoji,
                    success: false,
                    advice: null,
                    error:
                      error instanceof Error
                        ? error.message
                        : "Onbekende fout.",
                  };
                }
              },
            ),
          );

          const successfulRoundOne = roundOneAnswers.filter(
            (answer) => answer.success && answer.advice,
          );

          emit("debate_started", {
            participants: successfulRoundOne.map((answer) => answer.id),
          });

          // RONDE 2: elk raadslid reageert op de anderen
          for (const member of selectedCouncillors) {
            const ownAnswer = successfulRoundOne.find(
              (answer) => answer.id === member.id,
            );

            if (!ownAnswer?.advice) {
              continue;
            }

            const otherPositions = successfulRoundOne
              .filter((answer) => answer.id !== member.id)
              .map((answer) => ({
                id: answer.id,
                name: answer.name,
                summary: answer.advice?.summary,
                recommendation: answer.advice?.recommendation,
                risks: answer.advice?.risks,
                confidence: answer.advice?.confidence,
              }));

            emit("debate_status", {
              id: member.id,
              status: "reading" satisfies ActivityStatus,
              targets: otherPositions.map((position) => position.id),
            });

            await delay(500);

            emit("debate_status", {
              id: member.id,
              status: "thinking" satisfies ActivityStatus,
            });

            try {
              const result = await $fetch<OllamaResponse>(
                "http://localhost:11434/api/generate",
                {
                  method: "POST",
                  body: {
                    model: member.model,
                    stream: false,
                    format: "json",
                    prompt: `
Je bent ${member.name}, ${member.role}.

Vraag:
${question}

Jouw eerste standpunt:
${JSON.stringify(
  {
    summary: ownAnswer.advice.summary,
    recommendation: ownAnswer.advice.recommendation,
    risks: ownAnswer.advice.risks,
    confidence: ownAnswer.advice.confidence,
  },
  null,
  2,
)}

Andere standpunten:
${JSON.stringify(otherPositions, null, 2)}

Reageer rechtstreeks op de andere raadsleden alsof jullie samen in een gesprek zitten.

Regels:
- Noem minstens één ander raadslid bij naam.
- Zeg duidelijk waar je akkoord of niet akkoord bent.
- Reageer op een concreet argument.
- Pas je aanbeveling aan wanneer een argument overtuigt.
- Maximaal 150 woorden.
- Antwoord uitsluitend in natuurlijk Nederlands.
- Geef uitsluitend volledige en geldige JSON terug.

Structuur:
{
  "message": "Jouw directe reactie aan de andere raadsleden",
  "revisedRecommendation": "Aangepaste of behouden aanbeveling",
  "confidence": 75
}
`,
                    options: {
                      ...member.options,
                      temperature: Math.min(
                        0.65,
                        (member.options?.temperature ?? 0.35) + 0.1,
                      ),
                      num_predict: mode === "deep" ? 900 : 650,
                    },
                  },
                },
              );

              emit("debate_status", {
                id: member.id,
                status: "typing" satisfies ActivityStatus,
              });

              await delay(450);

              const parsed = parseJsonResponse<DebateReply>(result.response);

              const replyMessage: CouncilChatMessage = {
                id: crypto.randomUUID(),
                councillorId: member.id,
                name: member.name,
                emoji: member.emoji,
                role: member.role,
                round: 2,
                kind: "reply",
                replyTo: otherPositions.map((position) => position.id),
                message:
                  parsed.message?.trim() || "Geen inhoudelijke reactie.",
                recommendation:
                  parsed.revisedRecommendation?.trim() ||
                  ownAnswer.advice.recommendation,
                confidence: clampConfidence(parsed.confidence),
                createdAt: new Date().toISOString(),
              };

              emit("debate_status", {
                id: member.id,
                status: "speaking" satisfies ActivityStatus,
              });

              emit("chat_message", replyMessage);
              chatMessages.push(replyMessage);

              await delay(750);

              emit("debate_status", {
                id: member.id,
                status: "done" satisfies ActivityStatus,
              });
            } catch (error) {
              // Belangrijk: analyse blijft geslaagd; alleen debatreactie faalt.
              emit("debate_status", {
                id: member.id,
                status: "error" satisfies ActivityStatus,
              });

              emit("member_error", {
                id: member.id,
                phase: "debate",
                message:
                  error instanceof Error
                    ? error.message
                    : "Debatreactie mislukt.",
              });
            }
          }

          let conclusion: ChairmanConclusion | null = null;

          if (successfulRoundOne.length) {
            emit("chairman_status", {
              status: "reading" satisfies ActivityStatus,
            });

            await delay(600);

            emit("chairman_status", {
              status: "thinking" satisfies ActivityStatus,
            });

            try {
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

Vraag:
${question}

Eerste analyses:
${JSON.stringify(
  successfulRoundOne.map((answer) => ({
    name: answer.name,
    summary: answer.advice?.summary,
    recommendation: answer.advice?.recommendation,
    confidence: answer.advice?.confidence,
  })),
  null,
  2,
)}

Volledige live chat:
${JSON.stringify(chatMessages, null, 2)}

Formuleer één praktisch eindadvies.

Regels:
- Gebruik zowel de eerste standpunten als de reacties.
- Benoem wat door het debat veranderde.
- Maximaal drie overeenkomsten.
- Maximaal drie meningsverschillen.
- Maximaal vier volgende stappen.
- Verzin geen actuele wetten, belastingen of marktgegevens.
- Geef uitsluitend volledige en geldige JSON terug.

Structuur:
{
  "verdict": "Kernbesluit",
  "recommendedAction": "Concrete actie",
  "reasoning": "Korte onderbouwing en wat door het debat veranderde",
  "consensus": ["Overeenstemming"],
  "disagreements": ["Meningsverschil"],
  "nextSteps": ["Volgende stap"],
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
                      num_predict: mode === "deep" ? 1250 : 900,
                    },
                  },
                },
              );

              conclusion = normalizeConclusion(
                parseJsonResponse<ChairmanConclusion>(
                  chairmanResult.response,
                ),
              );

              emit("chairman_status", {
                status: "typing" satisfies ActivityStatus,
              });

              await delay(450);

              const chairmanMessage: CouncilChatMessage = {
                id: crypto.randomUUID(),
                councillorId: "chairman",
                name: "Voorzitter",
                emoji: "◇",
                role: "Voorzitter",
                round: 3,
                kind: "chairman",
                replyTo: selectedCouncillors.map((member) => member.id),
                message: conclusion.verdict,
                recommendation: conclusion.recommendedAction,
                confidence: conclusion.confidence,
                createdAt: new Date().toISOString(),
              };

              emit("chairman_status", {
                status: "speaking" satisfies ActivityStatus,
              });

              emit("chat_message", chairmanMessage);
              chatMessages.push(chairmanMessage);

              emit("chairman_result", conclusion);

              await delay(800);

              emit("chairman_status", {
                status: "done" satisfies ActivityStatus,
              });
            } catch (error) {
              emit("chairman_status", {
                status: "error" satisfies ActivityStatus,
              });

              emit("chairman_error", {
                message:
                  error instanceof Error
                    ? error.message
                    : "Voorzitter kon geen besluit maken.",
              });
            }
          }

          const councilResponse = {
            id: crypto.randomUUID(),
            sessionId: finalSessionId,
            createdAt: new Date().toISOString(),
            question,
            mode,
            totalCouncillors: roundOneAnswers.length,
            successfulAnswers: successfulRoundOne.length,
            answers: roundOneAnswers,
            chatMessages,
            conclusion,
          };

          database
            .prepare(`
              INSERT INTO messages (
                id,
                session_id,
                role,
                content,
                metadata,
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `)
            .run(
              councilResponse.id,
              finalSessionId,
              "council",
              conclusion?.verdict || "De raad heeft geantwoord.",
              JSON.stringify(councilResponse),
              councilResponse.createdAt,
            );

          database
            .prepare(`
              UPDATE sessions
              SET
                mode = ?,
                updated_at = ?
              WHERE id = ?
            `)
            .run(mode, councilResponse.createdAt, finalSessionId);

          emit("complete", councilResponse);
        } catch (error) {
          emit("fatal_error", {
            message:
              error instanceof Error ? error.message : "Onbekende fout.",
          });
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    },
  );
});
