<script setup lang="ts">
import { councilMembers, councilModel } from "#shared/council";

type ActivityStatus =
  | "waiting"
  | "reading"
  | "thinking"
  | "typing"
  | "speaking"
  | "done"
  | "error";

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
  confidence?: number;
  createdAt: string;
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

interface StreamEvent {
  type: string;
  payload: any;
  timestamp: string;
}

interface UserProfile {
  country: string;
  situation: string;
  goals: string;
  riskProfile: string;
  timeHorizon: string;
}

interface CouncilMember {
  id: string;
  name: string;
  emoji: string;
  role: string;
  analysisStatus: ActivityStatus;
  debateStatus: ActivityStatus;
  answer: CouncilAnswer | null;
}

const members = ref<CouncilMember[]>(councilMembers.map((member) => ({
  ...member,
  analysisStatus: "waiting",
  debateStatus: "waiting",
  answer: null,
})));

const message = ref("");
const mode = ref<"quick" | "deep">("quick");
const selectedCouncillorIds = ref(members.value.map((member) => member.id));
const activeSessionId = ref<string | null>(null);
const activeRound = ref(0);
const chairmanStatus = ref<ActivityStatus>("waiting");
const conclusion = ref<ChairmanConclusion | null>(null);
const chatMessages = ref<CouncilChatMessage[]>([]);
const isRunning = ref(false);
const canInterject = ref(false);
const isSending = ref(false);
const errorMessage = ref("");
const chatContainer = ref<HTMLElement | null>(null);

const profile = reactive<UserProfile>({
  country: "België",
  situation: "",
  goals: "",
  riskProfile: "Gemiddeld",
  timeHorizon: "Lange termijn",
});

const selectedMembers = computed(() =>
  members.value.filter((member) =>
    selectedCouncillorIds.value.includes(member.id),
  ),
);

const activeSpeaker = computed(() => {
  if (chairmanStatus.value === "speaking") {
    return "Voorzitter";
  }

  return (
    members.value.find(
      (member) =>
        member.analysisStatus === "speaking" ||
        member.debateStatus === "speaking",
    )?.name || null
  );
});

const followUpPlaceholder = computed(() =>
  isRunning.value
    ? "Voeg een argument of verduidelijking toe..."
    : activeSessionId.value
      ? "Reageer op het besluit of stel een vervolgvraag aan dezelfde raad..."
      : "Leg een beslissing of situatie voor aan de raad...",
);

onMounted(() => {
  const savedProfile = localStorage.getItem("ai-council-profile");

  if (!savedProfile) {
    return;
  }

  try {
    Object.assign(profile, JSON.parse(savedProfile));
  } catch {
    localStorage.removeItem("ai-council-profile");
  }
});

function statusLabel(status: ActivityStatus) {
  return {
    waiting: "Wacht",
    reading: "Leest",
    thinking: "Denkt",
    typing: "Typt",
    speaking: "Spreekt",
    done: "Klaar",
    error: "Mislukt",
  }[status];
}

function visibleStatus(member: CouncilMember) {
  if (activeRound.value >= 2 && member.debateStatus !== "waiting") {
    return member.debateStatus;
  }

  return member.analysisStatus;
}

function toggleMember(id: string) {
  if (selectedCouncillorIds.value.includes(id)) {
    if (selectedCouncillorIds.value.length === 1) {
      return;
    }

    selectedCouncillorIds.value = selectedCouncillorIds.value.filter(
      (memberId) => memberId !== id,
    );

    return;
  }

  selectedCouncillorIds.value.push(id);
}

function resetCurrentRun() {
  members.value = members.value.map((member) => ({
    ...member,
    analysisStatus: "waiting",
    debateStatus: "waiting",
    answer: null,
  }));

  activeRound.value = 0;
  chairmanStatus.value = "waiting";
  conclusion.value = null;
  errorMessage.value = "";
}

function startNewSession() {
  if (isRunning.value || isSending.value) return;
  activeSessionId.value = null;
  message.value = "";
  chatMessages.value = [];
  resetCurrentRun();
}

function updateAnalysisStatus(id: string, status: ActivityStatus) {
  const member = members.value.find((item) => item.id === id);

  if (member) {
    member.analysisStatus = status;
  }
}

