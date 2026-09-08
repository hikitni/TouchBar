import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { DeviceRecord } from "@touchbar/protocol";

interface DeviceFile {
  version: 1;
  devices: DeviceRecord[];
}

export interface DeviceStoreOptions {
  filePath?: string;
  now?: () => Date;
  tokenFactory?: () => string;
}

export interface IssuedDeviceToken {
  device: DeviceRecord;
  token: string;
}

export const defaultDeviceFilePath = join(homedir(), ".http-touchbar", "devices.json");

export class DeviceStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private devices = new Map<string, DeviceRecord>();
  private initialized = false;

  public constructor(options: DeviceStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultDeviceFilePath;
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  public async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (!isDeviceFile(parsed)) {
        throw new Error("expected a versioned device list");
      }
      this.devices = new Map(parsed.devices.map((device) => [device.id, device]));
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        await this.persist();
      } else {
        throw new Error(`Unable to load device tokens from ${this.filePath}: ${errorMessage(error)}`);
      }
    }
    this.initialized = true;
  }

  public async issue(deviceId: string, name: string): Promise<IssuedDeviceToken> {
    this.requireInitialized();
    const timestamp = this.now().toISOString();
    const token = this.tokenFactory();
    const device: DeviceRecord = {
      id: deviceId,
      name,
      tokenHash: hashToken(token),
      createdAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.devices.set(deviceId, device);
    await this.persist();
    return { device, token };
  }

  public async authenticate(token: string, expectedDeviceId?: string): Promise<DeviceRecord | undefined> {
    this.requireInitialized();
    const hash = hashToken(token);
    const candidates = expectedDeviceId
      ? [this.devices.get(expectedDeviceId)].filter((device): device is DeviceRecord => device !== undefined)
      : [...this.devices.values()];
    const device = candidates.find((candidate) => secureHashEquals(candidate.tokenHash, hash));
    if (!device) {
      return undefined;
    }

    const updated = { ...device, lastSeenAt: this.now().toISOString() };
    this.devices.set(updated.id, updated);
    await this.persist();
    return updated;
  }

  public async list(): Promise<DeviceRecord[]> {
    this.requireInitialized();
    return [...this.devices.values()].map((device) => ({ ...device }));
  }

  public async revoke(deviceId: string): Promise<boolean> {
    this.requireInitialized();
    const deleted = this.devices.delete(deviceId);
    if (deleted) {
      await this.persist();
    }
    return deleted;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const payload: DeviceFile = { version: 1, devices: [...this.devices.values()] };
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("DeviceStore.init() must be called before use");
    }
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function secureHashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isDeviceFile(value: unknown): value is DeviceFile {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<DeviceFile>;
  return data.version === 1 && Array.isArray(data.devices) && data.devices.every(isDeviceRecord);
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== "object") return false;
  const device = value as Partial<DeviceRecord>;
  return [device.id, device.name, device.tokenHash, device.createdAt, device.lastSeenAt].every(
    (field) => typeof field === "string",
  );
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
