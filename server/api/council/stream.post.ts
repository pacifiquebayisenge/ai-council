import { councilModel } from "#shared/council";
import { liveCouncils } from "../../utils/live-council";
import { councillors, guestCouncillor } from "../../data/councillors";
import { generateCouncilReply, listOllamaModels } from "../../utils/council-ollama";
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
  guestModel?: string;
  profile?: UserProfile;
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
  kind: "opening" | "reply" | "chairman" | "user";
  replyTo: string[];
  message: string;
  recommendation?: string;
  followUpQuestion?: string;
  position?: DebateReply["position"];
  confidence?: number;
  createdAt: string;
}

interface DebateReply {
  addressedTo: string;
  position: "defend" | "revise" | "clarify" | "challenge";
  message: string;
  revisedRecommendation: string;
  followUpQuestion?: string;
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
  const question = typeof body?.message === "string" ? body.message.trim() : "";

  if (!question || question.length > 4000) {
    throw createError({
      statusCode: 400,
      statusMessage: "Geef een vraag van maximaal 4000 tekens mee.",
    });
  }

  const mode: CouncilMode = body.mode === "quick" ? "quick" : "deep";

  const requestedIds = body.selectedCouncillorIds?.length
    ? body.selectedCouncillorIds
    : councillors.map(({ id }) => id);
  const selectedCouncillors = councillors.filter(({ id }) => requestedIds.includes(id));

  if (requestedIds.includes("vera")) {
    const model = body.guestModel;
    const installedModels = await listOllamaModels().catch(() => {
      throw createError({ statusCode: 503, message: "Ollama is niet bereikbaar." });
    });
    if (!model || !installedModels.includes(model) || selectedCouncillors.some((member) => member.model === model)) {
      throw createError({ statusCode: 400, message: "Kies voor Vera een geïnstalleerd model dat nog vrij is." });
    }
    selectedCouncillors.push(guestCouncillor(model));
  }

  // Keep at most one model loaded for this council when alternating between models.
  const keepAlive = selectedCouncillors.length > 1 ? 0 : 300;

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

    if (liveCouncils.has(sessionId)) {
      throw createError({ statusCode: 409, message: "Deze raad is nog in overleg." });
    }

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
                  .filter((entry: CouncilChatMessage, index: number, entries: CouncilChatMessage[]) =>
                    entry.kind === "user" || index >= entries.length - 4,
                  )
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