function updateDebateStatus(id: string, status: ActivityStatus) {
  const member = members.value.find((item) => item.id === id);

  if (member) {
    member.debateStatus = status;
  }
}

async function scrollChatToBottom() {
  await nextTick();

  if (chatContainer.value) {
    chatContainer.value.scrollTo({
      top: chatContainer.value.scrollHeight,
      behavior: "smooth",
    });
  }
}

async function runCouncil() {
  const question = message.value.trim();

  if (!question || isSending.value || question.length > 4000) {
    return;
  }

  if (isRunning.value) {
    if (!canInterject.value) return;
    isSending.value = true;
    message.value = "";
    errorMessage.value = "";

    try {
      await $fetch("/api/council/interject", {
        method: "POST",
        body: { sessionId: activeSessionId.value, message: question },
      });
    } catch (error) {
      message.value = [question, message.value].filter(Boolean).join("\n");
      errorMessage.value = (error as { data?: { message?: string } }).data?.message
        || "Je bijdrage kon niet worden verstuurd.";
    } finally {
      isSending.value = false;
    }
    return;
  }

  resetCurrentRun();
  isRunning.value = true;
  message.value = "";
  let questionAccepted = false;
  let finished = false;

  try {
    const response = await fetch("/api/council/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: question,
        sessionId: activeSessionId.value,
        mode: mode.value,
        selectedCouncillorIds: selectedCouncillorIds.value,
        profile: { ...profile },
      }),
    });

    if (!response.ok || !response.body) {
      const details = await response.json().catch(() => null);
      throw new Error(details?.message || `De raad kon niet starten (${response.status}).`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const streamEvent = JSON.parse(line) as StreamEvent;
        if (streamEvent.type === "session") questionAccepted = true;
        if (streamEvent.type === "complete" || streamEvent.type === "fatal_error") finished = true;
        await handleStreamEvent(streamEvent);
      }
    }

    if (buffer.trim()) {
      const streamEvent = JSON.parse(buffer) as StreamEvent;
      finished ||= streamEvent.type === "complete" || streamEvent.type === "fatal_error";
      await handleStreamEvent(streamEvent);
    }
    if (!finished) throw new Error("De verbinding met de raad werd onderbroken.");
  } catch (error) {
    if (!questionAccepted) message.value = [question, message.value].filter(Boolean).join("\n");

    errorMessage.value =
      error instanceof Error
        ? error.message
        : "De vergadering kon niet worden gestart.";
  } finally {
    canInterject.value = false;
    isRunning.value = false;
  }
}

