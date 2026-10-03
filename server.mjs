import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const scrypt = promisify(scryptCallback);
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory = resolve(process.env.NEXVO_DATA_DIR || join(projectRoot, ".data"));
const uploadDirectory = join(dataDirectory, "uploads");
const databasePath = resolve(process.env.NEXVO_DATABASE_PATH || join(dataDirectory, "nexvo.sqlite"));
const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const isProduction = process.env.NODE_ENV === "production";
const isUnchangedTemplateValue = (value) => /^replace[-_]/i.test(value.trim());
const cookieName = "nexvo_session";
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const maxJsonBodyBytes = 12 * 1024 * 1024;
const maxStatusMediaBytes = 50 * 1024 * 1024;
const imageTypes = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["image/x-icon", ".ico"],
  ["image/vnd.microsoft.icon", ".ico"]
]);
const rateBuckets = new Map();

if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
  throw new Error("Set a valid ADMIN_EMAIL before starting NEXVO.");
}
if (adminPassword.length < 14 || (isProduction && isUnchangedTemplateValue(adminPassword))) {
  throw new Error("Set a unique ADMIN_PASSWORD of at least 14 characters before starting NEXVO.");
}
if (sessionSecret.length < 32 || (isProduction && isUnchangedTemplateValue(sessionSecret))) {
  throw new Error("Set SESSION_SECRET to a random value of at least 32 characters before starting NEXVO.");
}
if (isProduction && process.env.SESSION_COOKIE_SECURE !== "true") {
  throw new Error("Production requires SESSION_COOKIE_SECURE=true and HTTPS.");
}

mkdirSync(uploadDirectory, { recursive: true });
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE,
    email TEXT UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    username TEXT UNIQUE,
    avatar_path TEXT,
    verification_level TEXT,
    account_status TEXT NOT NULL DEFAULT 'active',
    internal_notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brand_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brand_assets (
    slot TEXT PRIMARY KEY,
    asset_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    participant_low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    participant_high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(participant_low, participant_high),
    CHECK(participant_low < participant_high)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(sender_id, client_message_id)
  );
  CREATE TABLE IF NOT EXISTS statuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL DEFAULT '',
    background TEXT,
    media_path TEXT,
    media_type TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_conversations_participants ON conversations(participant_low, participant_high);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_statuses_expiry ON statuses(expires_at);
`);

const defaults = {
  app_name: "NEXVO",
  app_verified: "false",
  show_verified_badge: "true"
};
for (const [key, value] of Object.entries(defaults)) {
  database.prepare("INSERT OR IGNORE INTO brand_settings (key, value) VALUES (?, ?)").run(key, value);
}

const adminSalt = randomBytes(16).toString("hex");
const adminHash = (await scrypt(adminPassword, `${sessionSecret}:${adminSalt}`, 64)).toString("hex");
database.prepare(`
  INSERT INTO users (id, name, email, password_salt, password_hash, role, created_at, last_active)
  VALUES (?, 'NEXVO Administrator', ?, ?, ?, 'super_admin', ?, ?)
  ON CONFLICT(email) DO UPDATE SET password_salt = excluded.password_salt,
    password_hash = excluded.password_hash, role = 'super_admin'
