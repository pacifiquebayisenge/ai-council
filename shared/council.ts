export const councilModel = "qwen2.5:7b";

export const councilMembers = [
  { id: "athena", name: "Athena", emoji: "🏛️", role: "Architect", model: "gemma4:26b" },
  { id: "plutus", name: "Milo", emoji: "🛠️", role: "Pragmatist", model: councilModel },
  { id: "solon", name: "Solon", emoji: "🔎", role: "Criticus", model: "gemma3:12b" },
];

export const guestMember = { id: "vera", name: "Vera", emoji: "💬", role: "Gebruikersstem" };
export const chairman = { id: "chairman", name: "Voorzitter", role: "Moderator" };

export const councilParticipants = [...councilMembers, guestMember, chairman];