async function handleStreamEvent(event: StreamEvent) {
  switch (event.type) {
    case "session":
      activeSessionId.value = event.payload.sessionId;
      activeRound.value = 1;
      canInterject.value = true;
      chatMessages.value.push({
        id: event.payload.questionId,
        councillorId: "user",
        name: "Jij",
        emoji: "✎",
        role: "",
        round: 0,
        kind: "user",
        replyTo: [],
        message: event.payload.question,
        createdAt: event.payload.questionCreatedAt,
      });
      await scrollChatToBottom();
      break;

    case "interjections_closed":
      canInterject.value = false;
      break;

    case "member_status":
      updateAnalysisStatus(event.payload.id, event.payload.status);
      break;

    case "debate_status":
      updateDebateStatus(event.payload.id, event.payload.status);
      break;

    case "member_result": {
      const member = members.value.find(
        (item) => item.id === event.payload.id,
      );

      if (member) {
        member.answer = event.payload;
      }
      break;
    }

    case "debate_started":
      activeRound.value = 2;
      break;

    case "chat_message":
      chatMessages.value.push(event.payload);
      await scrollChatToBottom();
      break;

    case "chairman_status":
      chairmanStatus.value = event.payload.status;

      if (event.payload.status !== "waiting") {
        activeRound.value = 3;
      }
      break;

    case "chairman_result":
      conclusion.value = event.payload;
      break;

    case "member_error":
      console.warn(
        `${event.payload.phase} fout voor ${event.payload.id}:`,
        event.payload.message,
      );
      break;

    case "chairman_error":
      errorMessage.value = event.payload.message;
      break;

    case "fatal_error":
      errorMessage.value = event.payload.message;
      break;

    case "complete":
      activeSessionId.value = event.payload.sessionId;
      break;
  }
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("nl-BE", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<template>
  <main class="app">
    <aside class="sidebar">
      <div class="logo">
        <div>Ω</div>

        <span>
          <strong>Conclave</strong>
          <small>AI Council</small>
        </span>
      </div>

      <button class="new-button" type="button" :disabled="isRunning || isSending" @click="startNewSession">
        ＋ Nieuwe vergadering
      </button>

      <section class="sidebar-members">
        <p>Raadsleden</p>

        <button
          v-for="member in members"
          :key="member.id"
          type="button"
          class="sidebar-member"
          :class="{
            selected: selectedCouncillorIds.includes(member.id),
            active: ['reading', 'thinking', 'typing', 'speaking'].includes(
              visibleStatus(member),
            ),
          }"
          :aria-pressed="selectedCouncillorIds.includes(member.id)"
          :disabled="isRunning"
          @click="toggleMember(member.id)"
        >
          <span class="avatar">{{ member.emoji }}</span>

          <span class="identity">
            <strong>{{ member.name }}</strong>
            <small>{{ member.role }}</small>
          </span>

          <span
            class="state-dot"
            :class="`state-${visibleStatus(member)}`"
          />
        </button>
      </section>

      <div class="local-status">
        <span />
        Ollama · {{ councilModel }}
      </div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <p>LIVE COUNCIL</p>
          <h1>Vergaderzaal</h1>
        </div>

        <div class="topbar-actions">
          <div class="rounds">
            <span :class="{ active: activeRound >= 1 }">1</span>
            <i />
            <span :class="{ active: activeRound >= 2 }">2</span>
            <i />
            <span :class="{ active: activeRound >= 3 }">3</span>
          </div>

          <div class="mode">
            <button
              type="button"
              :class="{ active: mode === 'quick' }"
              :disabled="isRunning"
              @click="mode = 'quick'"
            >
              Snel
            </button>

            <button
              type="button"
              :class="{ active: mode === 'deep' }"
              :disabled="isRunning"
              @click="mode = 'deep'"
            >
              Grondig
            </button>
          </div>
        </div>
      </header>

      <div class="layout">
        <section class="main-column">
          <section class="chat-window">
            <header class="chat-header">
              <div>
                <h2>Gesprek van de raad</h2>
              </div>

              <span>{{ chatMessages.length }} berichten</span>
            </header>

            <div ref="chatContainer" class="chat-list" role="log" aria-label="Gesprek van de raad">
              <article
                v-for="chatMessage in chatMessages"
                :key="chatMessage.id"
                class="chat-row"
                :class="[
                  `chat-${chatMessage.kind}`,
                  { chairman: chatMessage.kind === 'chairman' },
                ]"
              >
                <div class="chat-avatar">{{ chatMessage.emoji }}</div>

                <div class="bubble">
                  <div class="bubble-meta">
                    <strong>{{ chatMessage.name }}</strong>
                    <span>{{ chatMessage.role }}</span>

                    <small>
                      <template v-if="chatMessage.kind !== 'user'">Ronde {{ chatMessage.round }} · </template>
                      {{ formatTime(chatMessage.createdAt) }}
                    </small>
                  </div>

                  <p>{{ chatMessage.message }}</p>

                  <div
                    v-if="chatMessage.recommendation"
                    class="bubble-recommendation"
                  >
                    <span>
                      {{
                        chatMessage.kind === "chairman"
                          ? "Eindadvies"
                          : chatMessage.kind === "reply"
                            ? "Bijgesteld standpunt"
                            : "Aanbeveling"
                      }}
                    </span>

                    <strong>{{ chatMessage.recommendation }}</strong>
                  </div>

                  <div v-if="chatMessage.confidence !== undefined" class="confidence">
                    <span>Overtuiging</span>

                    <div>
                      <i
                        :style="{
                          width: `${chatMessage.confidence}%`,
                        }"
                      />
                    </div>

                    <strong>{{ chatMessage.confidence }}%</strong>
                  </div>
                </div>
              </article>

              <div v-if="!chatMessages.length" class="empty-chat">
                <div>◎</div>
                <h3>De vergadering is nog stil</h3>
                <p>
                  De eerste standpunten en alle reacties verschijnen hier als
                  chatbubbels.
                </p>
              </div>
            </div>
            <form class="composer" @submit.prevent="runCouncil">
              <label class="composer-label" for="council-message">
                {{ isRunning ? "Meng je in het debat" : activeSessionId ? "Reageer op de raad" : "Stel een vraag" }}
              </label>
              <textarea
                id="council-message"
                v-model="message"
                rows="2"
                maxlength="4000"
                :placeholder="followUpPlaceholder"
                @keydown.enter.exact.prevent="runCouncil"
              />
              <footer>
                <p role="status">
                  {{ isRunning
                    ? canInterject
                      ? "Je bijdrage gaat mee naar de volgende spreker."
                      : "De voorzitter rondt af. Je kunt zo een vervolgbericht sturen."
                    : "Enter om te versturen · Shift+Enter voor een nieuwe regel" }}
                </p>
                <button
                  type="submit"
                  :disabled="isSending || (isRunning && !canInterject) || !message.trim()"
                >
                  {{ isSending ? "Versturen…" : activeSessionId ? "Verstuur bericht" : "Start debat" }}
                </button>
              </footer>
              <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
            </form>
          </section>

          <section class="status-board">
            <header>
              <div>
                <p>RONDE {{ activeRound || 1 }}</p>

                <h2>
                  {{
                    activeRound === 2
                      ? "De raadsleden reageren op elkaar"
                      : activeRound === 3
                        ? "De voorzitter formuleert het besluit"
                        : "Onafhankelijke standpunten"
                  }}
                </h2>
              </div>

              <div v-if="activeSpeaker" class="speaking-now">
                <span />
                {{ activeSpeaker }} spreekt nu
              </div>
            </header>

            <div class="member-grid">
              <article
                v-for="member in selectedMembers"
                :key="member.id"
                class="member-card"
                :class="`member-${visibleStatus(member)}`"
              >
                <div class="member-head">
                  <span class="avatar large">{{ member.emoji }}</span>

                  <span class="identity">
                    <strong>{{ member.name }}</strong>
                    <small>{{ member.role }}</small>
                  </span>

                  <span class="status-pill">
                    {{ statusLabel(visibleStatus(member)) }}
                  </span>
                </div>

                <div
                  v-if="visibleStatus(member) === 'reading'"
                  class="reading-animation"
                >
                  <span>Leest de andere berichten</span>
                  <div />
                </div>

                <div
                  v-else-if="
                    ['thinking', 'typing'].includes(visibleStatus(member))
                  "
                  class="dot-animation"
                >
                  <i />
                  <i />
                  <i />

                  <span>
                    {{
                      visibleStatus(member) === "typing"
                        ? "schrijft een bericht"
                        : "denkt na"
                    }}
                  </span>
                </div>

                <div
                  v-else-if="visibleStatus(member) === 'speaking'"
                  class="voice-animation"
                >
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <span>is aan het spreken</span>
                </div>

                <p v-if="member.answer?.advice" class="member-summary">
                  {{ member.answer.advice.summary }}
                </p>
              </article>
            </div>
          </section>

          <section v-if="conclusion" class="conclusion">
            <header>
              <div class="chairman-icon">◇</div>

              <div>
                <p>EINDBESLUIT</p>
                <h2>De voorzitter heeft gesproken</h2>
              </div>

              <span>{{ conclusion.confidence }}%</span>
            </header>

            <h3>{{ conclusion.verdict }}</h3>

            <div class="action">
              <span>Aanbevolen actie</span>
              <strong>{{ conclusion.recommendedAction }}</strong>
            </div>

            <p>{{ conclusion.reasoning }}</p>

            <div class="conclusion-grid">
              <section>
                <h4>Consensus</h4>

                <ul>
                  <li v-for="item in conclusion.consensus" :key="item">
                    {{ item }}
                  </li>
                </ul>
              </section>

              <section>
                <h4>Meningsverschillen</h4>

                <ul>
                  <li v-for="item in conclusion.disagreements" :key="item">
                    {{ item }}
                  </li>
                </ul>
              </section>
            </div>
          </section>



        </section>

        <aside class="right-panel">
          <div class="chairman-card">
            <div class="chairman-avatar">◇</div>
            <strong>Voorzitter</strong>
            <small>{{ statusLabel(chairmanStatus) }}</small>

            <div
              v-if="
                ['reading', 'thinking', 'typing', 'speaking'].includes(
                  chairmanStatus,
                )
              "
              class="chairman-pulse"
            >
              <span />
              <span />
              <span />
            </div>
          </div>

          <section class="flow">
            <p>VERGADERFLOW</p>

            <article :class="{ active: activeRound >= 1 }">
              <span>01</span>

              <div>
                <strong>Openingsstandpunten</strong>
                <small>Iedereen vormt een eigen mening</small>
              </div>
            </article>

            <article :class="{ active: activeRound >= 2 }">
              <span>02</span>

              <div>
                <strong>Live debat</strong>
                <small>Raadsleden lezen en antwoorden</small>
              </div>
            </article>

            <article :class="{ active: activeRound >= 3 }">
              <span>03</span>

              <div>
                <strong>Besluit</strong>
                <small>Voorzitter brengt alles samen</small>
              </div>
            </article>
          </section>
        </aside>
      </div>
    </section>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(html) {
  min-height: 100%;
  background: #07100e;
}