`).run(randomUUID(), adminEmail, adminSalt, adminHash, Date.now(), Date.now());

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(body);
}

function securityHeaders(response, contentType = "text/html; charset=utf-8") {
  response.setHeader("Content-Type", contentType);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie || "";
  return Object.fromEntries(cookieHeader.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function sessionCookie(token, maxAgeSeconds) {
  const flags = [`${cookieName}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`];
  if (isProduction) flags.push("Secure");
  return flags.join("; ");
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function readJson(request, limit = maxJsonBodyBytes) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > limit) {
    const error = new Error("Request body is too large.");
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Send a valid JSON request body.");
    error.status = 400;
    throw error;
  }
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
}

function normalizeUsername(username) {
  const value = String(username || "").trim().replace(/^@/, "").toLowerCase();
  if (value && !/^[a-z0-9_]{3,24}$/.test(value)) {
    const error = new Error("Username must be 3–24 characters using letters, numbers, or underscores.");
    error.status = 400;
    throw error;
  }
  return value || null;
}

function passwordFromDataUrl(dataUrl, purpose) {
  if (dataUrl == null && purpose === "avatar") return null;
  if (typeof dataUrl !== "string") {
    const error = new Error("An image file is required.");
    error.status = 400;
    throw error;
  }
  const allowedTypes = purpose === "avatar"
    ? "png|jpeg|webp"
    : "png|jpeg|webp|svg\\+xml|x-icon|vnd\\.microsoft\\.icon";
  const match = new RegExp(`^data:(image/(?:${allowedTypes}));base64,([a-zA-Z0-9+/]+={0,2})$`).exec(dataUrl);
  if (!match) {
    const error = new Error(purpose === "avatar"
      ? "Upload a PNG, JPEG, or WEBP image."
      : "Upload a PNG, JPEG, WEBP, SVG, or ICO image.");
    error.status = 415;
    throw error;
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 5 * 1024 * 1024) {
    const error = new Error("The optimized image must be 5 MB or smaller.");
    error.status = 413;
    throw error;
  }
  const signatureChecks = {
    "image/png": bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/jpeg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    "image/webp": bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
    "image/svg+xml": /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 4096))),
    "image/x-icon": bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1,
    "image/vnd.microsoft.icon": bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1
  };
  if (!signatureChecks[match[1]]) {
    const error = new Error("The image contents do not match its declared image type.");
    error.status = 415;
    throw error;
  }
  return { bytes, mimeType: match[1], extension: match[1] === "image/jpeg" ? ".jpg" : match[1] === "image/webp" ? ".webp" : ".png" };
}

function persistImage(dataUrl, purpose) {
  const image = passwordFromDataUrl(dataUrl, purpose);
  if (!image) return null;
  const filename = `${randomUUID()}${imageTypes.get(image.mimeType) || image.extension}`;
  writeFileSync(join(uploadDirectory, filename), image.bytes, { flag: "wx" });
  return { path: `/uploads/${filename}`, mimeType: image.mimeType };
}

function statusMediaFromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") {
    const error = new Error("Choose a supported image or video.");
    error.status = 400;
    throw error;
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif)|video\/(?:mp4|webm));base64,([a-zA-Z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) {
    const error = new Error("Statuses support PNG, JPEG, WEBP, GIF, MP4, and WebM files.");
    error.status = 415;
    throw error;
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > maxStatusMediaBytes) {
    const error = new Error("Status media must be 50 MB or smaller.");
    error.status = 413;
    throw error;
  }
  const signatures = {
    "image/png": bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/jpeg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    "image/webp": bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
    "image/gif": bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a",
    "video/mp4": bytes.toString("ascii", 4, 8) === "ftyp",
    "video/webm": bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  };
  if (!signatures[match[1]]) {
    const error = new Error("The media contents do not match the declared file type.");
    error.status = 415;
    throw error;
  }
  const extensions = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm"
  };
  return { bytes, mimeType: match[1], extension: extensions[match[1]] };
}

function persistStatusMedia(dataUrl) {
  const media = statusMediaFromDataUrl(dataUrl);
  const filename = `${randomUUID()}${media.extension}`;
  writeFileSync(join(uploadDirectory, filename), media.bytes, { flag: "wx" });
  return { path: `/uploads/${filename}`, mimeType: media.mimeType };
}

function removeStatusMedia(mediaPath) {
  if (!mediaPath) return;
  const filename = mediaPath.startsWith("/uploads/") ? mediaPath.slice("/uploads/".length) : "";
  if (!/^[a-f0-9-]+\.(?:png|jpg|webp|gif|mp4|webm)$/i.test(filename)) return;
  try {
    unlinkSync(join(uploadDirectory, filename));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Unable to remove expired NEXVO status media:", error);
    }
  }
}

function cleanupExpiredStatuses() {
  const expired = database.prepare("SELECT media_path FROM statuses WHERE expires_at <= ?").all(Date.now());
  database.prepare("DELETE FROM statuses WHERE expires_at <= ?").run(Date.now());
  for (const status of expired) removeStatusMedia(status.media_path);
}

function cleanUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_path,
    role: row.role,
    verificationLevel: row.verification_level,
    accountStatus: row.account_status,
    createdAt: row.created_at,
    lastActive: row.last_active
  };
}

function cleanChatUser(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    avatarUrl: row.avatar_path,
    verificationLevel: row.verification_level
  };
}

function cleanMessage(row, currentUserId) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientMessageId: row.client_message_id,
    text: row.text,
    createdAt: row.created_at,
    mine: row.sender_id === currentUserId
  };
}

function cleanStatus(row) {
  return {
    id: row.id,
    text: row.text,
    background: row.background,
    mediaUrl: row.media_path,
    mediaType: row.media_type,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    owner: {
      id: row.user_id,
      name: row.name,
      username: row.username,
      avatarUrl: row.avatar_path,
      verificationLevel: row.verification_level
    }
  };
}

function getConversations(userId) {
  const conversations = database.prepare(`
    SELECT c.id, c.created_at, c.updated_at,
      other.id AS peer_id, other.name AS peer_name, other.username AS peer_username,
      other.avatar_path AS peer_avatar_path, other.verification_level AS peer_verification_level,
      (SELECT m.text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at
    FROM conversations c
    JOIN users other ON other.id = CASE WHEN c.participant_low = ? THEN c.participant_high ELSE c.participant_low END
    WHERE c.participant_low = ? OR c.participant_high = ?
    ORDER BY c.updated_at DESC
  `).all(userId, userId, userId);
  return conversations.map((conversation) => ({
    id: conversation.id,
    peer: cleanChatUser({
      id: conversation.peer_id,
      name: conversation.peer_name,
      username: conversation.peer_username,
      avatar_path: conversation.peer_avatar_path,
      verification_level: conversation.peer_verification_level
    }),
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    lastMessage: conversation.last_message == null ? null : {
      text: conversation.last_message,
      createdAt: conversation.last_message_at
    }
  }));
}

function getVisibleStatuses(userId) {
  return database.prepare(`
    SELECT statuses.*, users.name, users.username, users.avatar_path, users.verification_level
    FROM statuses
    JOIN users ON users.id = statuses.user_id
    WHERE statuses.expires_at > ?
      AND (statuses.user_id = ? OR statuses.user_id IN (
        SELECT CASE WHEN participant_low = ? THEN participant_high ELSE participant_low END
        FROM conversations
        WHERE participant_low = ? OR participant_high = ?
      ))
    ORDER BY statuses.created_at ASC
  `).all(Date.now(), userId, userId, userId, userId).map(cleanStatus);
}

function logAudit(actorId, action, targetId = null, details = {}) {
  database.prepare("INSERT INTO audit_logs (actor_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(actorId, action, targetId, JSON.stringify(details), Date.now());
}

function applyBrand(response) {
  const settings = Object.fromEntries(database.prepare("SELECT key, value FROM brand_settings").all().map((row) => [row.key, row.value]));
  const assets = Object.fromEntries(database.prepare("SELECT slot, asset_path AS path, mime_type AS mimeType FROM brand_assets").all().map((row) => [row.slot, { path: row.path, mimeType: row.mimeType }]));
  sendJson(response, 200, {
    appName: settings.app_name,
    appVerified: settings.app_verified === "true",
    showVerifiedBadge: settings.show_verified_badge !== "false",
    assets
  });
}

function rateLimit(request, response, key, max, windowMs = 60_000) {
  const now = Date.now();
  const bucketKey = `${request.socket.remoteAddress || "unknown"}:${key}`;
  const current = rateBuckets.get(bucketKey);
  if (!current || now - current.start >= windowMs) {
    rateBuckets.set(bucketKey, { start: now, count: 1 });
    return false;
  }
  current.count += 1;
  if (current.count <= max) return false;
  sendJson(response, 429, { error: "Too many requests. Try again later." }, { "Retry-After": String(Math.ceil((windowMs - (now - current.start)) / 1000)) });
  return true;
}

function originIsValid(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = request.headers.host;
    const expectedProtocol = isProduction ? "https:" : "http:";
    return parsed.host === host && parsed.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

function serveFile(response, filename, mimeType, contentSecurityPolicy) {
  try {
    statSync(filename);
  } catch {
    sendJson(response, 404, { error: "File not found." });
    return;
  }
  securityHeaders(response, mimeType);
  if (contentSecurityPolicy) response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("Cache-Control", "no-store");
  const stream = createReadStream(filename);
  stream.on("error", (error) => {
    console.error("Unable to serve a NEXVO file:", error);
    if (response.headersSent) response.destroy(error);
    else sendJson(response, 500, { error: "The requested file could not be served." });
  });
  stream.pipe(response);
}

function serveVideo(request, response, filename, mimeType) {
  let size;
  try {
    size = statSync(filename).size;
  } catch {
    sendJson(response, 404, { error: "Media not found." });
    return;
  }
  securityHeaders(response, mimeType);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "private, no-store");
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { "Content-Length": size });
    if (request.method === "HEAD") response.end();
    else createReadStream(filename).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` });
    response.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[2] && match[1] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${size}`
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filename, { start, end }).pipe(response);
}

const socketsByUser = new Map();

function sendSocketEvent(socket, event) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function broadcastToUser(userId, event) {
  for (const socket of socketsByUser.get(userId) || []) sendSocketEvent(socket, event);
}

function getConversationPeerIds(userId) {
  return database.prepare(`
    SELECT DISTINCT CASE WHEN participant_low = ? THEN participant_high ELSE participant_low END AS peer_id
    FROM conversations
    WHERE participant_low = ? OR participant_high = ?
  `).all(userId, userId, userId).map((row) => row.peer_id);
}

function broadcastToConversationPeers(userId, event) {
  for (const peerId of getConversationPeerIds(userId)) broadcastToUser(peerId, event);
}

function closeUserConnections(userId, code, reason) {
  for (const socket of socketsByUser.get(userId) || []) socket.close(code, reason);
}

function handleRealtimeMessage(socket, userId, sessionTokenHash, rawData, isBinary) {
  if (isBinary) {
    sendSocketEvent(socket, { type: "error", error: "Only JSON text messages are supported." });
    return;
  }
  const session = database.prepare(`
    SELECT users.account_status, users.role FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.user_id = ? AND sessions.expires_at > ?
  `).get(sessionTokenHash, userId, Date.now());
  if (!session || session.role !== "user" || session.account_status !== "active") {
    socket.close(4001, "Session is no longer active.");
    return;
  }
  const now = Date.now();
  const recentMessages = socket.recentMessages.filter((timestamp) => now - timestamp < 60_000);
  if (recentMessages.length >= 30) {
    sendSocketEvent(socket, { type: "error", error: "Message limit reached. Try again shortly." });
    return;
  }
  recentMessages.push(now);
  socket.recentMessages = recentMessages;
  let event;
  try {
    event = JSON.parse(rawData.toString("utf8"));
  } catch {
    sendSocketEvent(socket, { type: "error", error: "Send a valid JSON event." });
    return;
  }
  if (event.type !== "message.send") {
    sendSocketEvent(socket, { type: "error", error: "Unsupported realtime event." });
    return;
  }
  const conversationId = String(event.conversationId || "");
  const clientMessageId = String(event.clientMessageId || "");
  const text = typeof event.text === "string" ? event.text.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(conversationId) || !/^[0-9a-f-]{36}$/i.test(clientMessageId) || !text || text.length > 2000) {
    sendSocketEvent(socket, { type: "error", clientMessageId, error: "A conversation, message id, and text of up to 2,000 characters are required." });
    return;
  }
  const conversation = database.prepare(`
    SELECT conversations.id FROM conversations
    JOIN users low_user ON low_user.id = conversations.participant_low AND low_user.account_status = 'active'
    JOIN users high_user ON high_user.id = conversations.participant_high AND high_user.account_status = 'active'
    WHERE conversations.id = ? AND (conversations.participant_low = ? OR conversations.participant_high = ?)
  `).get(conversationId, userId, userId);
  if (!conversation) {
    sendSocketEvent(socket, { type: "error", clientMessageId, error: "Conversation not found or no longer available." });
    return;
  }
  const duplicate = database.prepare("SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?")
    .get(userId, clientMessageId);
  if (duplicate) {
    if (duplicate.conversation_id !== conversationId || duplicate.text !== text) {
      sendSocketEvent(socket, { type: "error", clientMessageId, error: "That message id has already been used." });
      return;
    }
    sendSocketEvent(socket, { type: "message.created", message: cleanMessage(duplicate, userId) });
    return;
  }
  const createdAt = Date.now();
  const message = {
    id: randomUUID(),
    conversation_id: conversationId,
    sender_id: userId,
    client_message_id: clientMessageId,
    text,
    created_at: createdAt
  };
  database.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, client_message_id, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(message.id, conversationId, userId, clientMessageId, text, createdAt);
  database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(createdAt, conversationId);
  const participants = database.prepare("SELECT participant_low, participant_high FROM conversations WHERE id = ?").get(conversationId);
  for (const participantId of [participants.participant_low, participants.participant_high]) {
    broadcastToUser(participantId, { type: "message.created", message: cleanMessage(message, participantId) });
  }
}

async function handleRequest(request, response) {
  securityHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204, { Allow: "GET, POST, PATCH, DELETE, OPTIONS" });
    response.end();
    return;
  }
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;
  if (pathname.startsWith("/api/") && request.method !== "GET" && !originIsValid(request)) {
    sendJson(response, 403, { error: "Cross-origin request rejected." });
    return;
  }

  if (pathname === "/healthz" && request.method === "GET") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (pathname === "/api/brand" && request.method === "GET") {
    applyBrand(response);
    return;
  }
  if (pathname === "/api/auth/register" && request.method === "POST") {
    if (rateLimit(request, response, "register", 5)) return;
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const phone = normalizePhone(body.phone);
    const password = String(body.password || "");
    const username = normalizeUsername(body.username);
    if (name.length < 2 || name.length > 48 || phone.replace(/\D/g, "").length < 7 || password.length < 12 || password.length > 256) {
      sendJson(response, 400, { error: "Enter a name, a valid phone number, and a password of at least 12 characters." });
      return;
    }
    const image = persistImage(body.avatarData, "avatar");
    const id = randomUUID();
    const salt = randomBytes(16).toString("hex");
    const hash = (await scrypt(password, `${sessionSecret}:${salt}`, 64)).toString("hex");
    const now = Date.now();
    try {
      database.prepare(`
        INSERT INTO users (id, name, phone, username, password_salt, password_hash, avatar_path, created_at, last_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, phone, username, salt, hash, image?.path || null, now, now);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        sendJson(response, 409, { error: "That phone number or username is already registered." });
        return;
      }
      throw error;
    }
    logAudit(id, "user.register", id);
    createSession(response, id);
    sendJson(response, 201, { user: cleanUser(database.prepare("SELECT * FROM users WHERE id = ?").get(id)) });
    return;
  }

  if (pathname === "/api/auth/login" && request.method === "POST") {
    if (rateLimit(request, response, "login", 8)) return;
    const body = await readJson(request, 16 * 1024);
    const identifier = String(body.identifier || "").trim().toLowerCase();
    const user = database.prepare("SELECT * FROM users WHERE lower(email) = ? OR phone = ? OR username = ?")
      .get(identifier, normalizePhone(identifier), identifier.replace(/^@/, ""));
    const candidate = String(body.password || "");
    const actualHash = user
      ? Buffer.from(await scrypt(candidate, `${sessionSecret}:${user.password_salt}`, 64))
      : Buffer.from(await scrypt(candidate, `${sessionSecret}:nexvo-invalid-account`, 64));
    const expectedHash = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(64);
    const passwordMatches = actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
    if (!user || !passwordMatches || user.account_status !== "active") {
      sendJson(response, 401, { error: "Invalid credentials or inactive account." });
      return;
    }
    database.prepare("UPDATE users SET last_active = ? WHERE id = ?").run(Date.now(), user.id);
    createSession(response, user.id);
    sendJson(response, 200, { user: cleanUser(database.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
    return;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token = parseCookies(request)[cookieName];
    if (token) {
      const session = getSessionUser(request);
      database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
      if (session) closeUserConnections(session.id, 4001, "Session ended.");
    }
    sendJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    return;
  }

  const user = getSessionUser(request);
  if (pathname === "/api/me" && request.method === "GET") {
    if (!user || user.account_status !== "active") {
      sendJson(response, user ? 403 : 401, { error: "An active session is required." });
      return;
    }
    sendJson(response, 200, { user: cleanUser(user) });
    return;
  }

  if (pathname === "/api/me" && request.method === "PATCH") {
    if (!user || user.role !== "user") {
      sendJson(response, user ? 403 : 401, { error: user ? "User account required." : "Authentication required." });
      return;
    }
    const body = await readJson(request);
    const name = body.name === undefined ? user.name : String(body.name).trim();
    const username = body.username === undefined ? user.username : normalizeUsername(body.username);
    if (name.length < 2 || name.length > 48) {
      sendJson(response, 400, { error: "Name must be between 2 and 48 characters." });
      return;
    }
    let avatarPath = user.avatar_path;
    if (body.avatarData) avatarPath = persistImage(body.avatarData, "avatar").path;
    try {
      database.prepare("UPDATE users SET name = ?, username = ?, avatar_path = ?, last_active = ? WHERE id = ?")
        .run(name, username, avatarPath, Date.now(), user.id);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        sendJson(response, 409, { error: "That username is already in use." });
        return;
      }
      throw error;
    }
    logAudit(user.id, "user.profile.update", user.id);
    sendJson(response, 200, { user: cleanUser(database.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
    return;
  }

  if (pathname.startsWith("/api/chat/") || pathname.startsWith("/api/conversations") || pathname === "/api/statuses" || pathname === "/api/users/search") {
    if (!user || user.role !== "user" || user.account_status !== "active") {
      sendJson(response, user ? 403 : 401, { error: "An active user account is required." });
      return;
    }
    if (pathname === "/api/chat/bootstrap" && request.method === "GET") {
      cleanupExpiredStatuses();
      sendJson(response, 200, {
        conversations: getConversations(user.id),
        statuses: getVisibleStatuses(user.id)
      });
      return;
    }
    if (pathname === "/api/conversations" && request.method === "GET") {
      sendJson(response, 200, { conversations: getConversations(user.id) });
      return;
    }
    if (pathname === "/api/users/search" && request.method === "GET") {
      if (rateLimit(request, response, "users.search", 60)) return;
      const query = String(url.searchParams.get("q") || "").trim().slice(0, 64);
      const username = query.replace(/^@/, "").toLowerCase();
      const phone = normalizePhone(query);
      const results = query.length < 3 ? [] : database.prepare(`
        SELECT id, name, username, avatar_path, verification_level
        FROM users
        WHERE role = 'user' AND account_status = 'active' AND id != ?
          AND (lower(username) = ? OR phone = ?)
        LIMIT 10
      `).all(user.id, username, phone).map(cleanChatUser);
      sendJson(response, 200, { users: results });
      return;
    }
    if (pathname === "/api/conversations" && request.method === "POST") {
      if (rateLimit(request, response, "conversation.create", 30)) return;
      const body = await readJson(request, 8 * 1024);
      const recipientId = String(body.recipientId || "");
      if (!/^[0-9a-f-]{36}$/i.test(recipientId) || recipientId === user.id) {
        sendJson(response, 400, { error: "Choose a valid user to start a conversation." });
        return;
      }
      const recipient = database.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND account_status = 'active'").get(recipientId);
      if (!recipient) {
        sendJson(response, 404, { error: "That active user could not be found." });
        return;
      }
      const [participantLow, participantHigh] = [user.id, recipientId].sort();
      database.prepare(`
        INSERT INTO conversations (id, participant_low, participant_high, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(participant_low, participant_high) DO NOTHING
      `).run(randomUUID(), participantLow, participantHigh, Date.now(), Date.now());
      const conversation = database.prepare(`
        SELECT id FROM conversations WHERE participant_low = ? AND participant_high = ?
      `).get(participantLow, participantHigh);
      sendJson(response, 200, {
        conversation: getConversations(user.id).find((item) => item.id === conversation.id)
      });
      return;
    }
    const messagesMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})\/messages$/i);
    if (messagesMatch && request.method === "GET") {
      const conversation = database.prepare(`
        SELECT id FROM conversations
        WHERE id = ? AND (participant_low = ? OR participant_high = ?)
      `).get(messagesMatch[1], user.id, user.id);
      if (!conversation) {
        sendJson(response, 404, { error: "Conversation not found." });
        return;
      }
      const messages = database.prepare(`
        SELECT * FROM (
          SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 100
        ) ORDER BY created_at ASC, id ASC
      `).all(conversation.id).map((message) => cleanMessage(message, user.id));
      sendJson(response, 200, { messages });
      return;
    }
    if (pathname === "/api/statuses" && request.method === "POST") {
      if (rateLimit(request, response, "status.create", 20, 10 * 60_000)) return;
      const maxRequestSize = Math.ceil(maxStatusMediaBytes * 4 / 3) + 256 * 1024;
      const body = await readJson(request, maxRequestSize);
      const text = String(body.text || "").trim();
      const background = body.background == null ? null : String(body.background);
      const validBackgrounds = ["mint", "violet", "sunset", "ocean", "amber", "rose"];
      if (text.length > 240 || (!text && !body.mediaData) || (background && !validBackgrounds.includes(background))) {
        sendJson(response, 400, { error: "Provide status text or media, a valid background, and no more than 240 text characters." });
        return;
      }
      const media = body.mediaData ? persistStatusMedia(body.mediaData) : null;
      const now = Date.now();
      const statusId = randomUUID();
      try {
        database.prepare(`
          INSERT INTO statuses (id, user_id, text, background, media_path, media_type, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(statusId, user.id, text, background, media?.path || null, media?.mimeType || null, now, now + 24 * 60 * 60 * 1000);
      } catch (error) {
        if (media) removeStatusMedia(media.path);
        throw error;
      }
      const status = getVisibleStatuses(user.id).find((item) => item.id === statusId);
      broadcastToConversationPeers(user.id, { type: "status.created", status });
      sendJson(response, 201, { status });
      return;
    }
    sendJson(response, 404, { error: "Chat endpoint not found." });
    return;
  }

  if (pathname.startsWith("/api/admin/")) {
    if (!user || !["super_admin", "admin"].includes(user.role)) {
      sendJson(response, user ? 403 : 401, { error: "Administrator access required." });
      return;
    }
    if (pathname === "/api/admin/overview" && request.method === "GET") {
      sendJson(response, 200, {
        totalUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user'").get().count,
        activeUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user' AND last_active >= ?").get(Date.now() - 24 * 60 * 60 * 1000).count,
        verifiedUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user' AND verification_level IS NOT NULL").get().count,
        suspendedUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user' AND account_status = 'suspended'").get().count,
        bannedUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user' AND account_status = 'banned'").get().count,
        recentActivity: database.prepare(`
          SELECT action, target_id AS targetId, details, created_at AS createdAt
          FROM audit_logs ORDER BY id DESC LIMIT 12
        `).all().map((entry) => ({ ...entry, details: JSON.parse(entry.details) }))
      });
      return;
    }
    if (pathname === "/api/admin/users" && request.method === "GET") {
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
      const perPage = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("perPage") || "20", 10) || 20));
      const search = String(url.searchParams.get("search") || "").trim().slice(0, 100);
      const filter = url.searchParams.get("filter") || "all";
      const filters = {
        all: "",
        verified: "AND verification_level IS NOT NULL",
        unverified: "AND verification_level IS NULL",
        banned: "AND account_status = 'banned'",
        suspended: "AND account_status = 'suspended'",
        active: "AND account_status = 'active'"
      };
      if (!(filter in filters)) {
        sendJson(response, 400, { error: "Unsupported user filter." });
        return;
      }
      const where = `role = 'user' AND (? = '' OR name LIKE ? OR phone LIKE ? OR username LIKE ?) ${filters[filter]}`;
        const searchPattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const total = database.prepare(`SELECT count(*) AS count FROM users WHERE ${where}`).get(search, searchPattern, searchPattern, searchPattern).count;
      const orderBy = url.searchParams.get("sort") === "name" ? "name COLLATE NOCASE" : "created_at";
      const direction = url.searchParams.get("direction") === "asc" ? "ASC" : "DESC";
      const users = database.prepare(`
        SELECT * FROM users WHERE ${where} ORDER BY ${orderBy} ${direction} LIMIT ? OFFSET ?
      `).all(search, searchPattern, searchPattern, searchPattern, perPage, (page - 1) * perPage).map(cleanUser);
      sendJson(response, 200, { users, total, page, perPage });
      return;
    }
    if (pathname === "/api/admin/audit" && request.method === "GET") {
      const rows = database.prepare(`
        SELECT audit_logs.id, users.email AS actor, audit_logs.action, audit_logs.target_id AS targetId,
          audit_logs.details, audit_logs.created_at AS createdAt
        FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id
        ORDER BY audit_logs.id DESC LIMIT 100
      `).all().map((entry) => ({ ...entry, details: JSON.parse(entry.details) }));
      sendJson(response, 200, { entries: rows });
      return;
    }
    if (pathname === "/api/admin/brand" && request.method === "PATCH") {
      const body = await readJson(request, 32 * 1024);
      const fields = { appName: "app_name", appVerified: "app_verified", showVerifiedBadge: "show_verified_badge" };
      if (!Object.keys(body).length || Object.keys(body).some((key) => !(key in fields))) {
        sendJson(response, 400, { error: "Only appName, appVerified, and showVerifiedBadge can be updated here." });
        return;
      }
      for (const [key, column] of Object.entries(fields)) {
        if (!(key in body)) continue;
        let value;
        if (key === "appName") {
          value = String(body[key]).trim();
          if (value.length < 2 || value.length > 40) {
            sendJson(response, 400, { error: "App name must be between 2 and 40 characters." });
            return;
          }
        } else {
          if (typeof body[key] !== "boolean") {
            sendJson(response, 400, { error: `${key} must be true or false.` });
            return;
          }
          value = String(body[key]);
        }
        database.prepare("INSERT INTO brand_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(column, value);
      }
      logAudit(user.id, "brand.settings.update", null, body);
      applyBrand(response);
      return;
    }
    const assetMatch = pathname.match(/^\/api\/admin\/brand\/assets\/([a-z-]+)$/);
    if (assetMatch && request.method === "POST") {
      const slot = assetMatch[1];
      const supportedSlots = ["logo", "app-icon", "favicon", "default-avatar", "open-graph"];
      if (!supportedSlots.includes(slot)) {
        sendJson(response, 404, { error: "Unknown brand asset slot." });
        return;
      }
      const body = await readJson(request, 10 * 1024 * 1024);
      const image = passwordFromDataUrl(body.dataUrl, "brand");
      if (!image) {
        sendJson(response, 400, { error: "A brand image is required." });
        return;
      }
      const filename = `${randomUUID()}${imageTypes.get(image.mimeType) || image.extension}`;
      writeFileSync(join(uploadDirectory, filename), image.bytes, { flag: "wx" });
      const assetPath = `/uploads/${filename}`;
      database.prepare(`
        INSERT INTO brand_assets (slot, asset_path, mime_type, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET asset_path = excluded.asset_path, mime_type = excluded.mime_type, updated_at = excluded.updated_at
      `).run(slot, assetPath, image.mimeType, Date.now());
      logAudit(user.id, "brand.asset.update", slot, { mimeType: image.mimeType });
      applyBrand(response);
      return;
    }
    const userMatch = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)$/i);
    if (userMatch && request.method === "PATCH") {
      const targetId = userMatch[1];
      const target = database.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(targetId);
      if (!target) {
        sendJson(response, 404, { error: "User not found." });
        return;
      }
      const body = await readJson(request, 32 * 1024);
      const changes = {};
      if ("verificationLevel" in body) {
        const levels = [null, "verified", "business", "official"];
        if (!levels.includes(body.verificationLevel)) {
          sendJson(response, 400, { error: "Unsupported verification level." });
          return;
        }
        changes.verification_level = body.verificationLevel;
      }
      if ("accountStatus" in body) {
        if (!["active", "suspended", "banned"].includes(body.accountStatus)) {
          sendJson(response, 400, { error: "Unsupported account status." });
          return;
        }
        changes.account_status = body.accountStatus;
      }
      if ("internalNotes" in body) {
        const notes = String(body.internalNotes);
        if (notes.length > 2000) {
          sendJson(response, 400, { error: "Administrative notes must be 2,000 characters or less." });
          return;
        }
        changes.internal_notes = notes;
      }
      if (!Object.keys(changes).length) {
        sendJson(response, 400, { error: "No supported account changes were provided." });
        return;
      }
      const columns = Object.keys(changes);
      database.prepare(`UPDATE users SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
        .run(...Object.values(changes), targetId);
      if (changes.account_status && changes.account_status !== "active") {
        closeUserConnections(targetId, 4001, "Account is inactive.");
      }
      logAudit(user.id, "admin.user.update", targetId, changes);
      sendJson(response, 200, { user: cleanUser(database.prepare("SELECT * FROM users WHERE id = ?").get(targetId)) });
      return;
    }
    sendJson(response, 404, { error: "Admin endpoint not found." });
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API endpoint not found." });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"]
  };
  if (assets[pathname]) {
    const [filename, mimeType] = assets[pathname];
    serveFile(response, join(projectRoot, filename), mimeType);
    return;
  }
  const uploadMatch = pathname.match(/^\/uploads\/([a-f0-9-]+\.(?:png|jpg|webp|gif|svg|ico|mp4|webm))$/i);
  if (uploadMatch) {
    const filename = join(uploadDirectory, uploadMatch[1]);
    const extension = extname(filename).toLowerCase();
    const status = database.prepare("SELECT user_id FROM statuses WHERE media_path = ? AND expires_at > ?")
      .get(`/uploads/${uploadMatch[1]}`, Date.now());
    if (status) {
      const viewer = getSessionUser(request);
      const mayView = viewer?.account_status === "active" && (
        viewer.id === status.user_id || database.prepare(`
          SELECT 1 FROM conversations
          WHERE (participant_low = ? AND participant_high = ?)
             OR (participant_low = ? AND participant_high = ?)
          LIMIT 1
        `).get(viewer.id, status.user_id, status.user_id, viewer.id)
      );
      if (!mayView) {
        sendJson(response, 404, { error: "Media not found." });
        return;
      }
    }
    const mimeTypes = {
      ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
      ".svg": "image/svg+xml", ".ico": "image/x-icon",
      ".mp4": "video/mp4", ".webm": "video/webm"
    };
    const mimeType = mimeTypes[extension] || "image/png";
    const svgPolicy = extension === ".svg" ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" : undefined;
    if (extension === ".mp4" || extension === ".webm") {
      serveVideo(request, response, filename, mimeType);
      return;
    }
    serveFile(response, filename, mimeType, svgPolicy);
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

function createSession(response, userId) {
  const token = randomBytes(32).toString("base64url");
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(tokenHash(token), userId, Date.now() + sessionDurationMs);
  response.setHeader("Set-Cookie", sessionCookie(token, sessionDurationMs / 1000));
}

function getSessionUser(request) {
  const token = parseCookies(request)[cookieName];
  if (!token || token.length > 128) return null;
  const session = database.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash(token), Date.now());
  return session || null;
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("NEXVO request failed:", error);
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const status = Number.isInteger(error.status) ? error.status : 500;
    sendJson(response, status, { error: status === 500 ? "An internal server error occurred." : error.message });
  });
});

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
const expiredStatusCleanup = setInterval(() => {
  try {
    cleanupExpiredStatuses();
  } catch (error) {
    console.error("Unable to clean expired NEXVO statuses:", error);
  }
}, 5 * 60_000);
expiredStatusCleanup.unref();

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  if (pathname !== "/api/realtime" || !request.headers.origin || !originIsValid(request)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const user = getSessionUser(request);
  if (!user || user.role !== "user" || user.account_status !== "active") {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const userSockets = socketsByUser.get(user.id) || new Set();
  if (userSockets.size >= 5) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const token = parseCookies(request)[cookieName];
  const session = database.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash(token));
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request, user.id, tokenHash(token), session.expires_at);
  });
});

