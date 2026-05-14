import type {
  ApprovalDecisionKind,
  ApprovalKind,
  CodexLinkEvent,
  ItemId,
  ProjectId,
  RequestId,
  ThreadId,
  TurnId,
  TurnStatus,
} from "@codex-link/protocol/session";
import type { JsonRpcNotification, JsonRpcServerRequest } from "@codex-link/codex-client";

export function codexNotificationToEvents(
  message: JsonRpcNotification,
  projectId: ProjectId,
): CodexLinkEvent[] {
  const params = objectValue(message.params);
  if (!params) {
    return [];
  }

  if (message.method === "thread/started") {
    const thread = objectValue(params.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) {
      return [];
    }
    return [
      {
        type: "thread.started",
        thread: {
          id: threadId as ThreadId,
          projectId,
          title: stringValue(thread?.name) ?? stringValue(thread?.preview) ?? null,
          updatedAt: thread ? threadUpdatedAt(thread) : null,
        },
      },
    ];
  }

  if (message.method === "turn/started" || message.method === "turn/completed") {
    const turn = objectValue(params.turn);
    const threadId = stringValue(params.threadId) ?? stringValue(turn?.threadId);
    const turnId = stringValue(turn?.id);
    if (!threadId || !turnId) {
      return [];
    }
    return [
      {
        type: "turn.status.changed",
        threadId: threadId as ThreadId,
        turnId: turnId as TurnId,
        status: codexTurnStatusToLinkStatus(stringValue(turn?.status)),
      },
    ];
  }

  if (message.method === "item/agentMessage/delta") {
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const text = stringValue(params.delta);
    if (!threadId || !turnId || !text) {
      return [];
    }
    return [
      {
        type: "assistant.delta",
        threadId: threadId as ThreadId,
        turnId: turnId as TurnId,
        text,
      },
    ];
  }

  if (message.method === "item/started") {
    const item = objectValue(params.item);
    const itemId = stringValue(item?.id);
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    if (!itemId || !threadId || !turnId) {
      return [];
    }
    return [
      {
        type: "timeline.item.started",
        threadId: threadId as ThreadId,
        turnId: turnId as TurnId,
        itemId: itemId as ItemId,
        label: itemLabel(item),
      },
    ];
  }

  if (message.method === "item/fileChange/patchUpdated") {
    const itemId = stringValue(params.itemId);
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    if (!itemId || !threadId || !turnId) {
      return [];
    }
    const event: Extract<CodexLinkEvent, { type: "timeline.item.started" }> = {
      type: "timeline.item.started",
      threadId: threadId as ThreadId,
      turnId: turnId as TurnId,
      itemId: itemId as ItemId,
      label: "File change",
    };
    const detail = fileChangesDetail(params.changes);
    if (detail) {
      event.detail = detail;
    }
    return [event];
  }

  if (message.method === "item/completed") {
    const item = objectValue(params.item);
    const itemId = stringValue(item?.id);
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    if (!itemId || !threadId || !turnId) {
      return [];
    }
    const events: CodexLinkEvent[] = [
      {
        type: "timeline.item.completed",
        threadId: threadId as ThreadId,
        turnId: turnId as TurnId,
        itemId: itemId as ItemId,
        status: itemCompletedStatus(item),
      },
    ];
    const transcriptEvent = itemToTranscriptEvent(item, threadId, turnId);
    if (transcriptEvent) {
      events.push(transcriptEvent);
    }
    const finalEvent = itemToFinalEvent(item, threadId, turnId);
    if (finalEvent) {
      events.push(finalEvent);
    }
    return events;
  }

  if (message.method === "error") {
    const messageText = stringValue(params.message) ?? JSON.stringify(params);
    return [{ type: "error.reported", scope: "codex", message: messageText }];
  }

  const diagnostic = codexDiagnosticNotificationToEvent(message);
  if (diagnostic) {
    return [diagnostic];
  }

  return [];
}

export function codexDiagnosticNotificationToEvent(
  message: JsonRpcNotification,
): CodexLinkEvent | null {
  const params = objectValue(message.params);
  if (!params) {
    return null;
  }

  if (
    message.method === "warning" ||
    message.method === "guardianWarning" ||
    message.method === "configWarning"
  ) {
    return diagnosticEvent("warning", diagnosticMessage(params));
  }

  if (message.method === "deprecationNotice") {
    return diagnosticEvent("info", diagnosticMessage(params));
  }

  if (message.method === "mcpServer/startupStatus/updated") {
    const status = stringValue(params.status) ?? stringValue(params.state);
    const serverName = stringValue(params.serverName) ?? stringValue(params.name) ?? "MCP server";
    const messageText = [serverName, status].filter(Boolean).join(": ");
    return diagnosticEvent("info", messageText || JSON.stringify(params));
  }

  return null;
}

