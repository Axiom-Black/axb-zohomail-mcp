import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ZohoClient } from "./zoho/client.js";
import { arrayBufferToBase64, base64ToUint8Array, isTextMime } from "./util.js";

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** A composed email awaiting explicit confirmation before it is sent. */
export interface PendingSend {
  accountId: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  content: string;
  ccAddress?: string;
  bccAddress?: string;
  inReplyTo?: string;
  attachments?: { fileName: string; contentBase64: string }[];
  sendAt?: string;
  timeZone?: string;
  createdAt: number;
}

export interface ToolContext {
  accountId: string;
  userEmail: string;
  pending: Map<string, PendingSend>;
}

const CONFIRM_TTL_MS = 15 * 60 * 1000; // prepared sends expire after 15 min
const MAX_DOWNLOAD_BYTES = 6_000_000; // ~6 MB cap on inline attachment content

/** Pull a bare email address out of a "Name <a@b.com>" header value. */
function extractEmail(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

export function registerTools(server: McpServer, client: ZohoClient, ctx: ToolContext): void {
  const { pending } = ctx;
  const acct = z
    .string()
    .default(ctx.accountId)
    .describe("Zoho account ID. Defaults to the signed-in user's primary account.");

  // ── Accounts ──
  server.tool(
    "get_accounts",
    "List the Zoho Mail accounts the signed-in user can access, with their account IDs.",
    {},
    async () => {
      const res = await client.get<any>("/api/accounts");
      const accounts = (res.data ?? []).map((a: any) => ({
        accountId: a.accountId,
        emailAddress: a.emailAddress ?? a.primaryEmailAddress,
        displayName: a.displayName ?? a.accountName,
        isPrimary: a.isPrimary,
      }));
      return json(accounts);
    },
  );

  // ── Folders ──
  server.tool(
    "list_folders",
    "List all mail folders (Inbox, Sent, Drafts, Trash, custom) for an account. Use to get folderId values.",
    { accountId: acct },
    async ({ accountId }) => {
      const res = await client.get<any>(`/api/accounts/${accountId}/folders`);
      const folders = (res.data ?? []).map((f: any) => ({
        folderId: f.folderId,
        folderName: f.folderName,
        path: f.path,
        unreadCount: f.unreadCount,
        messageCount: f.messageCount,
      }));
      return json(folders);
    },
  );

  // ── Emails ──
  server.tool(
    "list_emails",
    "List emails in a folder with pagination. Returns subject, sender, date, read status.",
    {
      accountId: acct,
      folderId: z.string().optional().describe("Folder ID from list_folders. Omit for inbox."),
      limit: z.number().min(1).max(100).default(20).describe("Number of emails (max 100)"),
      start: z.number().min(0).default(0).describe("Offset for pagination"),
    },
    async ({ accountId, folderId, limit, start }) => {
      const res = await client.get<any>(`/api/accounts/${accountId}/messages/view`, {
        limit,
        start,
        folderId,
      });
      return json(mapList(res.data));
    },
  );

  server.tool(
    "search_emails",
    `Search emails with optional structured filters. Combine any of: free-text keyword, sender, recipient, subject, has-attachment. All provided filters are AND-ed together. At least one filter or query is required.`,
    {
      accountId: acct,
      query: z.string().optional().describe("Free-text term to match anywhere in the email"),
      from: z.string().optional().describe("Match emails from this sender (name or address)"),
      to: z.string().optional().describe("Match emails sent to this recipient"),
      subject: z.string().optional().describe("Match this text in the subject"),
      hasAttachment: z.boolean().optional().describe("Only emails that have attachments"),
      limit: z.number().min(1).max(50).default(20).describe("Max results to return"),
    },
    async ({ accountId, query, from, to, subject, hasAttachment, limit }) => {
      const parts: string[] = [];
      if (query) parts.push(`entire:${query}`);
      if (from) parts.push(`sender:${from}`);
      if (to) parts.push(`to:${to}`);
      if (subject) parts.push(`subject:${subject}`);
      if (hasAttachment) parts.push("has:attachment");
      if (parts.length === 0) {
        throw new Error("Provide at least one of: query, from, to, subject, hasAttachment.");
      }
      const res = await client.get<any>(`/api/accounts/${accountId}/messages/search`, {
        searchKey: parts.join("::"),
        limit,
      });
      return json(mapList(res.data));
    },
  );

  server.tool(
    "get_email",
    "Get the full content of a specific email including body, headers, and metadata.",
    {
      accountId: acct,
      folderId: z.string().describe("Folder ID where the email lives"),
      messageId: z.string().describe("Message ID from list_emails or search_emails"),
    },
    async ({ accountId, folderId, messageId }) => json(await getEmail(client, accountId, folderId, messageId)),
  );

  server.tool(
    "list_threads",
    "Get all messages in an email thread/conversation.",
    {
      accountId: acct,
      threadId: z.string().describe("Thread ID (same as the first message ID in the thread)"),
    },
    async ({ accountId, threadId }) => {
      const res = await client.get<any>(`/api/accounts/${accountId}/messages/${threadId}/thread`);
      return json(mapList(res.data));
    },
  );

  // ── Attachments ──
  server.tool(
    "get_attachment_info",
    "List attachments on an email — returns file names, sizes, and IDs.",
    { accountId: acct, folderId: z.string(), messageId: z.string() },
    async ({ accountId, folderId, messageId }) => {
      const res = await client.get<any>(
        `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo`,
      );
      return json(res.data ?? []);
    },
  );

  server.tool(
    "get_attachment",
    "Download an attachment's actual contents so it can be read or summarized. Text files are returned as text, images as viewable images, everything else as base64. Files over ~6 MB return metadata only.",
    {
      accountId: acct,
      folderId: z.string(),
      messageId: z.string(),
      attachmentId: z.string().describe("Attachment ID from get_attachment_info"),
    },
    async ({ accountId, folderId, messageId, attachmentId }) => {
      const info = await client.get<any>(
        `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo`,
      );
      const match = (info.data ?? []).find((a: any) => String(a.attachmentId) === attachmentId);
      const fileName = match?.fileName ?? "attachment";
      const declaredMime = match?.mimeType ?? "application/octet-stream";

      const { buffer, contentType } = await client.getBinary(
        `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachments/${attachmentId}`,
      );
      const mime = declaredMime !== "application/octet-stream" ? declaredMime : contentType;
      const size = buffer.byteLength;

      if (size > MAX_DOWNLOAD_BYTES) {
        return json({
          fileName,
          mimeType: mime,
          sizeBytes: size,
          note: `File is ${(size / 1_000_000).toFixed(1)} MB, over the ~6 MB inline limit. Not returned.`,
        });
      }

      if (/^image\//.test(mime)) {
        return {
          content: [{ type: "image" as const, data: arrayBufferToBase64(buffer), mimeType: mime }],
        };
      }

      if (isTextMime(mime)) {
        const text = new TextDecoder().decode(buffer);
        return {
          content: [{
            type: "text" as const,
            text: `File: ${fileName} (${mime}, ${size} bytes)\n\n${text.slice(0, 200_000)}`,
          }],
        };
      }

      return json({
        fileName,
        mimeType: mime,
        sizeBytes: size,
        base64: arrayBufferToBase64(buffer),
      });
    },
  );

  // ── Drafts (safe, no confirmation) ──
  server.tool(
    "save_draft",
    "Save an email as a draft in Zoho Mail for the user to review and send manually.",
    {
      accountId: acct,
      toAddress: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      content: z.string().describe("Email body (HTML supported)"),
      ccAddress: z.string().optional(),
      replyToMessageId: z.string().optional().describe("Message ID if this is a reply"),
    },
    async (a) => {
      const payload: Record<string, unknown> = {
        fromAddress: ctx.userEmail,
        toAddress: a.toAddress,
        subject: a.subject,
        content: a.content,
        mailFormat: "html",
        action: "draft",
      };
      if (a.ccAddress) payload.ccAddress = a.ccAddress;
      if (a.replyToMessageId) payload.inReplyTo = a.replyToMessageId;
      const res = await client.post<any>(`/api/accounts/${a.accountId}/messages`, payload);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Draft saved.\nTo: ${a.toAddress}\nSubject: ${a.subject}\nMessage ID: ${res.data?.messageId}`,
        }],
      };
    },
  );

  // ── Hardened send: prepare → confirm → send ──
  const attachmentsSchema = z
    .array(z.object({
      fileName: z.string(),
      contentBase64: z.string().describe("Base64-encoded file contents"),
    }))
    .optional()
    .describe("Optional files to attach, as base64");

  function stage(p: Omit<PendingSend, "createdAt">): { confirmationToken: string; preview: string } {
    // Drop anything stale so the map can't grow unbounded.
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.createdAt > CONFIRM_TTL_MS) pending.delete(k);

    const confirmationToken = crypto.randomUUID();
    pending.set(confirmationToken, { ...p, createdAt: now });
    const lines = [
      `From: ${p.fromAddress}`,
      `To: ${p.toAddress}`,
      p.ccAddress ? `Cc: ${p.ccAddress}` : null,
      p.bccAddress ? `Bcc: ${p.bccAddress}` : null,
      `Subject: ${p.subject}`,
      p.sendAt ? `Scheduled: ${p.sendAt} (${p.timeZone ?? "America/New_York"})` : null,
      p.attachments?.length ? `Attachments: ${p.attachments.map((a) => a.fileName).join(", ")}` : null,
      "",
      p.content,
    ].filter(Boolean);
    const preview =
      `✉️ Draft ready — NOT sent yet.\n\n${lines.join("\n")}\n\n` +
      `Show this to the user and get explicit approval, then call send_email with confirmationToken="${confirmationToken}".`;
    return { confirmationToken, preview };
  }

  server.tool(
    "prepare_email",
    "Stage a new email for sending. Returns a preview and a confirmationToken. This does NOT send — show the user the preview, get explicit approval, then call send_email with the token.",
    {
      accountId: acct,
      toAddress: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string(),
      content: z.string().describe("Email body (HTML supported)"),
      ccAddress: z.string().optional(),
      bccAddress: z.string().optional(),
      attachments: attachmentsSchema,
      sendAt: z.string().optional().describe("Schedule for this local date-time, e.g. '2026-07-10 09:00'. Omit to send immediately."),
      timeZone: z.string().optional().describe("IANA timezone for sendAt (default America/New_York)"),
    },
    async (a) => {
      const { preview } = stage({
        accountId: a.accountId,
        fromAddress: ctx.userEmail,
        toAddress: a.toAddress,
        subject: a.subject,
        content: a.content,
        ccAddress: a.ccAddress,
        bccAddress: a.bccAddress,
        attachments: a.attachments,
        sendAt: a.sendAt,
        timeZone: a.timeZone,
      });
      return { content: [{ type: "text" as const, text: preview }] };
    },
  );

  server.tool(
    "prepare_reply",
    "Stage a reply (or reply-all) to an existing email. Fetches the original to fill recipients and subject. Returns a preview + confirmationToken; does NOT send.",
    {
      accountId: acct,
      folderId: z.string().describe("Folder the original email is in"),
      messageId: z.string().describe("Message ID being replied to"),
      content: z.string().describe("Your reply body (HTML supported)"),
      all: z.boolean().default(false).describe("true = reply-all (include original To/Cc)"),
      attachments: attachmentsSchema,
    },
    async (a) => {
      const orig = await getEmail(client, a.accountId, a.folderId, a.messageId);
      const toAddress = orig.fromAddress ?? "";
      let ccAddress: string | undefined;
      if (a.all) {
        const self = ctx.userEmail.toLowerCase();
        const replyTarget = extractEmail(toAddress);
        const seen = new Set([self, replyTarget]);
        const cc: string[] = [];
        for (const field of [orig.toAddress, orig.ccAddress]) {
          for (const addr of String(field ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
            const email = extractEmail(addr);
            if (!seen.has(email)) { seen.add(email); cc.push(addr); }
          }
        }
        if (cc.length) ccAddress = cc.join(", ");
      }
      const subject = /^re:/i.test(orig.subject ?? "") ? orig.subject : `Re: ${orig.subject ?? ""}`;
      const { preview } = stage({
        accountId: a.accountId,
        fromAddress: ctx.userEmail,
        toAddress,
        subject,
        content: a.content,
        ccAddress,
        inReplyTo: a.messageId,
        attachments: a.attachments,
      });
      return { content: [{ type: "text" as const, text: preview }] };
    },
  );

  server.tool(
    "prepare_forward",
    "Stage a forward of an existing email to new recipients. Quotes the original body. Returns a preview + confirmationToken; does NOT send. (Original attachments are not re-attached.)",
    {
      accountId: acct,
      folderId: z.string(),
      messageId: z.string(),
      toAddress: z.string().describe("Who to forward to, comma-separated"),
      content: z.string().default("").describe("Optional note to add above the forwarded message"),
      ccAddress: z.string().optional(),
    },
    async (a) => {
      const orig = await getEmail(client, a.accountId, a.folderId, a.messageId);
      const subject = /^fwd:/i.test(orig.subject ?? "") ? orig.subject : `Fwd: ${orig.subject ?? ""}`;
      const quoted =
        `${a.content ? a.content + "<br><br>" : ""}---------- Forwarded message ----------<br>` +
        `From: ${orig.fromAddress ?? ""}<br>Date: ${orig.receivedTime ?? ""}<br>` +
        `Subject: ${orig.subject ?? ""}<br>To: ${orig.toAddress ?? ""}<br><br>${orig.content ?? ""}`;
      const { preview } = stage({
        accountId: a.accountId,
        fromAddress: ctx.userEmail,
        toAddress: a.toAddress,
        subject,
        content: quoted,
        ccAddress: a.ccAddress,
      });
      return { content: [{ type: "text" as const, text: preview }] };
    },
  );

  server.tool(
    "send_email",
    "Send a previously prepared email. Requires the confirmationToken from prepare_email / prepare_reply / prepare_forward. Only call this after the user has seen the preview and explicitly approved.",
    { confirmationToken: z.string().describe("Token returned by a prepare_* tool") },
    async ({ confirmationToken }) => {
      const p = pending.get(confirmationToken);
      if (!p) {
        throw new Error("No matching prepared email (invalid or expired token). Call a prepare_* tool again.");
      }
      if (Date.now() - p.createdAt > CONFIRM_TTL_MS) {
        pending.delete(confirmationToken);
        throw new Error("This prepared email expired (15 min limit). Prepare it again.");
      }

      const payload: Record<string, unknown> = {
        fromAddress: p.fromAddress,
        toAddress: p.toAddress,
        subject: p.subject,
        content: p.content,
        mailFormat: "html",
      };
      if (p.ccAddress) payload.ccAddress = p.ccAddress;
      if (p.bccAddress) payload.bccAddress = p.bccAddress;
      if (p.inReplyTo) payload.inReplyTo = p.inReplyTo;

      if (p.sendAt) {
        payload.isSchedule = true;
        payload.scheduleType = 6; // custom date/time
        payload.timeZone = p.timeZone ?? "America/New_York";
        payload.scheduleTime = formatScheduleTime(p.sendAt);
      }

      if (p.attachments?.length) {
        payload.attachments = await Promise.all(
          p.attachments.map((f) =>
            client.uploadAttachment(p.accountId, f.fileName, base64ToUint8Array(f.contentBase64)),
          ),
        );
      }

      const res = await client.post<any>(`/api/accounts/${p.accountId}/messages`, payload);
      pending.delete(confirmationToken);
      const when = p.sendAt ? `Scheduled for ${p.sendAt} (${p.timeZone ?? "America/New_York"})` : "Sent";
      return {
        content: [{
          type: "text" as const,
          text: `✅ ${when}.\nTo: ${p.toAddress}\nSubject: ${p.subject}\nMessage ID: ${res.data?.messageId}`,
        }],
      };
    },
  );

  // ── Organize ──
  const actionMap: Record<string, Record<string, unknown>> = {
    markAsRead: { mode: "markAsRead", isRead: true },
    markAsUnread: { mode: "markAsRead", isRead: false },
    flag: { mode: "flag", isFlagged: true },
    unflag: { mode: "flag", isFlagged: false },
    archive: { mode: "archive", isArchive: true },
    unarchive: { mode: "archive", isArchive: false },
    markAsSpam: { mode: "spam", isSpam: true },
    markAsNotSpam: { mode: "spam", isSpam: false },
  };

  const messageIds = z
    .array(z.string())
    .min(1)
    .describe("One or more message IDs. Pass several for a bulk action.");

  server.tool(
    "update_email",
    "Mark one or more emails read/unread, flag, archive, or mark as spam. Pass several IDs to act in bulk.",
    {
      accountId: acct,
      messageIds,
      action: z.enum([
        "markAsRead", "markAsUnread", "flag", "unflag",
        "archive", "unarchive", "markAsSpam", "markAsNotSpam",
      ]),
    },
    async ({ accountId, messageIds, action }) => {
      await client.put(`/api/accounts/${accountId}/updatemessage`, {
        messageId: messageIds,
        ...actionMap[action],
      });
      return json({ count: messageIds.length, action, status: "Updated successfully" });
    },
  );

  server.tool(
    "move_email",
    "Move one or more emails to a different folder. Pass several IDs to move in bulk.",
    {
      accountId: acct,
      messageIds,
      destinationFolderId: z.string().describe("Target folder ID from list_folders"),
    },
    async ({ accountId, messageIds, destinationFolderId }) => {
      await client.put(`/api/accounts/${accountId}/updatemessage`, {
        messageId: messageIds,
        mode: "moveMessage",
        destfolderId: destinationFolderId,
      });
      return json({ count: messageIds.length, destinationFolderId, status: "Moved successfully" });
    },
  );

  server.tool(
    "apply_label",
    "Apply or remove a label/tag on one or more emails. Pass several IDs to label in bulk.",
    {
      accountId: acct,
      messageIds,
      labelId: z.string(),
      remove: z.boolean().default(false).describe("true to remove the label instead of adding it"),
    },
    async ({ accountId, messageIds, labelId, remove }) => {
      await client.put(`/api/accounts/${accountId}/updatemessage`, {
        messageId: messageIds,
        mode: remove ? "removeLabel" : "addLabel",
        labelid: [labelId],
      });
      return json({ count: messageIds.length, labelId, action: remove ? "removed" : "applied", status: "OK" });
    },
  );

  server.tool(
    "delete_emails",
    "Move one or more emails to Trash (recoverable — this does not permanently delete).",
    {
      accountId: acct,
      messageIds,
      trashFolderId: z.string().optional().describe("Trash folder ID; auto-detected if omitted"),
    },
    async ({ accountId, messageIds, trashFolderId }) => {
      let trash = trashFolderId;
      if (!trash) {
        const res = await client.get<any>(`/api/accounts/${accountId}/folders`);
        const f = (res.data ?? []).find((x: any) => /^trash$/i.test(x.folderName));
        if (!f) throw new Error("Couldn't find a Trash folder — pass trashFolderId explicitly.");
        trash = f.folderId;
      }
      await client.put(`/api/accounts/${accountId}/updatemessage`, {
        messageId: messageIds,
        mode: "moveMessage",
        destfolderId: trash,
      });
      return json({ count: messageIds.length, status: "Moved to Trash (recoverable)" });
    },
  );

  // ── Folders & labels ──
  server.tool(
    "create_folder",
    "Create a new mail folder, optionally nested under a parent.",
    {
      accountId: acct,
      folderName: z.string().describe("Name of the new folder"),
      parentFolderId: z.string().optional().describe("Parent folder ID to nest under"),
    },
    async ({ accountId, folderName, parentFolderId }) => {
      const body: Record<string, unknown> = { folderName };
      if (parentFolderId) body.parentFolderId = parentFolderId;
      const res = await client.post<any>(`/api/accounts/${accountId}/folders`, body);
      return json({
        folderId: res.data?.folderId,
        folderName: res.data?.folderName ?? folderName,
        status: "Folder created",
      });
    },
  );

  server.tool(
    "create_label",
    "Create a new label/tag that can then be applied with apply_label.",
    {
      accountId: acct,
      displayName: z.string().describe("Label name"),
      color: z.string().optional().describe("Hex color like #2da44e (defaults to Zoho gold)"),
    },
    async ({ accountId, displayName, color }) => {
      const body: Record<string, unknown> = { displayName };
      if (color) body.color = color;
      const res = await client.post<any>(`/api/accounts/${accountId}/labels`, body);
      return json({
        labelId: res.data?.labelId,
        displayName: res.data?.displayName ?? displayName,
        color: res.data?.color,
        status: "Label created",
      });
    },
  );
}

/** Convert a 'YYYY-MM-DD HH:MM[:SS]' (or ISO) string to Zoho's MM/DD/YYYY HH:MM:SS. */
function formatScheduleTime(sendAt: string): string {
  const m = sendAt.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error(`Could not parse sendAt "${sendAt}". Use e.g. "2026-07-10 09:00".`);
  const [, y, mo, d, h, mi, s] = m;
  return `${mo}/${d}/${y} ${h}:${mi}:${s ?? "00"}`;
}

// ── helpers ──

function mapList(data: any): any[] {
  return (data ?? []).map((m: any) => ({
    messageId: m.messageId,
    subject: m.subject,
    fromAddress: m.fromAddress,
    toAddress: m.toAddress,
    receivedTime: m.receivedTime,
    isRead: m.isRead,
    hasAttachment: m.hasAttachment,
    folderId: m.folderId,
    summary: m.summary,
  }));
}

async function getEmail(client: ZohoClient, accountId: string, folderId: string, messageId: string) {
  const [content, details] = await Promise.all([
    client.get<any>(`/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`),
    client.get<any>(`/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/details`),
  ]);
  return {
    messageId,
    subject: details.data?.subject,
    fromAddress: details.data?.fromAddress,
    toAddress: details.data?.toAddress,
    ccAddress: details.data?.ccAddress,
    receivedTime: details.data?.receivedTime,
    content: content.data?.content,
    isRead: details.data?.isRead,
    hasAttachment: details.data?.hasAttachment,
  };
}
