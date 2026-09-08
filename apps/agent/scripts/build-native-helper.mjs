import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Skipping macOS native helper build on non-darwin platform.");
  process.exit(0);
}

const source = fileURLToPath(new URL("../native/TouchBarMacHelper.swift", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../native/.build/", import.meta.url));
const output = fileURLToPath(new URL("../native/.build/touchbar-mac-helper", import.meta.url));
mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync("/usr/bin/xcrun", [
  "swiftc",
  source,
  "-o",
  output,
  "-framework",
  "AppKit",
  "-framework",
  "ApplicationServices",
], { stdio: "inherit" });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Built native helper: ${output}`);