:global(body) {
  min-height: 100%;
  margin: 0;
  background:
    radial-gradient(circle at 50% -10%, rgb(29 105 75 / 18%), transparent 36%),
    #07100e;
  color: #edf6f1;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", sans-serif;
}

button,
textarea {
  font: inherit;
}

button {
  color: inherit;
}

.app {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  padding: 22px 16px;
  border-right: 1px solid rgb(210 235 222 / 7%);
  background: rgb(5 13 10 / 92%);
}

.logo {
  display: flex;
  gap: 11px;
  align-items: center;
  padding: 0 7px 22px;
}

.logo > div {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid rgb(112 211 160 / 20%);
  border-radius: 13px;
  background: rgb(64 154 108 / 9%);
  color: #7dd2a5;
  font-family: Georgia, serif;
  font-size: 22px;
}

.logo strong,
.logo small,
.identity strong,
.identity small {
  display: block;
}

.logo small,
.identity small {
  margin-top: 3px;
  color: #5f7167;
  font-size: 10px;
}

.new-button {
  width: 100%;
  padding: 11px;
  border: 1px solid rgb(112 211 160 / 20%);
  border-radius: 11px;
  background: linear-gradient(135deg, #1c6e4d, #174c39);
  cursor: pointer;
  font-weight: 750;
}

.sidebar-members {
  margin-top: 25px;
}

.sidebar-members > p {
  margin: 0 9px 9px;
  color: #4d5e55;
  font-size: 10px;
  font-weight: 850;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.sidebar-member {
  display: flex;
  gap: 9px;
  align-items: center;
  width: 100%;
  padding: 9px;
  border: 1px solid transparent;
  border-radius: 11px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.sidebar-member.selected {
  background: rgb(255 255 255 / 3%);
}

.sidebar-member.active {
  border-color: rgb(112 211 160 / 18%);
  background: rgb(112 211 160 / 6%);
}

.avatar,
.chat-avatar {
  display: grid;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 7%);
  background: rgb(255 255 255 / 4%);
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 11px;
}

.avatar.large {
  width: 44px;
  height: 44px;
  border-radius: 13px;
  font-size: 22px;
}

.identity {
  flex: 1;
}

.identity strong {
  font-size: 12px;
}

.state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #34413a;
}

.state-reading {
  background: #6da4d6;
  box-shadow: 0 0 10px #6da4d6;
}

.state-thinking {
  background: #e1b45e;
  box-shadow: 0 0 10px #e1b45e;
}

.state-typing {
  background: #ba8ee7;
  box-shadow: 0 0 10px #ba8ee7;
}

.state-speaking {
  background: #70d9a2;
  box-shadow: 0 0 12px #70d9a2;
}

.state-done {
  background: #789b87;
}

.state-error {
  background: #f47777;
}

.local-status {
  position: absolute;
  right: 16px;
  bottom: 20px;
  left: 16px;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px;
  border: 1px solid rgb(255 255 255 / 6%);
  border-radius: 10px;
  color: #5c6d63;
  font-size: 10px;
}

.local-status span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6fd29e;
}

