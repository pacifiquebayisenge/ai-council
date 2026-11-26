<script setup lang="ts">
import { chairman, councilMembers, councilParticipants, guestMember } from "#shared/council";

interface ChatMessage {
  id: string;
  name: string;
  councillorId: string;
  kind: "opening" | "reply" | "chairman" | "user";
  message: string;
  replyTo: string[];
  recommendation?: string;
  position?: "defend" | "revise" | "clarify" | "challenge";
}

interface Conclusion {
  reasoning: string;
  consensus: string[];
  disagreements: string[];
  nextSteps: string[];
  importantCaution: string;
}

const transcript = ref<ChatMessage[]>([]);
const conclusions = ref<Record<string, Conclusion>>({});
const draft = ref("");
const sessionId = ref<string>();
const mode = ref<"quick" | "deep">("quick");
const selectedIds = ref(councilMembers.map(({ id }) => id));
const running = ref(false);
const sending = ref(false);
const accepting = ref(false);
const activityLabels = {
  waiting: "Luistert",
  reading: "Leest mee",
  thinking: "Denkt na",
  typing: "Schrijft",
  speaking: "Plaatst bericht",
  done: "Luistert",
  error: "Geen antwoord",
};
type Activity = keyof typeof activityLabels;
const activity = ref<Record<string, Activity>>({});
const models = ref<string[]>([]);
const guestModel = ref("");
const modelStatus = ref("");
const guestModels = computed(() => models.value.filter((model) =>
  !councilMembers.some((member) => member.model === model && selectedIds.value.includes(member.id)),
));
const participants = computed(() => [
  { id: "user", name: "Jij", role: "Deelnemer" },
  ...councilMembers.filter(({ id }) => selectedIds.value.includes(id)),
  ...(selectedIds.value.includes(guestMember.id) ? [{ ...guestMember, model: guestModel.value }] : []),
  chairman,
]);
const errorMessage = ref("");
const chat = ref<HTMLElement>();
const composer = ref<HTMLTextAreaElement>();
const profile = ref<Record<string, string>>({
  country: "België",
  riskProfile: "Gemiddeld",
  timeHorizon: "Lange termijn",
});

const names = new Map(councilParticipants.map(({ id, name }) => [id, name]));
const placeholder = computed(() => {
  if (running.value && accepting.value) return "Meng je in het gesprek…";
  if (sessionId.value) return "Stel een vervolgvraag…";
  return "Welke vraag wil je aan de raad voorleggen?";
});

onMounted(() => {
  void refreshModels();
  try {
    const saved = localStorage.getItem("ai-council-profile");
    if (saved) profile.value = { ...profile.value, ...JSON.parse(saved) };
  } catch {
    // A stored profile is optional.
  }
});

async function refreshModels() {
  try {
    models.value = (await $fetch("/api/council/models")).models;
    modelStatus.value = "";
  } catch {
    modelStatus.value = "Ollama is niet bereikbaar.";
  }
}

function newConversation() {
  sessionId.value = undefined;
  transcript.value = [];
  conclusions.value = {};
  draft.value = "";
  errorMessage.value = "";
  activity.value = {};
  composer.value?.focus();
}

function toggleParticipant(id: string) {
  if (selectedIds.value.includes(id)) {
    if (selectedIds.value.length > 1) {
      selectedIds.value = selectedIds.value.filter((selected) => selected !== id);
    }
  } else {
    selectedIds.value.push(id);
    if (id !== guestMember.id && !guestModels.value.includes(guestModel.value)) {
      guestModel.value = "";
      selectedIds.value = selectedIds.value.filter((selected) => selected !== guestMember.id);
    }
  }
}

function updateGuest() {
  const included = selectedIds.value.includes(guestMember.id);
  if (Boolean(guestModel.value) !== included) toggleParticipant(guestMember.id);
}

