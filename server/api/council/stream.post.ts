import { councilModel } from "#shared/council";
import { liveCouncils } from "../../utils/live-council";
import { councillors, guestCouncillor } from "../../data/councillors";
import {
  generateCouncilReply,
  listOllamaModels,
} from "../../utils/council-ollama";
import database from "../../utils/database";
import { loadUserContext, storeUserContext, validateUserContext } from "../../utils/council-context";

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
  agentModels?: Record<string,string>;
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
      throw new Error("The model returned invalid JSON.");
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

function normalizeConclusion(value: ChairmanConclusion): ChairmanConclusion {
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
      statusMessage: "Enter a question of at most 4,000 characters.",
    });
  }

  const mode: CouncilMode = body.mode === "quick" ? "quick" : "deep";

  const requestedIds = body.selectedCouncillorIds?.length
    ? body.selectedCouncillorIds
    : councillors.map(({ id }) => id);
  const selectedCouncillors = councillors.filter(({ id }) =>
    requestedIds.includes(id),
  );

  // Only permit models actually installed on the local Ollama server.
  const requestedAgentModels = body.agentModels ?? {};
  if (Object.values(requestedAgentModels).some(value => typeof value !== "string")) {
    throw createError({statusCode:400,message:"Invalid agent model selection."});
  }
  const overrides = selectedCouncillors.filter(member => requestedAgentModels[member.id]);
  if (overrides.length) {
    const installed = await listOllamaModels().catch(() => {
      throw createError({statusCode:503,message:"Ollama is unavailable."});
    });
    for (const member of selectedCouncillors) {
      const chosen = requestedAgentModels[member.id];
      if (chosen) {
        if (!installed.includes(chosen)) throw createError({statusCode:400,message:"Selected model is not installed: "+chosen});
        member.model = chosen;
      }
    }
  }

  if (requestedIds.includes("guest")) {
    const model = body.guestModel;
    const installedModels = await listOllamaModels().catch(() => {
      throw createError({ statusCode: 503, message: "Ollama is unavailable." });
    });
    if (!model || !installedModels.includes(model) || false) {
      throw createError({
        statusCode: 400,
        message: "Choose an installed model for the guest.",
      });
    }
    selectedCouncillors.push(guestCouncillor(model));
  }

  // Keep at most one model loaded for this council when alternating between models.
  const keepAlive = 300;

  if (!selectedCouncillors.length) {
    throw createError({
      statusCode: 400,
      statusMessage: "Select at least one councillor.",
    });
  }

  let sessionId = body.sessionId?.trim();

  if (sessionId) {
    const existingSession = database
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .get(sessionId);

    if (liveCouncils.has(sessionId)) {
      throw createError({
        statusCode: 409,
        message: "This council is still in session.",
      });
    }

    if (!existingSession) {
      throw createError({
        statusCode: 404,
        statusMessage: "Session not found.",
      });
    }
  } else {
    sessionId = crypto.randomUUID();

    const now = new Date().toISOString();
    const title =
      question.length > 60 ? `${question.slice(0, 57)}...` : question;

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
      .run(sessionId, title, mode, now, now);
  }

  const finalSessionId = sessionId;

  const previousMessages = database
    .prepare(
      `
      SELECT
        role,
        content,
        metadata
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `,
    )
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
                  .filter(
                    (
                      entry: CouncilChatMessage,
                      index: number,
                      entries: CouncilChatMessage[],
                    ) => entry.kind === "user" || index >= entries.length - 4,
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

  // A new user message reopens deliberation with the previous questions as context.
  if (body.sessionId && question) {
    database
      .prepare(
        "UPDATE council_open_questions SET status = 'addressed' WHERE session_id = ? AND status = 'open'",
      )
      .run(finalSessionId);
  }
  // Retrieve user-authored history, not the truncated mixture of agent/user messages.
  // Keep the latest 30 messages to bound local inference time and context length.
  const userHistory = database.prepare(`
    SELECT content FROM messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY created_at DESC, rowid DESC LIMIT 30
  `).all(finalSessionId) as { content: string }[];
  const userStatements = userHistory.reverse().map(row => row.content);
  // The current question is already saved to messages above.
  if (userStatements.at(-1) !== question) userStatements.push(question);
  const priorUserContext = loadUserContext(finalSessionId);
  const userFactsPrompt = `You are a LOCAL conversation fact tracker. Read only the user's statements.
Extract explicit, verifiable user constraints. NEVER use agent guesses.
Return valid JSON:
{"facts":[{"key":"stable topic-specific key (e.g. car.budget.total)","value":"confirmed value including units","evidence":"exact contiguous quote copied from user message","messageIndex":0}],"corrections":["what the user corrected"],"unknowns":["important missing facts"]}.
Indices are zero-based into the supplied user messages. Each fact MUST include an exact quote from its indexed message.
Use the same key when the user changes a constraint so the newest statement wins.
Do not mistake hypothetical examples for the user's preferences. Do not infer facts.
Previous validated facts for continuity (only retain if still supported): ${JSON.stringify(priorUserContext?.facts ?? [])}
User messages, oldest to newest: ${JSON.stringify(userStatements)}`;
  let confirmedUserContext = JSON.stringify({
    verifiedFacts: priorUserContext?.facts ?? [],
    userStatements,
    latestUserMessage: question,
    instruction: "Newer user statements override earlier assumptions; never treat agent examples as user facts.",
  });
  try {
    const rawContext = await generateCouncilReply(
      {
        model: councilModel,
        prompt: userFactsPrompt,
        options: { temperature: 0, num_ctx: 8192, num_predict: 900 },
        keep_alive: keepAlive,
      },
      request.signal,
      () => {},
    );
    const extracted = parseJsonResponse<unknown>(rawContext);
    const verified = validateUserContext(extracted, userStatements);
    verified.deletedKeys = priorUserContext?.deletedKeys ?? [];
    verified.facts = verified.facts.filter((fact) => !verified.deletedKeys?.includes(fact.key));
    for (const fact of priorUserContext?.facts ?? []) {
      if (fact.evidence === "[Manually corrected by user]" && !verified.deletedKeys.includes(fact.key)) {
        verified.facts = verified.facts.filter((item) => item.key !== fact.key);
        verified.facts.push(fact);
      }
    }
    storeUserContext(finalSessionId, verified);
    confirmedUserContext = JSON.stringify({
      ...verified,
      instruction: "Only facts with exact user evidence are confirmed. Correct previous arguments immediately when contradicted.",
    });
  } catch {
    // If Ollama cannot extract facts, use the raw user messages and previous verified memory.
    // Never silently turn an agent assumption into a user fact.
  }

  const agentMemories = Object.fromEntries(
    selectedCouncillors.map((member) => {
      const memories = database
        .prepare(
          "SELECT memory FROM agent_memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5",
        )
        .all(member.id) as { memory: string }[];
      return [member.id, memories.map((row) => row.memory).join("\n")];
    }),
  );
  const unresolved = database
    .prepare(
      "SELECT question FROM council_open_questions WHERE session_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 8",
    )
    .all(finalSessionId) as { question: string }[];

  const questionId = crypto.randomUUID();
  const questionCreatedAt = new Date().toISOString();

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
    .run(questionId, finalSessionId, "user", question, null, questionCreatedAt);

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
              const result = await generateCouncilReply(
                {
                  model: member.model,
                  prompt: `
${member.systemPrompt}

AUTHORITATIVE USER FACTS (override all older debate assumptions):\n${confirmedUserContext}\n\nSouvenirs personnels de cet agent: ${agentMemories[member.id] || "None"}
Questions encore ouvertes: ${JSON.stringify(unresolved)}

Personal context:
${profileContext}

Context uit eerdere vragen en besluiten:
${previousContext}

Nieuwe vraag:
${question}

User contributions during this round:
${JSON.stringify(chatMessages.filter((entry) => entry.kind === "user").map((entry) => entry.message))}

Never treat assumptions from earlier agents as facts. If the user corrects a price, requirement or preference, discard conflicting old reasoning.\nGive an independent position from your specialist perspective. Connect it to one concrete use case from the question.
Benoem de actor, wat die probeert te doen en waar de keuze in die situatie verschil maakt.
If information is missing, state an explicit working assumption and explain what changes if it is wrong.

Regels:
- Geen introductie.
- Maximaal drie kernpunten.
- Maximaal twee voordelen en twee risico's.
- Houd ieder punt kort.
- Verzin geen actuele wetten, belastingen of marktgegevens.
- Respond in the user's language, whether English, French, Dutch or another supported language.
- Return only complete, valid JSON.

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
                },
                request.signal,
                () =>
                  emit("member_status", {
                    id: member.id,
                    phase: "analysis",
                    status: "typing",
                  }),
              );

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
                  error instanceof Error ? error.message : "Onbekende fout.",
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
                  error instanceof Error ? error.message : "Onbekende fout.",
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
          const maxReplies =
            participants.length === 1 ? 4 : mode === "deep" ? 20 : 10;
          const debateFocus = [
            "Explore a concrete use case: who does what, under which constraints, and what happens step by step? Test a claim against it.",
            "Test a previously discussed use case under changed conditions. Describe the expected outcome and why another approach might do better or worse.",
            "Revisit an objection or condition raised in the debate. Explain what outcome, evidence or edge case would change your mind.",
          ];
          let speaker: (typeof participants)[number] | undefined =
            participants.find((member) => member.id === "solon") ??
            participants[0];
          const speakCounts = new Map(
            participants.map((member) => [member.id, 0]),
          );
          let pendingQuestion = "";
          let replyTarget: CouncilChatMessage | undefined;
          let lastSeenUserMessageId: string | undefined;

          // Agents request the floor in response to new events. The shared model
          // evaluates all candidates in one inexpensive structured call per turn.
          // This is not simultaneous inference: it is event-driven arbitration.
          async function chooseNextSpeaker(turn: number) {
            const firstParticipant = participants[0];
            if (!firstParticipant) return undefined;
            if (participants.length === 1) return firstParticipant;
            const latest = chatMessages.slice(-5).map((entry) => ({
              id: entry.councillorId,
              name: entry.name,
              message: entry.message.slice(0, 750),
              question: entry.followUpQuestion,
              addressedTo: entry.replyTo[0],
            }));
            for (const candidate of participants) {
              emit("debate_status", { id: candidate.id, status: "reading" });
            }
            try {
              const raw = await generateCouncilReply(
                {
                  model: firstParticipant.model,
                  prompt: `You are a neutral debate floor manager, not a debater.
Question: ${question}\nAuthoritative user facts: ${confirmedUserContext}\nRecent events: ${JSON.stringify(latest)}
Candidates: ${JSON.stringify(
                    participants.map((candidate) => ({
                      id: candidate.id,
                      name: candidate.name,
                      role: candidate.role,
                      interventions: speakCounts.get(candidate.id) ?? 0,
                    })),
                  )}
Pick the participant with the strongest REASON to respond next. An explicit
question or objection to a participant matters, but anyone can interrupt
with a more important challenge. The same participant MAY speak again.
Do not mechanically rotate or favour the least-heard participant.
Return only JSON:
{"speakerId":"one candidate ID","reason":"specific argument to address","urgency":1}
`,
                  options: {
                    temperature: 0.25,
                    num_ctx: 4096,
                    num_predict: 150,
                  },
                  keep_alive: keepAlive,
                },
                request.signal,
                () => {},
              );
              const decision = parseJsonResponse<{
                speakerId: string;
                reason: string;
                urgency: number;
              }>(raw);
              const selected = participants.find(
                (candidate) => candidate.id === decision.speakerId,
              );
              if (selected) return selected;
            } catch {
              // Fall back to direct reply targeting if arbitration fails.
            }
            const addressedId = chatMessages.at(-1)?.replyTo[0];
            return (
              participants.find((candidate) => candidate.id === addressedId) ??
              participants.find(
                (candidate) =>
                  candidate.id !== chatMessages.at(-1)?.councillorId,
              ) ??
              participants[0]
            );
          }

          for (let turn = 0; speaker && turn < maxReplies; turn++) {
            if (cancelled) return;
            speaker = await chooseNextSpeaker(turn);
            if (!speaker) break;
            const member: (typeof participants)[number] = speaker;
            speakCounts.set(member.id, (speakCounts.get(member.id) ?? 0) + 1);
            const others = participants.filter(
              (participant) => participant.id !== member.id,
            );
            emit("debate_status", { id: member.id, status: "reading" });
            await delay(400);
            if (cancelled) return;
            emit("debate_status", { id: member.id, status: "thinking" });

            const focus =
              debateFocus[Math.floor((turn * debateFocus.length) / maxReplies)];
            const transcript = chatMessages.map((entry, index) => ({
              speaker: entry.name,
              position: entry.position,
              message:
                entry.kind === "reply" && index < chatMessages.length - 6
                  ? entry.message.slice(0, 450)
                  : entry.message,
              question: entry.followUpQuestion,
              recommendation: entry.recommendation,
            }));
            const latestUser = chatMessages.findLast(
              (entry) => entry.kind === "user",
            );
            const newUserMessage =
              latestUser?.id !== lastSeenUserMessageId ? latestUser : undefined;
            lastSeenUserMessageId = latestUser?.id;

            let addresseeId: string | undefined;
            try {
              const result = await generateCouncilReply(
                {
                  model: member.model,
                  prompt: `
${member.systemPrompt}

Question: ${question}\nAuthoritative user facts (override previous context and agent assumptions): ${confirmedUserContext}\nPrevious context: ${previousContext.slice(-4000)}\nMemories: ${agentMemories[member.id] || "None"}\nOpen questions: ${JSON.stringify(unresolved)}
Andere deelnemers: ${JSON.stringify(others.map(({ id, name }) => ({ id, name })))}

Gesprek tot nu toe:
${JSON.stringify(transcript)}

${
  replyTarget
    ? `Respond directly to this message from ${replyTarget.name}: ${JSON.stringify(replyTarget.message)}
${replyTarget.followUpQuestion ? `First explicitly answer this open question: ${JSON.stringify(replyTarget.followUpQuestion)}` : "Address the specific objection before je verdergaat."}`
    : "Choose a specific, insufficiently supported argument and address its author by name."
}
${newUserMessage ? `Also incorporate this new contribution from the user: ${JSON.stringify(newUserMessage.message)}` : ""}

Focus for this contribution: ${focus}

Before replying, check the authoritative user facts. Explicit corrections invalidate earlier assumptions; never present a hypothetical scenario as a user statement. If new user constraints invalidate earlier recommendations, revise them.\nWrite a natural reply to the person concerned. Refer to a specific statement.
Use a concrete example with consequences or make the differences between two approaches tangible.
Use numbers only if supplied by the user or explicitly marked as hypothetical examples.
Avoid vague terms such as scalability, friction or complexity without explaining what actually changes.
Leg uit wat je behoudt of herziet en waarom. Herhaal geen al afgehandeld argument.
${
  turn < maxReplies - 1
    ? "Optionally ask one precise follow-up question about a decision, assumption or edge case. Put the question only in followUpQuestion and the intended respondent's ID in addressedTo."
    : "Dit is de laatste repliek. Werk het open punt af en laat followUpQuestion leeg."
}
If essential personal information is missing, address a precise question to "user". You may introduce a relevant subtopic or challenge another participant without waiting for a fixed turn. Never invent facts. Reply in the user's language.
Use "user" when asking the user a question. With only one councillor, critically examine your own reasoning and develop a counterexample.
Develop your reasoning over two or three short paragraphs when helpful. Return only valid JSON.

{
  "addressedTo": "ID of the intended respondent, or user",
  "position": "defend, revise, clarify of challenge",
  "message": "Direct, detailed response with a concrete example",
  "followUpQuestion": "One precise follow-up question, or empty",
  "revisedRecommendation": "Nieuwe aanbeveling, of leeg als die hetzelfde blijft",
  "confidence": 75
}
`,
                  options: {
                    ...member.options,
                    temperature: 0.5,
                    num_predict: mode === "deep" ? 1400 : 950,
                  },
                  keep_alive: keepAlive,
                },
                request.signal,
                () =>
                  emit("debate_status", { id: member.id, status: "typing" }),
              );

              const parsed = parseJsonResponse<DebateReply>(result);
              const message = parsed.message?.trim();
              if (!message)
                throw new Error(
                  "The councillor returned no substantive reply.",
                );
              const addressedMember = others.find(
                (other) => other.id === parsed.addressedTo,
              );
              addresseeId = addressedMember?.id;
              const addressedTo =
                addresseeId ??
                (parsed.addressedTo === "user" ? "user" : undefined);
              const position = [
                "defend",
                "revise",
                "clarify",
                "challenge",
              ].includes(parsed.position)
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
                followUpQuestion:
                  turn < maxReplies - 1 &&
                  addressedTo &&
                  typeof parsed.followUpQuestion === "string"
                    ? parsed.followUpQuestion.trim() || undefined
                    : undefined,
                position,
                recommendation:
                  position === "revise"
                    ? parsed.revisedRecommendation?.trim()
                    : undefined,
                confidence: clampConfidence(parsed.confidence),
                createdAt: new Date().toISOString(),
              };
              chatMessages.push(reply);
              emit("chat_message", reply);
              if (addressedTo === "user" && reply.followUpQuestion)
                pendingQuestion = reply.followUpQuestion;
              emit("debate_status", { id: member.id, status: "done" });
              replyTarget = reply;
            } catch (error) {
              emit("debate_status", { id: member.id, status: "error" });
              emit("member_error", {
                id: member.id,
                phase: "debate",
                message:
                  error instanceof Error
                    ? error.message
                    : "Debatreactie mislukt.",
              });
              replyTarget = undefined;
            }

            // The next speaker will be selected by fresh agent bids.
            speaker = participants[0];
            replyTarget = chatMessages.at(-1);
            // Pause at a meaningful question rather than manufacturing a conclusion.
            if (pendingQuestion && turn >= Math.min(5, maxReplies - 1)) break;
          }

          if (cancelled) return;
          acceptingInterjections = false;
          emit("interjections_closed", {});
          if (!successfulRoundOne.length) {
            throw new Error(
              "Geen raadslid kon antwoorden. Controleer of Ollama draait en het model beschikbaar is.",
            );
          }

          for (const member of participants) {
            const contributions = chatMessages.filter(
              (entry) => entry.councillorId === member.id,
            );
            if (!contributions.length) continue;
            const memory = contributions
              .slice(-3)
              .map((entry) => entry.message.slice(0, 500))
              .join(" | ");
            database
              .prepare(
                "INSERT INTO agent_memories (id, agent_id, session_id, memory, created_at) VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                crypto.randomUUID(),
                member.id,
                finalSessionId,
                memory,
                new Date().toISOString(),
              );
          }
          if (pendingQuestion) {
            database
              .prepare(
                "INSERT INTO council_open_questions (id, session_id, question, status, created_at) VALUES (?, ?, ?, 'open', ?)",
              )
              .run(
                crypto.randomUUID(),
                finalSessionId,
                pendingQuestion,
                new Date().toISOString(),
              );
          }
          let conclusion: ChairmanConclusion | null = null;

          const chairmanModel =
            participants.find(({ model }) => model === councilModel) ??
            participants[0];
          if (chairmanModel && !pendingQuestion) {
            emit("chairman_status", {
              status: "reading" satisfies ActivityStatus,
            });

            await delay(600);

            emit("chairman_status", {
              status: "thinking" satisfies ActivityStatus,
            });

            try {
              const chairmanResult = await generateCouncilReply(
                {
                  model: chairmanModel.model,
                  prompt: `
You are the facilitator of a personal AI Council.

Previous conversation context:
${previousContext}

Question:\n${question}\n\nAuthoritative user facts (override outdated agent assumptions):\n${confirmedUserContext}\n\nEerste analyses:
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
${JSON.stringify(
  chatMessages.map((entry) => ({
    speaker: entry.name,
    message: entry.message,
    recommendation: entry.recommendation,
    question: entry.followUpQuestion,
  })),
)}

Use authoritative user facts over all conflicting debate claims. Reject recommendations violating confirmed constraints.\nFormulate one practical final recommendation.

Regels:
- Use initial positions, debate replies and relevant contributions from the user.
- Identify who changed their position and which argument persuaded them. Describe any unanswered objections.
- Leg uit welke aanpak past in de uitgewerkte use cases, wat verandert in het wat-als-scenario en welke voorwaarde het advies doet kantelen.
- Maximaal drie overeenkomsten.
- Maximaal drie meningsverschillen.
- Maximaal vier volgende stappen.
- Verzin geen actuele wetten, belastingen of marktgegevens.
- Return only complete, valid JSON.

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
                },
                request.signal,
                () => emit("chairman_status", { status: "typing" }),
              );

              conclusion = normalizeConclusion(
                parseJsonResponse<ChairmanConclusion>(chairmanResult),
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
            openQuestion: pendingQuestion || null,
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
              finalSessionId,
              "council",
              conclusion?.verdict || "The council has responded.",
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
            .run(mode, councilResponse.createdAt, finalSessionId);

          emit("complete", councilResponse);
        } catch (error) {
          emit("fatal_error", {
            message: error instanceof Error ? error.message : "Onbekende fout.",
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