.workspace {
  min-width: 0;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 21px 28px;
  border-bottom: 1px solid rgb(210 235 222 / 7%);
}

.topbar p,
.status-board header p,
.chat-header p,
.conclusion header p,
.flow > p {
  margin: 0 0 6px;
  color: #66a17f;
  font-size: 9px;
  font-weight: 850;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}

.topbar h1,
.status-board h2,
.chat-header h2 {
  margin: 0;
}

.topbar-actions {
  display: flex;
  gap: 14px;
  align-items: center;
}

.rounds {
  display: flex;
  align-items: center;
}

.rounds span {
  display: grid;
  width: 25px;
  height: 25px;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: 50%;
  color: #4f6057;
  font-size: 9px;
}

.rounds span.active {
  border-color: rgb(112 211 160 / 32%);
  background: rgb(112 211 160 / 8%);
  color: #7bd3a4;
}

.rounds i {
  width: 26px;
  height: 1px;
  background: rgb(255 255 255 / 7%);
}

.mode {
  display: flex;
  padding: 3px;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 9px;
  background: rgb(255 255 255 / 3%);
}

.mode button {
  padding: 7px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #607168;
  cursor: pointer;
  font-size: 10px;
}

.mode button.active {
  background: rgb(255 255 255 / 7%);
  color: #eef6f1;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
}

