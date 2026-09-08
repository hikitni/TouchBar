import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { touchBarConfigSchema, type TouchBarConfig } from "@touchbar/protocol";

export class ConfigError extends Error {
  public constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ConfigError";
  }
}

export const defaultConfigPath = fileURLToPath(new URL("../config/default.json", import.meta.url));

export function validateConfig(value: unknown): TouchBarConfig {
  const parsed = touchBarConfigSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("; ");
  throw new ConfigError(`Invalid Touch Bar configuration: ${details}`);
}

export async function loadConfig(configPath = defaultConfigPath): Promise<TouchBarConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ConfigError(`Unable to read configuration at ${configPath}`, error);
  }

  try {
    return validateConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Configuration at ${configPath} is not valid JSON`, error);
  }
}
