export const councilModel = "qwen3.5:9b";

export const councilMembers = [
  { id: "athena", name: "Athena", emoji: "🦉", role: "Analyst", model: councilModel },
  { id: "plutus", name: "Hermes", emoji: "🪽", role: "Strategist", model: councilModel },
  { id: "solon", name: "Zeus", emoji: "⚡", role: "Skeptic", model: councilModel },
  { id: "vera", name: "Hestia", emoji: "🔥", role: "Empath", model: councilModel },
];
export const guestMember = { id: "guest", name: "Guest", emoji: "✨", role: "Additional perspective" };
export const chairman = { id: "chairman", name: "The Oracle", role: "Facilitator" };
export const councilParticipants = [...councilMembers, guestMember, chairman];