.main-column {
  min-width: 0;
  padding: 26px 28px 60px;
}

.status-board > header,
.chat-header,
.conclusion > header,
.composer footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.speaking-now {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid rgb(112 217 162 / 18%);
  border-radius: 999px;
  color: #78d2a0;
  font-size: 10px;
}

.speaking-now span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #70d9a2;
  box-shadow: 0 0 11px #70d9a2;
}

.member-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

.member-card {
  min-height: 170px;
  padding: 14px;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 15px;
  background: rgb(255 255 255 / 2%);
}

.member-reading {
  border-color: rgb(109 164 214 / 25%);
}

.member-thinking {
  border-color: rgb(225 180 94 / 25%);
}

.member-typing {
  border-color: rgb(186 142 231 / 25%);
}

.member-speaking {
  border-color: rgb(112 217 162 / 40%);
  box-shadow: 0 0 30px rgb(35 145 91 / 10%);
}

.member-error {
  border-color: rgb(244 119 119 / 26%);
}

.member-head {
  display: flex;
  gap: 10px;
  align-items: center;
}

.status-pill {
  padding: 5px 7px;
  border-radius: 999px;
  background: rgb(255 255 255 / 4%);
  color: #718278;
  font-size: 9px;
}

.reading-animation,
.dot-animation,
.voice-animation {
  min-height: 38px;
  margin-top: 15px;
}

.reading-animation > span,
.dot-animation > span,
.voice-animation > span {
  color: #73867b;
  font-size: 10px;
}

.reading-animation div {
  position: relative;
  height: 3px;
  margin-top: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: rgb(255 255 255 / 5%);
}

.reading-animation div::after {
  position: absolute;
  width: 35%;
  height: 100%;
  border-radius: 999px;
  background: #6da4d6;
  content: "";
  animation: scan 1.1s linear infinite;
}

.dot-animation,
.voice-animation {
  display: flex;
  gap: 4px;
  align-items: center;
}

.dot-animation i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e1b45e;
  animation: bounce 1s ease-in-out infinite;
}

.member-typing .dot-animation i {
  background: #ba8ee7;
}

.dot-animation i:nth-child(2),
.voice-animation i:nth-child(2) {
  animation-delay: 0.12s;
}

.dot-animation i:nth-child(3),
.voice-animation i:nth-child(3) {
  animation-delay: 0.24s;
}

.dot-animation span,
.voice-animation span {
  margin-left: 5px;
}

.voice-animation i {
  width: 3px;
  height: 7px;
  border-radius: 999px;
  background: #70d9a2;
  animation: voice 0.7s ease-in-out infinite;
}

.voice-animation i:nth-child(4) {
  animation-delay: 0.36s;
}

.voice-animation i:nth-child(5) {
  animation-delay: 0.48s;
}

.member-summary {
  display: -webkit-box;
  margin: 12px 0 0;
  overflow: hidden;
  color: #92a399;
  font-size: 10px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.chat-window,
.conclusion,
.composer {
  margin-top: 18px;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 17px;
  background: rgb(255 255 255 / 2%);
}

.chat-window {
  overflow: hidden;
}

.chat-header {
  padding: 17px;
  border-bottom: 1px solid rgb(255 255 255 / 6%);
}

.chat-header > span {
  color: #5e7066;
  font-size: 9px;
}

.chat-list {
  display: grid;
  gap: 15px;
  min-height: 320px;
  max-height: 680px;
  overflow-y: auto;
  padding: 18px;
}

.chat-row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 10px;
  max-width: 88%;
}

