import crypto from "node:crypto";
import type { AppConfig } from "../config/index.js";

export const applyModelAlias = (body: any, cfg: AppConfig): void => {
  if (body && typeof body.model === "string") body.model = cfg.modelAliases[body.model] ?? body.model;
  else if (body && body.model == null && cfg.defaultModel) body.model = cfg.defaultModel;
};

export const utcDayStartMs = (now = Date.now()): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export const sha256Hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
