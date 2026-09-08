import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const defaultAdminTokenPath = join(homedir(), ".http-touchbar", "admin-token");

export async function loadOrCreateAdminToken(filePath = defaultAdminTokenPath): Promise<string> {
  try {
    return normalizeToken(await readFile(filePath, "utf8"));
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
  }

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(filePath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
    return normalizeToken(await readFile(filePath, "utf8"));
  }
  await chmod(filePath, 0o600);
  return token;
}

export async function readAdminToken(filePath = defaultAdminTokenPath): Promise<string> {
  return normalizeToken(await readFile(filePath, "utf8"));
}

function normalizeToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error("The local admin token file is invalid. Delete it and restart the Agent.");
  }
  return token;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
