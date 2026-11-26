export const councilModel = "qwen2.5:7b";

export const councilMembers = [
  { id: "athena", name: "Victor", emoji: "📊", role: "Analyste", model: councilModel },
  { id: "plutus", name: "Maya", emoji: "🎯", role: "Stratège", model: councilModel },
  { id: "solon", name: "Sofia", emoji: "🔎", role: "Sceptique", model: councilModel },
  { id: "vera", name: "Gabriel", emoji: "💬", role: "Empathique", model: councilModel },
];
export const guestMember = { id: "guest", name: "Invité", emoji: "✨", role: "Perspective supplémentaire" };
export const chairman = { id: "chairman", name: "Synthèse", role: "Facilitateur" };
export const councilParticipants = [...councilMembers, guestMember, chairman];