export function threadReadResponseToEvents(
  response: unknown,
  projectId: ProjectId,
): CodexLinkEvent[] {
  const thread = objectValue(objectValue(response)?.thread);
  return thread ? threadToEvents(thread, projectId) : [];
}

export function threadListResponseToEvents(
  response: unknown,
  projectId: ProjectId,
): CodexLinkEvent[] {
  const data = objectValue(response)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((thread) => {
    const threadObject = objectValue(thread);
    return threadObject ? threadToStartedEvent(threadObject, projectId) : [];
  });
}

export function threadTurnsListResponseToEvents(
  response: unknown,
  projectId: ProjectId,
  threadId: ThreadId,
): CodexLinkEvent[] {
  const data = objectValue(response)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((turn) => {
    const turnObject = objectValue(turn);
    return turnObject ? turnToEvents(turnObject, String(threadId), projectId) : [];
  });
}

export interface CodexServerRequestContext {
  activeTurnIdForThread?(threadId: string): string | undefined;
}

export function codexServerRequestToEvent(
  message: JsonRpcServerRequest,
  context: CodexServerRequestContext = {},
): CodexLinkEvent | null {
  const params = objectValue(message.params);
  if (!params) {
    return null;
  }

  if (message.method === "item/commandExecution/requestApproval") {
    const kind: ApprovalKind = objectValue(params.networkApprovalContext)
      ? "network"
      : "command_execution";
    return approvalEvent({
      id: String(message.id) as RequestId,
      kind,
      threadId: stringValue(params.threadId),
      turnId: stringValue(params.turnId),
      itemId: stringValue(params.itemId),
      title: kind === "network" ? "Network approval" : "Command approval",
      detail: commandApprovalDetail(params),
      availableDecisions: decisionsFromCodex(params.availableDecisions),
    });
  }

  if (message.method === "item/fileChange/requestApproval") {
    return approvalEvent({
      id: String(message.id) as RequestId,
      kind: "file_change",
      threadId: stringValue(params.threadId),
      turnId: stringValue(params.turnId),
      itemId: stringValue(params.itemId),
      title: "File change approval",
      detail: fileChangeApprovalDetail(params),
      availableDecisions: ["accept", "decline"],
    });
  }

  if (message.method === "item/permissions/requestApproval") {
    return approvalEvent({
      id: String(message.id) as RequestId,
      kind: objectValue(objectValue(params.permissions)?.network) ? "network" : "command_execution",
      threadId: stringValue(params.threadId),
      turnId: stringValue(params.turnId),
      itemId: stringValue(params.itemId),
      title: "Permission approval",
      detail: permissionsApprovalDetail(params),
      availableDecisions: ["accept", "decline"],
    });
  }

  if (message.method === "item/tool/requestUserInput") {
    return approvalEvent({
      id: String(message.id) as RequestId,
      kind: "user_input",
      threadId: stringValue(params.threadId),
      turnId: stringValue(params.turnId),
      itemId: stringValue(params.itemId),
      title: "User input requested",
      detail: JSON.stringify(params.questions ?? []),
      availableDecisions: ["accept", "cancel"],
    });
  }

  if (message.method === "execCommandApproval") {
    const threadId = stringValue(params.conversationId);
    const command = Array.isArray(params.command) ? params.command.map(String).join(" ") : "";
    const reason = stringValue(params.reason);
    return approvalEvent({
      id: String(message.id) as RequestId,
      kind: "command_execution",
      threadId,
      turnId: threadId ? context.activeTurnIdForThread?.(threadId) : undefined,
      itemId: stringValue(params.callId),
      title: "Command approval",
      detail: reason ? `${command}\n${reason}` : command,
      availableDecisions: ["accept", "accept_for_session", "decline"],
    });
  }

  if (message.method === "applyPatchApproval") {
    const threadId = stringValue(params.conversationId);
    const fileChanges = objectValue(params.fileChanges) ?? {};
    const filePaths = Object.keys(fileChanges).join(", ");
    const reason = stringValue(params.reason);
    return approvalEvent({
      id: String(message.id) as RequestId,
      kind: "file_change",
      threadId,
      turnId: threadId ? context.activeTurnIdForThread?.(threadId) : undefined,
      itemId: stringValue(params.callId),
      title: "File change approval",
      detail: reason ? `${filePaths}\n${reason}` : filePaths,
      availableDecisions: ["accept", "accept_for_session", "decline"],
    });
  }

  return null;
}

