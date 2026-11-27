import { councilModel } from "#shared/council";
import database from "../../utils/database";

export default defineEventHandler(async () => {
  let ollama: "online" | "offline" = "offline";
  let models: string[] = [];
  let detail = "";
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", {signal:AbortSignal.timeout(3500)});
    if (!response.ok) throw new Error("Ollama HTTP "+response.status);
    const data = await response.json() as {models?:{name:string}[]};
    models = (data.models ?? []).map(m=>m.name);
    ollama = "online";
  } catch(e) {detail = e instanceof Error ? e.message : "Connection failed";}
  let sqlite: "online" | "offline" = "offline";
  try {database.prepare("SELECT 1").get(); sqlite = "online";} catch {}
  return {ollama,sqlite,requiredModel:councilModel,requiredModelInstalled:models.includes(councilModel),models,detail};
});