function append(entry: ChatMessage) {
  const log = chat.value;
  const nearBottom = !log || log.scrollHeight - log.clientHeight - log.scrollTop < 100;
  transcript.value.push(entry);
  if (nearBottom || entry.kind === "user") {
    void nextTick(() => {
      if (log) log.scrollTop = log.scrollHeight;
    });
  }
}

function handleEvent({ type, payload }: { type: string; payload: any }) {
  switch (type) {
    case "session":
      sessionId.value = payload.sessionId;
      accepting.value = true;
      append({
        id: payload.questionId,
        name: "Jij",
        councillorId: "user",
        message: payload.question,
        kind: "user",
        replyTo: [],
      });
      break;
    case "member_status":
    case "debate_status":
    case "chairman_status":
      if (Object.hasOwn(activityLabels, payload.status)) {
        activity.value[type === "chairman_status" ? chairman.id : payload.id] = payload.status;
      }
      break;
    case "chat_message":
      append(payload);
      break;
    case "chairman_result": {
      const conclusion = transcript.value.findLast(({ kind }) => kind === "chairman");
      if (conclusion) conclusions.value[conclusion.id] = payload;
      break;
    }
    case "interjections_closed":
      accepting.value = false;
      break;
    case "chairman_error":
    case "fatal_error":
      errorMessage.value = payload.message;
      break;
  }
}

async function submit() {
  const text = draft.value.trim();
  if (!text || text.length > 4000 || sending.value || (running.value && !accepting.value)) return;
  draft.value = "";
  errorMessage.value = "";

  if (running.value) {
    sending.value = true;
    try {
      await $fetch("/api/council/interject", {
        method: "POST",
        body: { sessionId: sessionId.value, message: text },
      });
    } catch (error) {
      draft.value = [text, draft.value].filter(Boolean).join("\n");
      errorMessage.value = (error as { data?: { message?: string } }).data?.message
        || "Je bericht kon niet worden verstuurd.";
    } finally {
      sending.value = false;
    }
    return;
  }

  running.value = true;
  activity.value = {};
  let accepted = false;
  let finished = false;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    accepted ||= event.type === "session";
    finished ||= event.type === "complete" || event.type === "fatal_error";
    handleEvent(event);
  }

  try {
    const response = await fetch("/api/council/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        sessionId: sessionId.value,
        mode: mode.value,
        selectedCouncillorIds: selectedIds.value,
        guestModel: guestModel.value,
        profile: profile.value,
      }),
    });
    if (!response.ok || !response.body) {
      const details = await response.json().catch(() => null);
      throw new Error(details?.message || "De raad kon niet starten.");
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (buffer + value).split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(consume);
    }
    consume(buffer);
    if (!finished) throw new Error("De verbinding met de raad werd onderbroken.");
  } catch (error) {
    if (!accepted) draft.value = [text, draft.value].filter(Boolean).join("\n");
    errorMessage.value = error instanceof Error ? error.message : "Er ging iets mis.";
  } finally {
    running.value = false;
    accepting.value = false;
    for (const id of Object.keys(activity.value)) {
      if (activity.value[id] !== "error") activity.value[id] = "waiting";
    }
  }
}