webSocketServer.on("connection", (socket, request, userId, sessionKey, sessionExpiresAt) => {
  const userSockets = socketsByUser.get(userId) || new Set();
  userSockets.add(socket);
  socketsByUser.set(userId, userSockets);
  socket.recentMessages = [];
  const expiryTimer = setTimeout(() => socket.close(4001, "Session expired."), Math.max(1, sessionExpiresAt - Date.now()));
  expiryTimer.unref();
  sendSocketEvent(socket, { type: "ready" });
  socket.on("message", (data, isBinary) => {
    try {
      handleRealtimeMessage(socket, userId, sessionKey, data, isBinary);
    } catch (error) {
      console.error("NEXVO realtime message failed:", error);
      sendSocketEvent(socket, { type: "error", error: "The message could not be processed." });
    }
  });
  socket.on("close", () => {
    clearTimeout(expiryTimer);
    const activeSockets = socketsByUser.get(userId);
    activeSockets?.delete(socket);
    if (activeSockets?.size === 0) socketsByUser.delete(userId);
  });
  socket.on("error", (error) => console.error("NEXVO WebSocket error:", error));
});

function closeServer() {
  clearInterval(expiredStatusCleanup);
  for (const userSockets of socketsByUser.values()) {
    for (const socket of userSockets) socket.terminate();
  }
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);

if (process.argv[1] && resolve(process.argv[1]) === resolve(projectRoot, "server.mjs")) {
  const port = Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`NEXVO listening on http://${host}:${port}`);
  });
}

export { server, database };
