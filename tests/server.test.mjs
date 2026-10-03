import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const adminPassword = "test-only-unique-password-29";
const sessionSecret = "test-session-secret-random-value-123456789";
let child;
let baseUrl;
let dataDirectory;

before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "nexvo-server-test-"));
  const socket = createTcpServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      ADMIN_EMAIL: "admin@example.test",
      ADMIN_PASSWORD: adminPassword,
      SESSION_SECRET: sessionSecret,
      NEXVO_DATA_DIR: dataDirectory,
      HOST: "0.0.0.0",
      PORT: String(port),
      NODE_ENV: "production",
      SESSION_COOKIE_SECURE: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`NEXVO server exited during startup: ${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`NEXVO server did not start in time: ${serverOutput}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Cookie: token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, json: await response.json().catch(() => ({})) };
}

async function connectSocket(cookie) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/realtime`, {
    headers: { Cookie: cookie, Origin: baseUrl.replace(/^http:/, "https:") }
  });
  const events = [];
  const waiters = [];
  socket.on("message", (data) => {
    const event = JSON.parse(data.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(event));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    } else {
      events.push(event);
    }
  });
  const waitFor = (predicate) => {
    const existingIndex = events.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(events.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for a realtime event."));
        }, 5000)
      };
      waiters.push(waiter);
    });
  };
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitFor((event) => event.type === "ready");
  return { socket, waitFor };
}

test("accounts, protected admin operations, verification, and Brand Studio persist safely", async () => {
  const initialBrand = await request("/api/brand");
  assert.equal(initialBrand.response.status, 200);
  assert.equal(initialBrand.json.appName, "NEXVO");
  const missingUpload = await fetch(`${baseUrl}/uploads/00000000-0000-0000-0000-000000000000.png`);
  assert.equal(missingUpload.status, 404);
  assert.equal((await request("/healthz")).json.status, "ok");

  const registration = await request("/api/auth/register", {
    method: "POST",
    body: {
      name: "Mina Test",
      username: "mina_test",
      phone: "+966 500 111 222",
      password: "a-unique-password-with-more-than-12-characters"
    }
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.json.user.username, "mina_test");
  assert.equal(registration.json.user.verificationLevel, null);
  assert.match(registration.response.headers.get("set-cookie"), /;\s*Secure(?:;|$)/);
  const userCookie = registration.response.headers.get("set-cookie").split(";")[0];

  const forbidden = await request("/api/admin/overview", { token: userCookie });
  assert.equal(forbidden.response.status, 403);

  const userLogin = await request("/api/auth/login", {
    method: "POST",
    body: { identifier: "+966500111222", password: "a-unique-password-with-more-than-12-characters" }
  });
  assert.equal(userLogin.response.status, 200);
  const badPassword = await request("/api/auth/login", {
    method: "POST",
    body: { identifier: "+966500111222", password: "wrong-password" }
  });
  assert.equal(badPassword.response.status, 401);

  const adminLogin = await request("/api/auth/login", {
    method: "POST",
    body: { identifier: "admin@example.test", password: adminPassword }
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.response.headers.get("set-cookie").split(";")[0];

  const users = await request("/api/admin/users?filter=unverified&search=mina", { token: adminCookie });
  assert.equal(users.response.status, 200);
  assert.equal(users.json.total, 1);
  const userId = users.json.users[0].id;
  const verified = await request(`/api/admin/users/${userId}`, {
    token: adminCookie,
    method: "PATCH",
    body: { verificationLevel: "verified", accountStatus: "active" }
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.json.user.verificationLevel, "verified");

  const brand = await request("/api/admin/brand", {
    token: adminCookie,
    method: "PATCH",
    body: { appName: "NEXVO Studio", appVerified: true, showVerifiedBadge: true }
  });
  assert.equal(brand.response.status, 200);
  assert.equal(brand.json.appVerified, true);

  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="teal"/></svg>').toString("base64")}`;
  const uploaded = await request("/api/admin/brand/assets/logo", {
    token: adminCookie,
    method: "POST",
    body: { dataUrl: svgDataUrl }
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.json.assets.logo.mimeType, "image/svg+xml");
  const asset = await fetch(`${baseUrl}${uploaded.json.assets.logo.path}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-security-policy"), /sandbox/);

  const audit = await request("/api/admin/audit", { token: adminCookie });
  assert.equal(audit.response.status, 200);
  assert.ok(audit.json.entries.some((entry) => entry.action === "admin.user.update"));

  const secondRegistration = await request("/api/auth/register", {
    method: "POST",
    body: {
      name: "Omar Test",
      username: "omar_test",
      phone: "+1 555 222 3333",
      password: "another-unique-password-with-more-than-12-characters"
    }
  });
  assert.equal(secondRegistration.response.status, 201);
  const secondUserCookie = secondRegistration.response.headers.get("set-cookie").split(";")[0];
  const search = await request("/api/users/search?q=%40omar_test", { token: userCookie });
  assert.equal(search.response.status, 200);
  assert.equal(search.json.users.length, 1);
  assert.equal(search.json.users[0].phone, undefined);
  const createdConversation = await request("/api/conversations", {
    token: userCookie,
    method: "POST",
    body: { recipientId: search.json.users[0].id }
  });
  assert.equal(createdConversation.response.status, 200);
  const conversationId = createdConversation.json.conversation.id;
  const secondConversation = await request("/api/conversations", {
    token: secondUserCookie,
    method: "POST",
    body: { recipientId: userId }
  });
  assert.equal(secondConversation.json.conversation.id, conversationId);

  const firstSocket = await connectSocket(userCookie);
  const secondSocket = await connectSocket(secondUserCookie);
  const clientMessageId = crypto.randomUUID();
  const firstMessage = firstSocket.waitFor((event) => event.type === "message.created");
  const secondMessage = secondSocket.waitFor((event) => event.type === "message.created");
  firstSocket.socket.send(JSON.stringify({
    type: "message.send",
    conversationId,
    clientMessageId,
    text: "Realtime message"
  }));
  const [sentEvent, receivedEvent] = await Promise.all([firstMessage, secondMessage]);
  assert.equal(sentEvent.message.text, "Realtime message");
  assert.equal(sentEvent.message.mine, true);
  assert.equal(receivedEvent.message.mine, false);
  assert.equal(receivedEvent.message.clientMessageId, clientMessageId);
  const history = await request(`/api/conversations/${conversationId}/messages`, { token: secondUserCookie });
  assert.equal(history.json.messages.length, 1);
  assert.equal(history.json.messages[0].text, "Realtime message");

  const peerStatus = secondSocket.waitFor((event) => event.type === "status.created");
  const createdStatus = await request("/api/statuses", {
    token: userCookie,
    method: "POST",
    body: { text: "A persistent status", background: "violet" }
  });
  assert.equal(createdStatus.response.status, 201);
  assert.equal(createdStatus.json.status.expiresAt - createdStatus.json.status.createdAt, 24 * 60 * 60 * 1000);
  assert.equal((await peerStatus).status.id, createdStatus.json.status.id);
  const secondBootstrap = await request("/api/chat/bootstrap", { token: secondUserCookie });
  assert.equal(secondBootstrap.json.statuses.length, 1);
  assert.equal(secondBootstrap.json.statuses[0].owner.id, userId);

  const pngDataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64")}`;
  const mediaStatus = await request("/api/statuses", {
    token: userCookie,
    method: "POST",
    body: { text: "Private image status", mediaData: pngDataUrl }
  });
  assert.equal(mediaStatus.response.status, 201);
  const peerMedia = await fetch(`${baseUrl}${mediaStatus.json.status.mediaUrl}`, { headers: { Cookie: secondUserCookie } });
  assert.equal(peerMedia.status, 200);
  const unrelatedMedia = await fetch(`${baseUrl}${mediaStatus.json.status.mediaUrl}`, { headers: { Cookie: adminCookie } });
  assert.equal(unrelatedMedia.status, 404);
  const mp4 = Buffer.alloc(16);
  mp4.write("ftyp", 4, "ascii");
  const videoStatus = await request("/api/statuses", {
    token: userCookie,
    method: "POST",
    body: { text: "Video status", mediaData: `data:video/mp4;base64,${mp4.toString("base64")}` }
  });
  assert.equal(videoStatus.response.status, 201);
  const videoRange = await fetch(`${baseUrl}${videoStatus.json.status.mediaUrl}`, {
    headers: { Cookie: secondUserCookie, Range: "bytes=4-7" }
  });
  assert.equal(videoRange.status, 206);
  assert.equal(videoRange.headers.get("content-range"), "bytes 4-7/16");

  const duplicateAck = firstSocket.waitFor((event) => event.type === "message.created" && event.message.clientMessageId === clientMessageId);
  firstSocket.socket.send(JSON.stringify({
    type: "message.send",
    conversationId,
    clientMessageId,
    text: "Realtime message"
  }));
  await duplicateAck;
  const repeatedHistory = await request(`/api/conversations/${conversationId}/messages`, { token: secondUserCookie });
  assert.equal(repeatedHistory.json.messages.length, 1);

  firstSocket.socket.close();
  secondSocket.socket.close();
});
