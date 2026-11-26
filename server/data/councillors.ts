import { councilMembers, councilModel } from "#shared/council";

export const councillors = councilMembers.map((member) => ({
  ...member,
  model: councilModel,
  description: member.role,
  systemPrompt: `Je bent de ${member.name} in een debat. Focus op ${member.role.toLowerCase()}.`,
  options: { temperature: 0.35, num_ctx: 8192 },
}));