function onEnter(event: KeyboardEvent) {
  if (event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  void submit();
}

function addressee(entry: ChatMessage) {
  const id = entry.replyTo[0];
  return id === "user" ? "Jij" : id ? names.get(id) : undefined;
}
</script>

<template>
  <main class="council">
    <header class="bar">
      <div class="brand"><span aria-hidden="true">C</span> Conclave</div>
      <div class="actions">
        <details class="settings" @toggle="(event) => { if ((event.currentTarget as HTMLDetailsElement).open) refreshModels(); }">
          <summary>Instellingen</summary>
          <div class="settings-panel">
            <label>
              Debatlengte
              <select v-model="mode" :disabled="running">
                <option value="quick">Kort</option>
                <option value="deep">Uitgebreid</option>
              </select>
            </label>
            <fieldset :disabled="running">
              <legend>Raadsleden</legend>
              <label v-for="member in councilMembers" :key="member.id" class="choice">
                <input
                  type="checkbox"
                  :checked="selectedIds.includes(member.id)"
                  :disabled="selectedIds.length === 1 && selectedIds.includes(member.id)"
                  @change="toggleParticipant(member.id)"
                />
                {{ member.name }}
              </label>
            </fieldset>
            <label class="guest-choice">
              Vera · Gebruikersstem
              <select
                v-model="guestModel"
                :disabled="running || !guestModels.length || (selectedIds.length === 1 && selectedIds.includes(guestMember.id))"
                @change="updateGuest"
              >
                <option value="">Niet aanwezig</option>
                <option v-for="model in guestModels" :key="model" :value="model">{{ model }}</option>
              </select>
            </label>
            <small v-if="modelStatus">{{ modelStatus }}</small>
            <small v-else-if="!guestModels.length">Vera kan meedoen zodra er een vrij Ollama-model is.</small>
          </div>
        </details>
        <button class="quiet" type="button" :disabled="running || sending || !sessionId" @click="newConversation">
          Nieuw gesprek
        </button>
      </div>
    </header>

    <section class="presence" aria-labelledby="presence-label">
      <h2 id="presence-label">{{ participants.length }} aanwezig</h2>
      <ul class="participants" aria-live="polite">
        <li
          v-for="person in participants"
          :key="person.id"
          class="participant"
          :data-state="activity[person.id] || 'waiting'"
        >
          <span class="avatar" :data-member="person.id" aria-hidden="true">{{ person.name[0] }}</span>
          <div>
            <strong>{{ person.name }}</strong>
            <span class="participant-role">{{ person.role }}<template v-if="'model' in person"> · {{ person.model }}</template></span>
            <span v-if="person.id !== 'user'" class="participant-state">
              <span class="state-indicator" aria-hidden="true"><i /><i /><i /></span>
              {{ running ? activityLabels[activity[person.id] || "waiting"] : activity[person.id] === "error" ? "Geen antwoord" : "Aanwezig" }}
            </span>
          </div>
        </li>
      </ul>
    </section>

    <div ref="chat" class="timeline" role="log" aria-label="Gesprek met de raad">
      <div v-if="!transcript.length" class="welcome">
        <h1>Wat wil je bespreken?</h1>
        <p>Leg een vraag voor aan de raad en meng je in het debat wanneer je wilt.</p>
      </div>

      <div v-else class="thread">
        <article v-for="entry in transcript" :key="entry.id" class="message" :class="entry.kind">
          <span class="avatar" :data-member="entry.councillorId" aria-hidden="true">{{ entry.name[0] }}</span>
          <div class="content">
            <header class="byline">
              <strong>{{ entry.name }}</strong>
              <span v-if="entry.kind === 'chairman'">Conclusie</span>
              <span v-else-if="entry.kind === 'reply' && addressee(entry)">→ {{ addressee(entry) }}</span>
              <span v-if="entry.position === 'revise'" class="revision">Herziet standpunt</span>
            </header>
            <p>{{ entry.message }}</p>
            <p v-if="entry.recommendation && entry.recommendation !== entry.message" class="recommendation">{{ entry.recommendation }}</p>
            <details v-if="conclusions[entry.id]" class="reasoning">
              <summary>Onderbouwing en open punten</summary>
              <p v-if="conclusions[entry.id]?.reasoning">{{ conclusions[entry.id]?.reasoning }}</p>
              <template v-for="(label, key) in { consensus: 'Overeenkomsten', disagreements: 'Open meningsverschillen', nextSteps: 'Volgende stappen' }" :key="key">
                <div v-if="conclusions[entry.id]?.[key]?.length">
                  <strong>{{ label }}</strong>
                  <ul>
                    <li v-for="(item, index) in conclusions[entry.id]?.[key]" :key="index">{{ item }}</li>
                  </ul>
                </div>
              </template>
              <p v-if="conclusions[entry.id]?.importantCaution">{{ conclusions[entry.id]?.importantCaution }}</p>
            </details>
          </div>
        </article>
      </div>
    </div>

    <footer class="composer-shell">
      <form class="composer" @submit.prevent="submit">
        <div v-if="running" class="activity" role="status">
          {{ accepting ? "Je kunt nu tussenkomen." : sessionId ? "Je kunt zo een vervolgvraag sturen." : "De raad komt samen…" }}
        </div>
        <div class="input-row">
          <textarea
            ref="composer"
            v-model="draft"
            :placeholder="placeholder"
            aria-label="Bericht aan de raad"
            rows="2"
            maxlength="4000"
            @keydown.enter="onEnter"
          />
          <button
            type="submit"
            :disabled="!draft.trim() || sending || (running && !accepting)"
            :aria-label="sessionId ? 'Verstuur bericht' : 'Start debat'"
          >
            {{ sending ? "…" : sessionId ? "Verstuur" : "Start debat" }}
          </button>
        </div>
        <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      </form>
    </footer>
  </main>
</template>

<style>
:root {
  font-family: "Avenir Next", "Segoe UI", system-ui, sans-serif;
  color: #252522;
  background: #faf9f6;
  color-scheme: light;
}

*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }
button, textarea, select { font: inherit; }
button, summary, select { cursor: pointer; }
button:disabled { cursor: default; opacity: .45; }
:focus-visible { outline: 2px solid #436858; outline-offset: 3px; }

.council {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  height: 100vh;
  height: 100dvh;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 14px clamp(16px, 4vw, 48px);
  border-bottom: 1px solid #e7e4dd;
  background: #fffefa;
}

.brand, .actions { display: flex; align-items: center; gap: 12px; }
.brand { font-weight: 650; }
.brand span, .avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 9px;
  background: #e6ede7;
  color: #365244;
  font-size: .85rem;
  font-weight: 700;
}