  const questionId = crypto.randomUUID();
  const questionCreatedAt = new Date().toISOString();

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
      questionId,
      finalSessionId,
      "user",
      question,
      null,
      questionCreatedAt,
    );

  const encoder = new TextEncoder();

  let cancelled = false;
  const request = new AbortController();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const emit = (type: string, payload: unknown) => {
          if (cancelled) return;
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

        const chatMessages: CouncilChatMessage[] = [];
        let round = 1;
        let acceptingInterjections = true;
        liveCouncils.set(finalSessionId, (message) => {
          if (!acceptingInterjections || cancelled) return false;
          const entry: CouncilChatMessage = {
            id: crypto.randomUUID(),
            councillorId: "user",
            name: "Jij",
            emoji: "✎",
            role: "",
            round,
            kind: "user",
            replyTo: [],
            message,
            createdAt: new Date().toISOString(),
          };
          chatMessages.push(entry);
          emit("chat_message", entry);
          return true;
        });

        try {
          emit("session", {
            sessionId: finalSessionId,
            question,
            questionId,
            questionCreatedAt,
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
          const roundOneAnswers: CouncilAnswer[] = [];
          for (const member of selectedCouncillors) {
            if (cancelled) return;
            emit("member_status", {
              id: member.id,
              phase: "analysis",
              status: "thinking" satisfies ActivityStatus,
            });

            try {
              const result = await generateCouncilReply({
                model: member.model,
                prompt: `
${member.systemPrompt}

Persoonlijke context:
${profileContext}

Context uit eerdere vragen en besluiten:
${previousContext}

Nieuwe vraag:
${question}

Aanvullingen van de gebruiker tijdens deze ronde:
${JSON.stringify(chatMessages.filter((entry) => entry.kind === "user").map((entry) => entry.message))}

Geef een onafhankelijk standpunt vanuit jouw specialisatie. Koppel het aan één concreet gebruiksgeval uit de vraag.
Benoem de actor, wat die probeert te doen en waar de keuze in die situatie verschil maakt.
Als iets ontbreekt, gebruik een expliciete werkhypothese en leg uit wat verandert als ze niet klopt.

Regels:
- Geen introductie.
- Maximaal drie kernpunten.
- Maximaal twee voordelen en twee risico's.
- Houd ieder punt kort.
- Verzin geen actuele wetten, belastingen of marktgegevens.
- Antwoord uitsluitend in natuurlijk Nederlands.
- Geef uitsluitend volledige en geldige JSON terug.

Structuur:
{
  "summary": "Jouw standpunt en het concrete voorbeeld waarop het steunt",
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
                keep_alive: keepAlive,
              }, request.signal, () => emit("member_status", { id: member.id, phase: "analysis", status: "typing" }));

              const advice = normalizeAdvice(
                parseJsonResponse<StructuredAdvice>(result),
              );

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

              roundOneAnswers.push({
                id: member.id,
                name: member.name,
                role: member.role,
                description: member.description,
                emoji: member.emoji,
                success: true,
                advice,
              });
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

              roundOneAnswers.push({
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
              });
            }
          }

          const successfulRoundOne = roundOneAnswers.filter(
            (answer) => answer.success && answer.advice,
          );

          round = 2;
          emit("debate_started", {
            participants: successfulRoundOne.map((answer) => answer.id),
          });

          const participants = selectedCouncillors.filter((member) =>
            successfulRoundOne.some((answer) => answer.id === member.id),
          );
          const maxReplies = participants.length === 1 ? 3 : mode === "deep" ? 12 : 7;
          const debateFocus = [
            "Maak een concrete use case scherp: wie doet wat, onder welke beperkingen, en wat gebeurt er stap voor stap? Toets een standpunt op die use case.",
            "Test een eerder besproken use case onder een veranderde voorwaarde. Beschrijf het verwachte gevolg en wat de andere aanpak beter of slechter zou doen.",
            "Ga terug naar een bezwaar of voorwaarde uit het debat. Maak concreet welk resultaat, meetpunt of grensgeval je van mening zou doen veranderen.",
          ];
          let speaker: (typeof participants)[number] | undefined = participants.find((member) => member.id === "solon") ?? participants[0];
          let replyTarget: CouncilChatMessage | undefined;
          let lastSeenUserMessageId: string | undefined;

          for (let turn = 0; speaker && turn < maxReplies; turn++) {
            if (cancelled) return;
            const member: (typeof participants)[number] = speaker;
            const others = participants.filter((participant) => participant.id !== member.id);
            emit("debate_status", { id: member.id, status: "reading" });
            await delay(400);
            if (cancelled) return;
            emit("debate_status", { id: member.id, status: "thinking" });

            const focus = debateFocus[Math.floor(turn * debateFocus.length / maxReplies)];
            const transcript = chatMessages.map((entry, index) => ({
              speaker: entry.name,
              position: entry.position,
              message: entry.kind === "reply" && index < chatMessages.length - 6
                ? entry.message.slice(0, 450)
                : entry.message,
              question: entry.followUpQuestion,
              recommendation: entry.recommendation,
            }));
            const latestUser = chatMessages.findLast((entry) => entry.kind === "user");
            const newUserMessage = latestUser?.id !== lastSeenUserMessageId ? latestUser : undefined;
            lastSeenUserMessageId = latestUser?.id;

            let addresseeId: string | undefined;
            try {
              const result = await generateCouncilReply({
                model: member.model,
                prompt: `
${member.systemPrompt}

Vraag: ${question}
Eerdere context: ${previousContext.slice(-4000)}
Andere deelnemers: ${JSON.stringify(others.map(({ id, name }) => ({ id, name })))}

Gesprek tot nu toe:
${JSON.stringify(transcript)}

${replyTarget
  ? `Reageer rechtstreeks op dit bericht van ${replyTarget.name}: ${JSON.stringify(replyTarget.message)}
${replyTarget.followUpQuestion ? `Beantwoord deze open vraag eerst expliciet: ${JSON.stringify(replyTarget.followUpQuestion)}` : "Beantwoord het concrete bezwaar voordat je verdergaat."}`
  : "Kies een concreet argument dat nog onvoldoende is onderbouwd en spreek de auteur bij naam aan."}
${newUserMessage ? `Betrek ook deze nieuwe bijdrage van de gebruiker in je reactie: ${JSON.stringify(newUserMessage.message)}` : ""}

Focus voor deze bijdrage: ${focus}

Schrijf een natuurlijke repliek aan de betrokken persoon. Grijp terug op een specifieke uitspraak.
Gebruik een concreet voorbeeld met gevolgen of maak het verschil tussen twee aanpakken tastbaar.
Gebruik cijfers alleen als de gebruiker die gaf of als je duidelijk zegt dat het voorbeeldwaarden zijn.
Vermijd algemene termen zoals schaalbaarheid, frictie of complexiteit zonder te beschrijven wat er concreet verandert.
Leg uit wat je behoudt of herziet en waarom. Herhaal geen al afgehandeld argument.
${turn < maxReplies - 1
  ? "Stel eventueel één gerichte vervolgvraag over een beslissing, aanname of grensgeval. Zet de vraag alleen in followUpQuestion en zet het ID van degene die moet antwoorden in addressedTo."
  : "Dit is de laatste repliek. Werk het open punt af en laat followUpQuestion leeg."}
Gebruik "user" voor een vraag aan de gebruiker. Bij één raadslid: toets je eigen eerdere redenering en werk het tegenvoorbeeld uit.
Werk je redenering uit in twee of drie korte alinea's als dat helpt. Geef alleen geldige JSON terug.

{
  "addressedTo": "ID van degene die moet antwoorden, of user",
  "position": "defend, revise, clarify of challenge",
  "message": "Directe, uitgewerkte reactie met het concrete voorbeeld",
  "followUpQuestion": "Eén gerichte vervolgvraag, of leeg",
  "revisedRecommendation": "Nieuwe aanbeveling, of leeg als die hetzelfde blijft",
  "confidence": 75
}
`,
                options: { ...member.options, temperature: 0.5, num_predict: mode === "deep" ? 1400 : 950 },
                keep_alive: keepAlive,
              }, request.signal, () => emit("debate_status", { id: member.id, status: "typing" }));

              const parsed = parseJsonResponse<DebateReply>(result);
              const message = parsed.message?.trim();
              if (!message) throw new Error("Het raadslid gaf geen inhoudelijke reactie.");
              const addressedMember = others.find((other) => other.id === parsed.addressedTo);
              addresseeId = addressedMember?.id;
              const addressedTo = addresseeId ?? (parsed.addressedTo === "user" ? "user" : undefined);
              const position = ["defend", "revise", "clarify", "challenge"].includes(parsed.position)
                ? parsed.position
                : undefined;

              const reply: CouncilChatMessage = {
                id: crypto.randomUUID(),
                councillorId: member.id,
                name: member.name,
                emoji: member.emoji,
                role: member.role,
                round: 2,
                kind: "reply",
                replyTo: addressedTo ? [addressedTo] : [],
                message,
                followUpQuestion: turn < maxReplies - 1 && addressedTo && typeof parsed.followUpQuestion === "string"
                  ? parsed.followUpQuestion.trim() || undefined
                  : undefined,
                position,
                recommendation: position === "revise" ? parsed.revisedRecommendation?.trim() : undefined,
                confidence: clampConfidence(parsed.confidence),
                createdAt: new Date().toISOString(),
              };
              chatMessages.push(reply);
              emit("chat_message", reply);
              emit("debate_status", { id: member.id, status: "done" });
              replyTarget = reply;
            } catch (error) {
              emit("debate_status", { id: member.id, status: "error" });
              emit("member_error", {
                id: member.id,
                phase: "debate",
                message: error instanceof Error ? error.message : "Debatreactie mislukt.",
              });
              replyTarget = undefined;
            }

            const recentSpeakers = chatMessages
              .filter((entry) => entry.kind === "reply")
              .slice(-3)
              .map((entry) => entry.councillorId);
            const sidelined = recentSpeakers.length === 3
              ? others.find((other) => !recentSpeakers.includes(other.id))
              : undefined;
            const nextSpeaker: (typeof participants)[number] | undefined =
              others.find((other) => other.id === addresseeId) ?? sidelined ?? others[0] ?? (participants.length === 1 ? member : undefined);
            // Only the addressed speaker gets the explicit reply prompt.
            if (replyTarget && addresseeId !== nextSpeaker?.id) replyTarget = undefined;
            speaker = nextSpeaker;
          }

          if (cancelled) return;
          acceptingInterjections = false;
          emit("interjections_closed", {});
          if (!successfulRoundOne.length) {
            throw new Error("Geen raadslid kon antwoorden. Controleer of Ollama draait en het model beschikbaar is.");
          }

          let conclusion: ChairmanConclusion | null = null;

          const chairmanModel = participants.find(({ model }) => model === councilModel) ?? participants[0];
          if (chairmanModel) {
            emit("chairman_status", {
              status: "reading" satisfies ActivityStatus,
            });

            await delay(600);

            emit("chairman_status", {
              status: "thinking" satisfies ActivityStatus,
            });

            try {
              const chairmanResult = await generateCouncilReply({
                model: chairmanModel.model,
                prompt: `
Je bent de voorzitter van een persoonlijke AI Council.

Eerdere gesprekscontext:
${previousContext}

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
${JSON.stringify(chatMessages.map((entry) => ({
  speaker: entry.name,
  message: entry.message,
  recommendation: entry.recommendation,
  question: entry.followUpQuestion,
})))}

Formuleer één praktisch eindadvies.

Regels:
- Gebruik de eerste standpunten, de reacties en de relevante bijdragen van de gebruiker.
- Benoem concreet wie door welk argument van standpunt veranderde. Beschrijf ook welke bezwaren onbeantwoord bleven.
- Leg uit welke aanpak past in de uitgewerkte use cases, wat verandert in het wat-als-scenario en welke voorwaarde het advies doet kantelen.
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
                  num_predict: mode === "deep" ? 1550 : 1100,
                },
                keep_alive: keepAlive,
              }, request.signal, () => emit("chairman_status", { status: "typing" }));

              conclusion = normalizeConclusion(
                parseJsonResponse<ChairmanConclusion>(
                  chairmanResult,
                ),
              );

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

          if (cancelled) return;
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
          liveCouncils.delete(finalSessionId);
          if (!cancelled) controller.close();
        }
      },
      cancel() {
        cancelled = true;
        request.abort();
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