.chat-row.chat-user {
  margin-left: auto;
  grid-template-columns: minmax(0, 1fr) 38px;
}

.chat-row.chat-user .chat-avatar {
  grid-column: 2;
  grid-row: 1;
}

.chat-row.chat-user .bubble {
  grid-column: 1;
  grid-row: 1;
  border-radius: 14px 0 14px 14px;
}

.chat-row.chairman {
  max-width: 96%;
  margin: 4px auto;
}

.chat-avatar {
  width: 38px;
  height: 38px;
  border-radius: 12px;
}

.bubble {
  padding: 14px;
  border: 1px solid rgb(255 255 255 / 6%);
  border-radius: 0 14px 14px;
  background: #091511;
}

.chat-reply .bubble {
  border-color: rgb(112 217 162 / 10%);
}

.chat-chairman .bubble {
  border-color: rgb(112 217 162 / 20%);
  background:
    linear-gradient(135deg, rgb(44 138 97 / 8%), transparent),
    #091511;
}

.bubble-meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.bubble-meta strong {
  font-size: 11px;
}

.bubble-meta span,
.bubble-meta small {
  color: #5f7167;
  font-size: 9px;
}

.bubble-meta small {
  margin-left: auto;
}

.bubble > p {
  margin: 11px 0;
  color: #a3b3aa;
  font-size: 12px;
  line-height: 1.7;
}

.bubble-recommendation {
  padding: 11px;
  border: 1px solid rgb(112 217 162 / 10%);
  border-radius: 10px;
  background: rgb(112 217 162 / 4%);
}

.bubble-recommendation span {
  display: block;
  color: #6ba685;
  font-size: 8px;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.bubble-recommendation strong {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.5;
}

.confidence {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 9px;
  align-items: center;
  margin-top: 10px;
  color: #61736a;
  font-size: 9px;
}

.confidence > div {
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: rgb(255 255 255 / 5%);
}

.confidence i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #3b8f65, #70d9a2);
}

.empty-chat {
  display: grid;
  min-height: 280px;
  place-items: center;
  align-content: center;
  text-align: center;
}

.empty-chat > div {
  color: #4d5e55;
  font-size: 30px;
}

.empty-chat h3 {
  margin: 10px 0 5px;
  font-size: 12px;
}

.empty-chat p {
  max-width: 350px;
  margin: 0;
  color: #596b61;
  font-size: 10px;
  line-height: 1.6;
}

.conclusion {
  padding: 19px;
  border-color: rgb(112 217 162 / 14%);
  background:
    linear-gradient(135deg, rgb(44 138 97 / 8%), transparent),
    rgb(255 255 255 / 2%);
}

.conclusion > header {
  gap: 11px;
}

.chairman-icon {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 13px;
  background: rgb(112 217 162 / 9%);
  color: #79d4a3;
  font-size: 21px;
}

.conclusion header > div:nth-child(2) {
  flex: 1;
}

.conclusion header h2 {
  margin: 0;
}

.conclusion header > span {
  padding: 6px 8px;
  border-radius: 999px;
  background: rgb(112 217 162 / 7%);
  color: #75c99a;
  font-size: 9px;
}

.conclusion > h3 {
  margin: 18px 0;
  font-size: 19px;
  line-height: 1.4;
}

.action {
  padding: 13px;
  border: 1px solid rgb(112 217 162 / 11%);
  border-radius: 11px;
  background: rgb(112 217 162 / 4%);
}

.action span {
  color: #6aa684;
  font-size: 8px;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.action strong {
  display: block;
  margin-top: 6px;
}

.conclusion > p {
  color: #91a399;
  line-height: 1.7;
}

.conclusion-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 11px;
}

.conclusion-grid section {
  padding: 12px;
  border: 1px solid rgb(255 255 255 / 6%);
  border-radius: 11px;
}

.conclusion-grid h4 {
  margin: 0;
  font-size: 11px;
}

.conclusion-grid ul {
  padding-left: 17px;
  color: #87998f;
  font-size: 10px;
  line-height: 1.6;
}

.composer {
  padding: 16px;
}



