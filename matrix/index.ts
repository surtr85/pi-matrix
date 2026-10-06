/**
 * Matrix Bridge Extension for Pi Coding Agent (v2.5 Modular Architecture)
 *
 * Dedicated high-performance, token-efficient, zero-cost bridge between Matrix and Pi:
 * - Security First: Zero hardcoded credentials; reads strictly from ~/.pi/agent/matrix.json or environment variables.
 * - Concurrency Safe: Turn Queue (FIFO) mapping each turn to its exact roomId, triggerEventId, and sender.
 * - Outbound Media Uplink: Auto-uploads generated media (images, svg, plots, pdf) & files to Matrix media repo.
 * - Slash Commands: /new, /status, /model, /thinking, /compact, /abort, /sh, /upload, /help.
 * - Interactive Abort: Immediate cancellation via /abort or 🛑 reaction without queue lag.
 * - Direct Shell Execution: /sh <cmd> executes host commands without consuming LLM tokens.
 * - PDU Overflow Protection: Automatic chunking of long messages (>4000 chars) to prevent M_TOO_LARGE errors.
 * - Multimodal Native Vision & Attachments: Images, Videos, Audio, Documents with disk caching.
 * - Intelligent Batch Coalescing: Seamlessly joins text captions + media events.
 * - In-place Matrix live status updates via m.replace (MSC2676) and automatic cleanup on completion.
 * - Enhanced Markdown-to-HTML converter with Persian BiDi (RTL for Persian, LTR for code, links, lists, headers).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
  TurnStartEvent,
  TurnEndEvent,
  SessionStartEvent,
  SessionShutdownEvent,
  ModelSelectEvent,
  BeforeAgentStartEvent,
  ContextEvent,
} from "@earendil-works/pi-coding-agent";

import {
  loadConfig,
  saveSyncToken,
  loadSavedSyncToken,
  formatFileSize,
  sendDesktopNotification,
} from "./src/config.js";
import { MatrixApiClient } from "./src/api.js";
import { MatrixQueue } from "./src/queue.js";
import { MatrixProgressReporter } from "./src/progress.js";
import { BoundedEventCache } from "./src/cache.js";
import { handleMatrixCommand } from "./src/commands.js";
import type { PendingTurn } from "./src/types.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  let isPolling = false;
  let abortController: AbortController | null = null;
  let lastSyncBatch: string | null = loadSavedSyncToken();
  let latestContext: ExtensionContext | null = null;

  const api = new MatrixApiClient(config);
  const queue = new MatrixQueue();
  const progressReporter = new MatrixProgressReporter(api, config);
  const processedEventIds = new BoundedEventCache(1000);
  const createdMediaFiles: string[] = [];

  // Register internal bridge commands with unique names to avoid collisions
  pi.registerCommand("matrix_new_session", {
    description: "Start a new session from Matrix bridge",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.registerCommand("matrix_compact_session", {
    description: "Compact context from Matrix bridge",
    handler: async (args, ctx) => {
      ctx.compact(args ? { customInstructions: args } : undefined);
    },
  });

  pi.registerCommand("reload_session", {
    description: "Reload Pi runtime from Matrix bridge",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  const handleInvites = async (invites: Record<string, any>) => {
    for (const roomId of Object.keys(invites)) {
      try {
        const inviteEvents = invites[roomId]?.invite_state?.events || [];
        const joinRule = inviteEvents.find(
          (e: any) =>
            e.type === "m.room.member" && e.state_key === config.botUserId,
        );
        const inviter = joinRule?.sender;

        if (
          inviter &&
          (config.allowedUsers.length === 0 ||
            config.allowedUsers.includes(inviter))
        ) {
          await api.joinRoom(roomId);
        }
      } catch {
        // Ignore join errors
      }
    }
  };

  const syncLoop = async (ctx?: ExtensionContext) => {
    if (isPolling) return;
    if (ctx) latestContext = ctx;

    if (!config.homeserver || !config.accessToken) {
      const refreshed = loadConfig();
      if (refreshed.accessToken) {
        config.accessToken = refreshed.accessToken;
        api.updateConfig(config);
        progressReporter.updateConfig(config);
      }
      if (refreshed.homeserver) {
        config.homeserver = refreshed.homeserver;
        api.updateConfig(config);
        progressReporter.updateConfig(config);
      }
    }

    if (!config.homeserver || !config.accessToken) {
      if (ctx?.hasUI) {
        ctx.ui.notify(
          "Matrix Bridge: homeserver or accessToken is not configured in ~/.pi/agent/matrix.json",
          "error",
        );
      }
      return;
    }

    isPolling = true;
    abortController = new AbortController();

    // Catch-up sync (timeout=0) if no saved token
    if (!lastSyncBatch) {
      try {
        const initialRes = await fetch(
          `${config.homeserver}/_matrix/client/v3/sync?timeout=0`,
          {
            headers: { Authorization: `Bearer ${config.accessToken}` },
            signal: abortController.signal,
          },
        );
        if (initialRes.ok) {
          const initialData = await initialRes.json();
          if (initialData.next_batch) {
            lastSyncBatch = initialData.next_batch;
            saveSyncToken(lastSyncBatch);
          }
        }
      } catch {
        // Fallback to regular sync
      }
    }

    if (ctx?.hasUI) {
      ctx.ui.notify(
        `Matrix Bridge connected (${config.useSubagent ? `Subagent: ${config.subagentRole}` : "Direct Mode"})`,
        "info",
      );
    }

    while (isPolling) {
      try {
        const syncUrl = new URL(`${config.homeserver}/_matrix/client/v3/sync`);
        syncUrl.searchParams.set("timeout", "30000");
        if (lastSyncBatch) {
          syncUrl.searchParams.set("since", lastSyncBatch);
        }

        const res = await fetch(syncUrl.toString(), {
          headers: { Authorization: `Bearer ${config.accessToken}` },
          signal: abortController?.signal,
        });

        if (!res.ok) {
          let waitMs = 5000;
          if (res.status === 429) {
            try {
              const errJson = await res.json();
              if (errJson.retry_after_ms) {
                waitMs = errJson.retry_after_ms;
              }
            } catch {}
          }
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        const data = await res.json();

        if (data.rooms?.invite) {
          await handleInvites(data.rooms.invite);
        }

        const joinedRooms = data.rooms?.join || {};
        for (const roomId of Object.keys(joinedRooms)) {
          const events = joinedRooms[roomId]?.timeline?.events || [];

          // 1. Check for Abort Reactions (🛑 or ⏹️)
          for (const ev of events) {
            if (
              ev.type === "m.reaction" &&
              !processedEventIds.has(ev.event_id) &&
              (config.allowedUsers.length === 0 ||
                config.allowedUsers.includes(ev.sender))
            ) {
              processedEventIds.add(ev.event_id);
              const rel = ev.content?.["m.relates_to"];
              if (rel?.rel_type === "m.annotation") {
                const key = rel.key;
                const targetEventId = rel.event_id;
                if (key === "🛑" || key === "⏹️") {
                  if (queue.matchesTarget(targetEventId) || progressReporter.matchesMessageId(targetEventId)) {
                    if (latestContext && typeof latestContext.abort === "function") {
                      latestContext.abort();
                    }
                    api.stopTypingLoop();
                    await progressReporter.cleanup();
                    queue.clear();
                    createdMediaFiles.length = 0;

                    await api.sendMessage(
                      roomId,
                      "🛑 **Agent task cancelled via reaction.**",
                      targetEventId,
                    );
                  }
                }
              }
            }
          }

          // 2. Filter incoming message events from allowed users
          const candidateEvents = events.filter(
            (ev: any) =>
              ev.type === "m.room.message" &&
              ev.sender !== config.botUserId &&
              !processedEventIds.has(ev.event_id) &&
              (config.allowedUsers.length === 0 ||
                config.allowedUsers.includes(ev.sender)),
          );

          for (let i = 0; i < candidateEvents.length; i++) {
            const ev = candidateEvents[i];
            processedEventIds.add(ev.event_id);

            const msgtype = ev.content?.msgtype;
            const rawBody = ev.content?.body || "";
            const mediaUrl = ev.content?.url || ev.content?.file?.url;

            // 1. Send read receipt & react with '👀'
            api.sendReadReceipt(roomId, ev.event_id);
            api.sendReaction(roomId, ev.event_id, "👀");

            // 2. Desktop notification
            const notifTitle = `Matrix: ${ev.sender}`;
            const notifBody = mediaUrl
              ? `📎 [${msgtype || "Media attachment"}] ${rawBody}`
              : rawBody;
            sendDesktopNotification(notifTitle, notifBody.slice(0, 100));

            // 3. Handle commands directly
            if (typeof rawBody === "string" && rawBody.trim().startsWith("/")) {
              const handled = await handleMatrixCommand(
                roomId,
                rawBody.trim(),
                ev.sender,
                ev.event_id,
                latestContext,
                pi,
                api,
                queue,
                progressReporter,
                config,
                isPolling,
              );
              if (handled) {
                continue;
              }
            }

            // 4. Intelligent Batch Coalescing: Check for following media event
            let coalescedCaption = rawBody;
            let targetEv = ev;

            if (msgtype === "m.text" && i + 1 < candidateEvents.length) {
              const nextEv = candidateEvents[i + 1];
              const nextMediaUrl =
                nextEv.content?.url || nextEv.content?.file?.url;
              if (nextMediaUrl && nextEv.sender === ev.sender) {
                coalescedCaption = rawBody;
                targetEv = nextEv;
                i++; // Skip merged event
                processedEventIds.add(nextEv.event_id);
                api.sendReadReceipt(roomId, nextEv.event_id);
                api.sendReaction(roomId, nextEv.event_id, "👀");
              }
            }

            // 5. Enqueue Turn into Concurrency-Safe Queue
            const threadId = targetEv.content?.["m.relates_to"]?.rel_type === "m.thread"
              ? targetEv.content?.["m.relates_to"]?.event_id
              : undefined;

            const turn: PendingTurn = {
              id: api.makeTxnId(),
              roomId,
              triggerEventId: targetEv.event_id,
              threadId,
              sender: targetEv.sender,
              timestamp: Date.now(),
            };
            queue.enqueue(turn);

            api.startTypingLoop(roomId);

            const targetMsgType = targetEv.content?.msgtype;
            const targetMediaUrl =
              targetEv.content?.url || targetEv.content?.file?.url;
            const targetBody = targetEv.content?.body || "";

            // Handle Media Types: Images, Videos, Audio, Files
            if (targetMediaUrl) {
              const downloaded = await api.downloadMedia(
                targetMediaUrl,
                targetBody || "attachment",
              );

              if (downloaded) {
                const trimmedBody = (targetBody || "").trim();
                const trimmedCoalesced = (coalescedCaption || "").trim();

                const isGenericFilename = (name: string) =>
                  /^(image|screenshot|photo|file|media|pasted\s*image|attachment|\d+|[a-f0-9_-]{8,})[._0-9a-z]*$/i.test(
                    name,
                  ) ||
                  name === downloaded.filename ||
                  name === "image.png" ||
                  name === "file";

                let userPromptText = "";
                if (trimmedCoalesced && trimmedCoalesced !== trimmedBody) {
                  userPromptText = trimmedCoalesced;
                } else if (trimmedBody && !isGenericFilename(trimmedBody)) {
                  userPromptText = trimmedBody;
                } else if (trimmedCoalesced && !isGenericFilename(trimmedCoalesced)) {
                  userPromptText = trimmedCoalesced;
                }

                const promptHeader = userPromptText
                  ? `${userPromptText}\n\n`
                  : "";

                if (targetMsgType === "m.image") {
                  const textPrompt = `<!-- matrix-turn:${turn.id} -->\n${promptHeader}[Attached image: ${downloaded.filename} (${formatFileSize(downloaded.sizeBytes)}) saved at ${downloaded.localPath}]`;

                  pi.sendUserMessage(
                    [
                      { type: "text", text: textPrompt },
                      {
                        type: "image",
                        data: downloaded.data,
                        mimeType: downloaded.mimeType,
                      },
                    ],
                    { deliverAs: "followUp" },
                  );
                  continue;
                } else if (targetMsgType === "m.video") {
                  const textPrompt = `<!-- matrix-turn:${turn.id} -->\n${promptHeader}[Attached video: ${downloaded.filename} (${formatFileSize(downloaded.sizeBytes)}) saved at ${downloaded.localPath}]`;

                  pi.sendUserMessage(textPrompt, { deliverAs: "followUp" });
                  continue;
                } else if (targetMsgType === "m.audio") {
                  const textPrompt = `<!-- matrix-turn:${turn.id} -->\n${promptHeader}[Attached audio: ${downloaded.filename} (${formatFileSize(downloaded.sizeBytes)}) saved at ${downloaded.localPath}]`;

                  pi.sendUserMessage(textPrompt, { deliverAs: "followUp" });
                  continue;
                } else {
                  let snippet = "";
                  if (
                    downloaded.mimeType.startsWith("text/") ||
                    downloaded.filename.match(
                      /\.(ts|js|py|go|rs|nix|json|yaml|yml|md|txt|sh|csv)$/i,
                    )
                  ) {
                    if (downloaded.sizeBytes < 64 * 1024) {
                      snippet = `\nFile preview:\n\`\`\`\n${downloaded.buffer.toString("utf-8").slice(0, 2000)}\n\`\`\``;
                    }
                  }

                  const textPrompt = `<!-- matrix-turn:${turn.id} -->\n${promptHeader}[Attached file: ${downloaded.filename} (${downloaded.mimeType}, ${formatFileSize(downloaded.sizeBytes)}) saved at ${downloaded.localPath}]${snippet}`;

                  pi.sendUserMessage(textPrompt, { deliverAs: "followUp" });
                  continue;
                }
              }
            }

            // Normal text injection: clean, direct, with deliverAs: "followUp"
            if (
              typeof coalescedCaption === "string" &&
              coalescedCaption.trim().length > 0
            ) {
              const baseText = config.useSubagent
                ? `[Matrix @${ev.sender}]:\n${coalescedCaption}\n\n[Instruction: Delegate to ${config.subagentRole} subagent and return final answer.]`
                : coalescedCaption;
              const fullPrompt = `<!-- matrix-turn:${turn.id} -->\n${baseText}`;
              pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" });
            }
          }
        }

        if (data.next_batch) {
          lastSyncBatch = data.next_batch;
          saveSyncToken(lastSyncBatch);
        }
      } catch (err: any) {
        if (err?.name === "AbortError" || !isPolling) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };

  const stopSyncLoop = (ctx?: ExtensionContext) => {
    isPolling = false;
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    api.stopTypingLoop();
    progressReporter.reset();
    if (ctx?.hasUI) ctx.ui.notify("Matrix bridge stopped", "info");
  };

  // --- Pi Lifecycle Hooks ---

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    latestContext = ctx;
    if (config.autoStart && !isPolling) {
      syncLoop(ctx);
    }
  });

  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    stopSyncLoop(ctx);
  });

  pi.on("model_select", async (_event: ModelSelectEvent, ctx: ExtensionContext) => {
    latestContext = ctx;
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    latestContext = ctx;
    const match = event.prompt.match(/<!--\s*matrix-turn:([^\s>]+)\s*-->/);
    if (match) {
      const turnId = match[1];
      const turn = queue.getById(turnId);
      if (turn) {
        queue.setActiveTurn(turn);
        progressReporter.start(turn.roomId, turn.triggerEventId);
        progressReporter.report("🧠 Thinking...");
      }
    }
  });

  pi.on("context", async (event: ContextEvent) => {
    for (const msg of event.messages) {
      if (msg.role === "user" && typeof msg.content === "string") {
        msg.content = msg.content.replace(/<!--\s*matrix-turn:[^\s>]+\s*-->\n?/, "");
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            part.text = part.text.replace(/<!--\s*matrix-turn:[^\s>]+\s*-->\n?/, "");
          }
        }
      }
    }
  });

  pi.on("turn_start", async (_event: TurnStartEvent, ctx: ExtensionContext) => {
    latestContext = ctx;
    const active = queue.getActiveTurn();
    if (active) {
      progressReporter.report("🧠 Thinking...");
    }
  });

  pi.on("tool_execution_start", async (event: ToolExecutionStartEvent) => {
    const active = queue.getActiveTurn();
    if (!active) return;

    let desc = "";
    switch (event.toolName) {
      case "bash": {
        const cmd = event.args?.command
          ? ` \`${event.args.command.slice(0, 60)}\``
          : "";
        desc = `⚙️ Running bash:${cmd}`;
        break;
      }
      case "read": {
        const p = event.args?.path
          ? ` \`${path.basename(event.args.path)}\``
          : "";
        desc = `📖 Reading${p}`;
        break;
      }
      case "edit":
      case "write": {
        const p = event.args?.path
          ? ` \`${path.basename(event.args.path)}\``
          : "";
        desc = `✏️ Editing${p}`;
        break;
      }
      case "grep":
      case "find":
      case "ls": {
        desc = `🔍 Searching paths (${event.toolName})`;
        break;
      }
      default: {
        desc = `🔧 Executing tool \`${event.toolName}\``;
        break;
      }
    }

    progressReporter.report(desc);
  });

  pi.on("tool_execution_end", async (event: ToolExecutionEndEvent) => {
    if (queue.getActiveTurn() && event.isError) {
      progressReporter.report(`⚠️ Error executing \`${event.toolName}\``);
    }

    // Auto-detect media files created by tools
    if (!event.isError && event.toolName === "write" && event.args?.path) {
      const p = String(event.args.path);
      const ext = path.extname(p).toLowerCase();
      if (
        [".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".pdf"].includes(ext)
      ) {
        createdMediaFiles.push(p);
      }
    }
  });

  pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
    latestContext = ctx;
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    latestContext = ctx;
    const activeTurn = queue.getActiveTurn();

    if (!activeTurn) {
      return;
    }

    const { roomId, triggerEventId, id: turnId } = activeTurn;

    try {
      const assistantMessages = event.messages.filter(
        (m) => m.role === "assistant",
      );
      const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];

      if (lastAssistantMsg) {
        let text = "";
        if (typeof lastAssistantMsg.content === "string") {
          text = lastAssistantMsg.content;
        } else if (Array.isArray(lastAssistantMsg.content)) {
          text = lastAssistantMsg.content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join("\n");
        }

        if (text) {
          const sentEventId = await api.sendMessage(
            roomId,
            text,
            triggerEventId,
            activeTurn.threadId,
          );

          if (sentEventId) {
            api.sendReaction(roomId, triggerEventId, "✅");

            if (createdMediaFiles.length > 0) {
              const filesToSend = [...createdMediaFiles];
              createdMediaFiles.length = 0;
              for (const filePath of filesToSend) {
                if (fs.existsSync(filePath)) {
                  await api.sendMedia(roomId, filePath, sentEventId, activeTurn.threadId);
                }
              }
            }

            sendDesktopNotification(
              "Matrix Bridge",
              "Pi response delivered to Matrix 🚀",
            );

            if (ctx.hasUI) {
              ctx.ui.notify("Delivered response to Matrix room", "info");
            }
          }
        }
      }
    } finally {
      await progressReporter.cleanup();
      queue.removeTurn(turnId);
      queue.clearActiveTurn();
      if (queue.isEmpty()) {
        api.stopTypingLoop();
      }
    }
  });

  // TUI Command: /matrix
  pi.registerCommand("matrix", {
    description: "Manage Matrix Bridge (/matrix [start|stop|send <msg>|status])",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() || "";
      const [cmd, ...rest] = trimmed.split(" ");
      const subarg = rest.join(" ").trim();

      if (cmd === "start" || cmd === "on") {
        if (isPolling) {
          ctx.ui.notify("Matrix bridge is already running", "info");
        } else {
          syncLoop(ctx);
          ctx.ui.notify("Matrix bridge listener started", "info");
        }
      } else if (cmd === "stop" || cmd === "off") {
        stopSyncLoop(ctx);
      } else if (cmd === "send") {
        if (!subarg) {
          ctx.ui.notify("Usage: /matrix send <message>", "warning");
          return;
        }
        const targetRoom = queue.getActiveTurn()?.roomId;
        if (!targetRoom) {
          ctx.ui.notify("No active Matrix room set", "error");
          return;
        }
        const ok = await api.sendMessage(targetRoom, subarg);
        if (ok) {
          ctx.ui.notify("Message sent to Matrix room", "info");
        } else {
          ctx.ui.notify("Failed to send message to Matrix", "error");
        }
      } else {
        const statusLines = [
          `📡 Status: ${isPolling ? "🟢 Connected & Listening" : "🔴 Stopped"}`,
          `🚀 Mode: ${config.useSubagent ? `Subagent (${config.subagentRole})` : "Direct (Zero Token Bloat)"}`,
          `🏠 Homeserver: ${config.homeserver || "Not configured"}`,
          `🤖 Bot User: ${config.botUserId || "Not configured"}`,
          `💬 Active Queue: ${queue.length} turns`,
          `⏱️ Progress Cooldown: ${config.progressCooldownSeconds}s (${config.progressMode})`,
          `👥 Allowed Users: ${config.allowedUsers.join(", ") || "All"}`,
        ].join("\n");
        ctx.ui.notify(statusLines, "info");
      }
    },
  });

  // Auto-start fallback
  if (config.autoStart) {
    setTimeout(() => {
      if (!isPolling && latestContext) {
        syncLoop(latestContext);
      }
    }, 1000);
  }
}