function threadToEvents(thread: Record<string, unknown>, projectId: ProjectId): CodexLinkEvent[] {
  const threadId = stringValue(thread.id);
  if (!threadId) {
    return [];
  }
  const events: CodexLinkEvent[] = [threadToStartedEvent(thread, projectId)];
  const turns = thread.turns;
  if (Array.isArray(turns)) {
    for (const turn of turns) {
      const turnObject = objectValue(turn);
      if (turnObject) {
        events.push(...turnToEvents(turnObject, threadId, projectId));
      }
    }
  }
  return events;
}

function threadToStartedEvent(
  thread: Record<string, unknown>,
  projectId: ProjectId,
): CodexLinkEvent {
  const threadId = stringValue(thread.id);
  if (!threadId) {
    throw new Error("Codex thread object did not include id");
  }
  return {
    type: "thread.started",
    thread: {
      id: threadId as ThreadId,
      projectId,
      title: stringValue(thread.name) ?? stringValue(thread.preview) ?? null,
      updatedAt: threadUpdatedAt(thread),
    },
  };
}

function threadUpdatedAt(thread: Record<string, unknown>): string | null {
  return (
    stringValue(thread.updated_at) ??
    stringValue(thread.updatedAt) ??
    stringValue(thread.last_used_at) ??
    stringValue(thread.lastUsedAt) ??
    stringValue(thread.created_at) ??
    stringValue(thread.createdAt) ??
    null
  );
}

function turnToEvents(
  turn: Record<string, unknown>,
  threadId: string,
  _projectId: ProjectId,
): CodexLinkEvent[] {
  const turnId = stringValue(turn.id);
  if (!turnId) {
    return [];
  }
  const events: CodexLinkEvent[] = [
    {
      type: "turn.status.changed",
      threadId: threadId as ThreadId,
      turnId: turnId as TurnId,
      status: codexTurnStatusToLinkStatus(stringValue(turn.status)),
    },
  ];
  if (Array.isArray(turn.items)) {
    for (const item of turn.items) {
      const itemObject = objectValue(item);
      if (!itemObject) {
        continue;
      }
      events.push(...itemToTimelineProjectionEvents(itemObject, threadId, turnId));
      const transcriptEvent = itemToTranscriptEvent(itemObject, threadId, turnId);
      if (transcriptEvent) {
        events.push(transcriptEvent);
      }
      const finalEvent = itemToFinalEvent(itemObject, threadId, turnId);
      if (finalEvent) {
        events.push(finalEvent);
      }
    }
  }
  return events;
}

export function threadStartResponseToEvent(
  response: unknown,
  projectId: ProjectId,
): CodexLinkEvent | null {
  const thread = objectValue(objectValue(response)?.thread);
  const threadId = stringValue(thread?.id);
  if (!thread || !threadId) {
    return null;
  }
  return {
    type: "thread.started",
    thread: {
      id: threadId as ThreadId,
      projectId,
      title: stringValue(thread.name) ?? stringValue(thread.preview) ?? null,
      updatedAt: threadUpdatedAt(thread),
    },
  };
}

export function turnStartResponseToEvent(
  response: unknown,
  threadId: ThreadId,
): CodexLinkEvent | null {
  const turn = objectValue(objectValue(response)?.turn);
  const turnId = stringValue(turn?.id);
  if (!turn || !turnId) {
    return null;
  }
  return {
    type: "turn.status.changed",
    threadId,
    turnId: turnId as TurnId,
    status: codexTurnStatusToLinkStatus(stringValue(turn.status)),
  };
}

function approvalEvent(input: {
  id: RequestId;
  kind: ApprovalKind;
  threadId: string | undefined;
  turnId: string | undefined;
  itemId: string | undefined;
  title: string;
  detail: string;
  availableDecisions: ApprovalDecisionKind[];
}): CodexLinkEvent | null {
  if (!input.threadId || !input.turnId) {
    return null;
  }
  const request = {
    id: input.id,
    kind: input.kind,
    threadId: input.threadId as ThreadId,
    turnId: input.turnId as TurnId,
    title: input.title,
    detail: input.detail,
    availableDecisions: input.availableDecisions,
  };
  const requestWithOptionalItem = input.itemId
    ? { ...request, itemId: input.itemId as ItemId }
    : request;
  return {
    type: "approval.requested",
    request: requestWithOptionalItem,
  };
}