.actions { font-size: .85rem; }
.quiet {
  padding: 7px 11px;
  border: 1px solid #dedbd3;
  border-radius: 8px;
  background: transparent;
  color: inherit;
}

.settings { position: relative; }
.settings > summary { color: #585851; }
.settings-panel {
  position: absolute;
  z-index: 2;
  top: calc(100% + 12px);
  right: 0;
  width: min(230px, 75vw);
  padding: 16px;
  border: 1px solid #e7e4dd;
  border-radius: 12px;
  background: #fffefa;
  box-shadow: 0 8px 24px #25252212;
}
.settings-panel select { display: block; margin-top: 6px; width: 100%; }
.settings-panel fieldset { margin: 14px 0; padding: 0; border: 0; }
.settings-panel legend { margin-bottom: 6px; }
.choice { display: flex; align-items: center; gap: .5rem; margin: 4px 0; }
.settings-panel small { display: block; margin-top: 6px; color: #5e5d55; }

.presence {
  min-width: 0;
  padding: 12px clamp(16px, 4vw, 48px);
  border-bottom: 1px solid #e7e4dd;
  background: #faf9f6;
}
.presence h2 { margin: 0 0 8px; font-size: .81rem; font-weight: 650; }
.participants {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  list-style: none;
  margin: 0;
  padding: 0 0 3px;
}
.participant {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid #e7e4dd;
  border-radius: 11px;
  background: #fffefa;
  transition: background 160ms, border-color 160ms;
}
.participant strong, .participant-role, .participant-state { display: block; }
.participant strong { font-size: .85rem; }
.participant-role, .participant-state { color: #5e5d55; font-size: .72rem; }
.participant-state { margin-top: 3px; }
.avatar[data-member="vera"] { background: #f4e6e4; color: #784b47; }
.participant:is([data-state="reading"], [data-state="thinking"], [data-state="typing"]) {
  background: #eff4ed;
  border-color: #abc1ad;
}
.participant[data-state="reading"] .avatar { animation: read-nod 950ms ease-in-out infinite; }
.participant[data-state="typing"] .state-indicator { display: inline-flex; gap: 2px; }
.state-indicator { display: none; }
.state-indicator i { width: 4px; height: 4px; background: #365244; border-radius: 50%; animation: typing-dot .9s ease-in-out infinite; }
.state-indicator i:nth-child(2) { animation-delay: .14s; }
.state-indicator i:nth-child(3) { animation-delay: .28s; }
.participant[data-state="thinking"] .avatar { animation: thinking-pulse 1.4s ease-in-out infinite; }
.participant[data-state="error"] .participant-state { color: #982b2b; }
@keyframes read-nod { 50% { transform: rotate(-9deg); } }
@keyframes thinking-pulse { 50% { box-shadow: 0 0 0 4px #c9dace; } }
@keyframes typing-dot { 50% { transform: translateY(-3px); } }
@keyframes enter-message { from { opacity: .45; transform: translateY(5px); } }
@media (prefers-reduced-motion: reduce) {
  .participant, .participant .avatar, .state-indicator i, .message { animation: none !important; transition: none; }
}

.timeline { overflow-y: auto; padding: 18px 16px; }
.welcome {
  display: grid;
  align-content: center;
  min-height: 100%;
  text-align: center;
}
.welcome h1 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.5rem); font-weight: 650; letter-spacing: -.04em; }
.welcome p { color: #5e5d55; margin: .65rem auto; max-width: 30rem; line-height: 1.55; }
.thread, .composer { width: min(100%, 760px); margin-inline: auto; }

.message { animation: enter-message 180ms ease-out; display: flex; align-items: flex-start; gap: 12px; padding: 16px 0; }
.message + .message { border-top: 1px solid #ebe8e0; }
.content { min-width: 0; flex: 1; }
.content p, .content li { line-height: 1.55; overflow-wrap: anywhere; }
.content p { margin: 5px 0 0; white-space: pre-wrap; }
.byline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 10px; font-size: .92rem; }
.byline span { color: #5e5d55; font-size: .79rem; }
.byline .revision { color: #365244; }
.user .content { flex: initial; padding: 10px 14px; background: #eeede7; border-radius: 10px; }
.user { flex-direction: row-reverse; }
.user .avatar { background: #eeede7; color: #545149; }
.avatar[data-member="plutus"] { background: #eee7dc; color: #665139; }
.avatar[data-member="solon"] { background: #ebe6ef; color: #5a4765; }
.chairman .content { padding: 12px 15px; background: #edf2ed; border-radius: 10px; }
.recommendation { font-weight: 600; }
.reasoning { margin-top: 12px; color: #494c45; font-size: .88rem; }
.reasoning div { margin-top: 10px; }
.reasoning ul { margin: 4px 0; padding-left: 1.35rem; }

.composer-shell {
  padding: 8px 16px max(12px, env(safe-area-inset-bottom));
  border-top: 1px solid #e7e4dd;
  background: #fffefa;
}
.activity { padding: 0 0 8px; font-size: .84rem; color: #4d5a50; }
.input-row { display: flex; gap: 8px; align-items: flex-end; }
.composer textarea {
  flex: 1;
  min-width: 0;
  min-height: 52px;
  max-height: 23vh;
  padding: 10px 12px;
  resize: vertical;
  border: 1px solid #dddad1;
  border-radius: 9px;
  background: #fff;
  color: inherit;
}
.composer button {
  min-height: 42px;
  padding: 0 13px;
  border: 0;
  border-radius: 8px;
  background: #375648;
  color: white;
  font-size: .86rem;
  font-weight: 650;
}
.error { margin: 8px 0 0; color: #982b2b; font-size: .85rem; }

@media (max-width: 480px) {
  .bar, .brand, .actions { gap: 8px; }
  .bar { padding: 10px 12px; }
  .settings-panel { position: fixed; top: 56px; right: 12px; }
  .message { gap: 8px; }
  .thread .avatar { width: 27px; height: 27px; }
}
</style>
