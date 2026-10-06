import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import type { MatrixConfig } from "./types.js";

export const DEFAULT_CONFIG: MatrixConfig = {
  homeserver: process.env.MATRIX_HOMESERVER || "",
  accessToken: process.env.MATRIX_ACCESS_TOKEN || "",
  accessTokenPath:
    process.env.MATRIX_ACCESS_TOKEN_PATH ||
    path.join(getHomeDir(), ".config/matrix/token"),
  botUserId: process.env.MATRIX_BOT_USER_ID || "",
  allowedUsers: process.env.MATRIX_ALLOWED_USERS
    ? process.env.MATRIX_ALLOWED_USERS.split(",").map((u) => u.trim())
    : [],
  autoStart: true,
  useSubagent: false,
  subagentRole: "delegate",
  progressCooldownSeconds: 5,
  progressMode: "edit",
};

export function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}

export function getSyncTokenPath(): string {
  return path.join(getHomeDir(), ".pi/agent/matrix_sync_token");
}

export function getMediaDir(): string {
  const dir = path.join(getHomeDir(), ".pi/agent/media");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function loadConfig(): MatrixConfig {
  const primaryPath = path.join(getHomeDir(), ".pi/agent/matrix.json");
  const fallbackPath = path.join(getHomeDir(), ".config/matrix/config.json");
  const configPath = fs.existsSync(primaryPath) ? primaryPath : fallbackPath;

  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      cfg = { ...cfg, ...data };
    } catch {
      // Fallback to defaults
    }
  }
  if (!cfg.accessToken && process.env.MATRIX_ACCESS_TOKEN) {
    cfg.accessToken = process.env.MATRIX_ACCESS_TOKEN;
  }
  if (!cfg.homeserver && process.env.MATRIX_HOMESERVER) {
    cfg.homeserver = process.env.MATRIX_HOMESERVER;
  }
  if (!cfg.botUserId && process.env.MATRIX_BOT_USER_ID) {
    cfg.botUserId = process.env.MATRIX_BOT_USER_ID;
  }

  // Check common secret paths
  const candidateTokenPaths = [
    cfg.accessTokenPath,
    path.join(getHomeDir(), ".config/matrix/token"),
    path.join(getHomeDir(), ".config/sops-nix/secrets/matrix-access-token"),
    "/run/secrets/matrix-access-token",
  ].filter(Boolean) as string[];

  if (!cfg.accessToken) {
    for (const p of candidateTokenPaths) {
      if (fs.existsSync(p)) {
        try {
          const val = fs.readFileSync(p, "utf-8").trim();
          if (val) {
            cfg.accessToken = val;
            break;
          }
        } catch {
          // Ignore read errors
        }
      }
    }
  }

  // If no access token is configured at all, do not autoStart to prevent error notifications
  if (!cfg.accessToken) {
    cfg.autoStart = false;
  }

  return cfg;
}

export function loadSavedSyncToken(): string | null {
  const tokenFile = getSyncTokenPath();
  try {
    if (fs.existsSync(tokenFile)) {
      const token = fs.readFileSync(tokenFile, "utf-8").trim();
      return token.length > 0 ? token : null;
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

export function saveSyncToken(token: string | null): void {
  if (!token) return;
  try {
    const tokenFile = getSyncTokenPath();
    fs.writeFileSync(tokenFile, token.trim(), "utf-8");
  } catch {
    // Ignore write errors
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function sendDesktopNotification(title: string, message: string): void {
  execFile(
    "notify-send",
    ["-a", "Matrix Bridge", "-u", "normal", "-t", "5000", title, message],
    () => {},
  );
}