.composer textarea {
  width: 100%;
  margin-top: 10px;
  padding: 13px;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 11px;
  outline: none;
  resize: vertical;
  background: #08130f;
  color: #eef6f1;
  line-height: 1.6;
}

.composer textarea:focus {
  border-color: rgb(112 217 162 / 30%);
  box-shadow: 0 0 0 3px rgb(112 217 162 / 6%);
}

.composer footer {
  margin-top: 11px;
}

.composer footer p {
  margin: 0;
  color: #5b6d63;
  font-size: 9px;
}

.composer footer button {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  padding: 10px 13px;
  border: 0;
  border-radius: 10px;
  background: linear-gradient(135deg, #2c8a61, #225f46);
  cursor: pointer;
  font-weight: 750;
}

.composer footer button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}


.error {
  padding: 10px;
  border: 1px solid rgb(244 119 119 / 15%);
  border-radius: 10px;
  background: rgb(244 119 119 / 5%);
  color: #d78484;
  font-size: 10px;
}

.right-panel {
  padding: 26px 20px;
  border-left: 1px solid rgb(210 235 222 / 7%);
  background: rgb(4 11 9 / 48%);
}

.chairman-card {
  display: grid;
  min-height: 180px;
  place-items: center;
  align-content: center;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 15px;
  background: rgb(255 255 255 / 2%);
  text-align: center;
}

.chairman-avatar {
  display: grid;
  width: 52px;
  height: 52px;
  place-items: center;
  border: 1px solid rgb(112 217 162 / 16%);
  border-radius: 50%;
  background: rgb(112 217 162 / 7%);
  color: #79d4a3;
  font-size: 24px;
}

.chairman-card strong {
  margin-top: 10px;
}

.chairman-card small {
  margin-top: 4px;
  color: #5d6f65;
}

.chairman-pulse {
  display: flex;
  gap: 4px;
  margin-top: 12px;
}

.chairman-pulse span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #70d9a2;
  animation: bounce 1s ease-in-out infinite;
}

.chairman-pulse span:nth-child(2) {
  animation-delay: 0.12s;
}

.chairman-pulse span:nth-child(3) {
  animation-delay: 0.24s;
}

.flow {
  margin-top: 18px;
}

.flow article {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 9px;
  padding: 11px 0;
  opacity: 0.4;
}

.flow article.active {
  opacity: 1;
}

.flow article > span {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 50%;
  color: #61736a;
  font-size: 9px;
}

.flow article.active > span {
  border-color: rgb(112 217 162 / 25%);
  background: rgb(112 217 162 / 6%);
  color: #75c99a;
}

.flow strong,
.flow small {
  display: block;
}

.flow strong {
  font-size: 11px;
}

.flow small {
  margin-top: 3px;
  color: #5c6e64;
  font-size: 9px;
  line-height: 1.4;
}

@keyframes scan {
  from {
    left: -35%;
  }

  to {
    left: 100%;
  }
}

@keyframes bounce {
  0%,
  100% {
    opacity: 0.3;
    transform: translateY(0);
  }

  50% {
    opacity: 1;
    transform: translateY(-4px);
  }
}

@keyframes voice {
  0%,
  100% {
    height: 6px;
  }

  50% {
    height: 19px;
  }
}


@media (max-width: 1050px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .right-panel {
    border-top: 1px solid rgb(210 235 222 / 7%);
    border-left: 0;
  }
}

@media (max-width: 850px) {
  .app {
    grid-template-columns: 1fr;
  }

  .sidebar {
    position: static;
    height: auto;
  }

  .sidebar-members,
  .local-status {
    display: none;
  }

  .member-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .topbar,
  .status-board > header,
  .composer footer {
    align-items: stretch;
    flex-direction: column;
  }

  .topbar,
  .main-column,
  .right-panel {
    padding-right: 15px;
    padding-left: 15px;
  }

  .topbar-actions {
    justify-content: space-between;
  }

  .chat-row {
    max-width: 100%;
  }

  .conclusion-grid {
    grid-template-columns: 1fr;
  }
}

.chat-window .composer {
  margin-top: 0;
  border-radius: 0;
  border-width: 1px 0 0;
}

.composer-label {
  color: inherit;
  font-weight: 600;
}

.chat-row.chat-user .bubble {
  background: #213044;
  border-color: #3b526c;
}

.bubble > p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

button:disabled {
  cursor: not-allowed;
}
</style>