function codexTurnStatusToLinkStatus(status: string | undefined): TurnStatus {
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "interrupted") {
    return "canceled";
  }
  return "running";
}

function itemCompletedStatus(item: Record<string, unknown> | null): "completed" | "failed" | "declined" {
  const status = stringValue(item?.status);
  if (status === "failed") {
    return "failed";
  }
  if (status === "declined") {
    return "declined";
  }
  return "completed";
}

function itemToTimelineProjectionEvents(
  item: Record<string, unknown>,
  threadId: string,
  turnId: string,
): CodexLinkEvent[] {
  const itemId = stringValue(item.id);
  if (!itemId) {
    return [];
  }
  const detail = stringValue(item.type) === "fileChange"
    ? fileChangesDetail(item.changes)
    : undefined;
  const startedEvent: Extract<CodexLinkEvent, { type: "timeline.item.started" }> = {
    type: "timeline.item.started",
    threadId: threadId as ThreadId,
    turnId: turnId as TurnId,
    itemId: itemId as ItemId,
    label: itemLabel(item),
  };
  if (detail) {
    startedEvent.detail = detail;
  }
  return [
    startedEvent,
    {
      type: "timeline.item.completed",
      threadId: threadId as ThreadId,
      turnId: turnId as TurnId,
      itemId: itemId as ItemId,
      status: itemCompletedStatus(item),
    },
  ];
}

function itemToTranscriptEvent(
  item: Record<string, unknown> | null,
  threadId: string,
  turnId: string,
): CodexLinkEvent | null {
  const itemId = stringValue(item?.id);
  const type = stringValue(item?.type);
  if (!itemId || !type) {
    return null;
  }
  if (type === "agentMessage") {
    const text = stringValue(item?.text);
    return text
      ? {
          type: "transcript.item.recorded",
          threadId: threadId as ThreadId,
          turnId: turnId as TurnId,
          itemId: itemId as ItemId,
          role: "assistant",
          text,
        }
      : null;
  }
  if (type === "userMessage" && item) {
    const text = userMessageText(item);
    return text
      ? {
          type: "transcript.item.recorded",
          threadId: threadId as ThreadId,
          turnId: turnId as TurnId,
          itemId: itemId as ItemId,
          role: "user",
          text,
        }
      : null;
  }
  return null;
}

function itemToFinalEvent(
  item: Record<string, unknown> | null,
  threadId: string,
  turnId: string,
): CodexLinkEvent | null {
  const itemId = stringValue(item?.id);
  const type = stringValue(item?.type);
  const text = stringValue(item?.text);
  if (type !== "agentMessage" || !itemId || !text) {
    return null;
  }
  return {
    type: "assistant.final",
    threadId: threadId as ThreadId,
    turnId: turnId as TurnId,
    itemId: itemId as ItemId,
    text,
  };
}

function userMessageText(item: Record<string, unknown>): string | null {
  const content = item.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => {
      const object = objectValue(part);
      return object && stringValue(object.type) === "text" ? stringValue(object.text) : undefined;
    })
    .filter((part): part is string => Boolean(part))
    .join("\n");
  return text || null;
}

function itemLabel(item: Record<string, unknown> | null): string {
  const type = stringValue(item?.type);
  if (type === "commandExecution") {
    return stringValue(item?.command) ?? "Command";
  }
  if (type === "fileChange") {
    return "File change";
  }
  if (type === "mcpToolCall") {
    const server = stringValue(item?.server);
    const tool = stringValue(item?.tool);
    return [server, tool].filter(Boolean).join(".") || "MCP tool";
  }
  if (type === "agentMessage") {
    return "Assistant message";
  }
  if (type === "reasoning") {
    return "Reasoning";
  }
  if (type === "context_compaction" || type === "compaction") {
    return "Context compaction";
  }
  return type ?? "Timeline item";
}

function commandApprovalDetail(params: Record<string, unknown>): string {
  const parts = [
    networkApprovalDetail(params.networkApprovalContext),
    stringValue(params.command),
    stringValue(params.cwd) ? `cwd: ${stringValue(params.cwd)}` : null,
    stringValue(params.reason),
    permissionProfileDetail(params.additionalPermissions),
    execPolicyAmendmentDetail(params.proposedExecpolicyAmendment),
    networkPolicyAmendmentsDetail(params.proposedNetworkPolicyAmendments),
  ].filter(Boolean);
  return parts.join("\n");
}

