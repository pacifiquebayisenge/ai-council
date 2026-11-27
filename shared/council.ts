export const councilModel = "qwen3.5:9b";

export const councilMembers = [
  { id: "athena", name: "Victor", emoji: "📊", role: "Analyst", model: councilModel },
  { id: "plutus", name: "Maya", emoji: "🎯", role: "Strategist", model: councilModel },
  { id: "solon", name: "Sofia", emoji: "🔎", role: "Skeptic", model: councilModel },
  { id: "vera", name: "Gabriel", emoji: "💬", role: "Empath", model: councilModel },
];
export const guestMember = { id: "guest", name: "Guest", emoji: "✨", role: "Additional perspective" };
export const chairman = { id: "chairman", name: "Summary", role: "Facilitator" };
export const councilParticipants = [...councilMembers, guestMember, chairman];