function fileChangeApprovalDetail(params: Record<string, unknown>): string {
  const parts = [
    stringValue(params.grantRoot) ? `grant root: ${stringValue(params.grantRoot)}` : null,
    stringValue(params.reason),
  ].filter(Boolean);
  return parts.join("\n") || "File change requires approval";
}

function fileChangesDetail(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const detail = value
    .map((change) => {
      const object = objectValue(change);
      const path = stringValue(object?.path) ?? "file";
      const kind = stringValue(object?.kind) ?? "change";
      const diff = stringValue(object?.diff);
      return [`${kind}: ${path}`, diff].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return truncateDisplayDetail(detail);
}

function permissionsApprovalDetail(params: Record<string, unknown>): string {
  const parts = [
    stringValue(params.cwd) ? `cwd: ${stringValue(params.cwd)}` : null,
    stringValue(params.reason),
    permissionProfileDetail(params.permissions),
  ].filter(Boolean);
  return parts.join("\n") || "Permission change requires approval";
}

function networkApprovalDetail(value: unknown): string | null {
  const context = objectValue(value);
  if (!context) {
    return null;
  }
  const host = stringValue(context.host);
  if (!host) {
    return null;
  }
  const protocol = stringValue(context.protocol);
  return `network: ${protocol ? `${protocol}://` : ""}${host}`;
}

function permissionProfileDetail(value: unknown): string | null {
  const profile = objectValue(value);
  if (!profile) {
    return null;
  }
  const lines: string[] = [];
  const network = objectValue(profile.network);
  if (network && typeof network.enabled === "boolean") {
    lines.push(`network permission: ${network.enabled ? "enabled" : "disabled"}`);
  } else if (network) {
    lines.push("network permission requested");
  }

  const fileSystem = objectValue(profile.fileSystem);
  if (fileSystem) {
    lines.push(...pathListDetail("read access", fileSystem.read));
    lines.push(...pathListDetail("write access", fileSystem.write));
    const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries : [];
    for (const entry of entries) {
      const object = objectValue(entry);
      const access = stringValue(object?.access);
      const path = fileSystemPathLabel(object?.path);
      if (access && path) {
        lines.push(`${access} access: ${path}`);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function pathListDetail(label: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((path) => stringValue(path))
    .filter((path): path is string => Boolean(path))
    .map((path) => `${label}: ${path}`);
}

function fileSystemPathLabel(value: unknown): string | null {
  const path = objectValue(value);
  const type = stringValue(path?.type);
  if (type === "path") {
    return stringValue(path?.path) ?? null;
  }
  if (type === "glob_pattern") {
    const pattern = stringValue(path?.pattern);
    return pattern ? `glob:${pattern}` : null;
  }
  if (type === "special") {
    const special = stringValue(path?.value);
    return special ? `special:${special}` : null;
  }
  return null;
}

function execPolicyAmendmentDetail(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const amendment = value
    .map((part) => stringValue(part))
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return amendment ? `exec policy amendment: ${amendment}` : null;
}

function networkPolicyAmendmentsDetail(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const amendments = value
    .map((entry) => {
      const object = objectValue(entry);
      const action = stringValue(object?.action);
      const host = stringValue(object?.host);
      return action && host ? `${action} ${host}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  return amendments.length > 0 ? `network policy amendment: ${amendments.join(", ")}` : null;
}

function truncateDisplayDetail(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const maxLength = 8000;
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n[truncated for display]`;
}

function diagnosticEvent(
  severity: "info" | "warning" | "error",
  message: string,
): CodexLinkEvent {
  return {
    type: "diagnostic.reported",
    diagnostic: {
      scope: "codex",
      severity,
      message,
    },
  };
}

function diagnosticMessage(params: Record<string, unknown>): string {
  return (
    stringValue(params.message) ??
    stringValue(params.summary) ??
    stringValue(params.title) ??
    JSON.stringify(params)
  );
}

function decisionsFromCodex(value: unknown): ApprovalDecisionKind[] {
  if (!Array.isArray(value)) {
    return ["accept", "decline"];
  }
  const decisions = value
    .map((decision) => {
      if (decision === "accept") {
        return "accept";
      }
      if (decision === "acceptForSession") {
        return "accept_for_session";
      }
      if (decision === "decline") {
        return "decline";
      }
      if (decision === "cancel") {
        return "cancel";
      }
      if (typeof decision === "object" && decision) {
        return "accept_for_session";
      }
      return null;
    })
    .filter((decision): decision is ApprovalDecisionKind => decision !== null);
  return decisions.length > 0 ? [...new Set(decisions)] : ["accept", "decline"];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
