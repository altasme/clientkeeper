// A scripted in-memory SMTP server for exercising @altasme/webmail-kit's smtp.ts
// under Node without any network. Implements just enough of RFC 5321 to
// drive the client through every branch.

import type { SmtpConnector, SmtpSocket } from "@altasme/webmail-kit/smtp";

export interface FakeServerOptions {
  greeting?: string;
  ehloLines?: string[];
  authMechanisms?: string;
  rcptReply?: (rcpt: string) => string;
  dataReply?: string;
  dropAfterData?: boolean;
  authReply?: string;
  /** When set, AUTH succeeds (235) only for exactly these credentials, else 535. Overrides authReply. */
  credentials?: { username: string; password: string };
  /** Never send the greeting (simulates a server that accepts the TCP connection and then hangs). */
  silent?: boolean;
}

const AUTH_OK = "235 2.7.0 Authentication successful";
const AUTH_BAD = "535 5.7.8 Authentication credentials invalid";
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

export interface FakeServerLog {
  commands: string[];
  data: string;
  tlsUpgraded: boolean;
}

export function createFakeSmtp(opts: FakeServerOptions = {}): { connector: SmtpConnector; log: FakeServerLog } {
  const log: FakeServerLog = { commands: [], data: "", tlsUpgraded: false };
  const connector: SmtpConnector = () => makeSocket(opts, log, false);
  return { connector, log };
}

function makeSocket(opts: FakeServerOptions, log: FakeServerLog, tls: boolean, carry?: { greeted: boolean }): SmtpSocket {
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const fromClient = new TransformStream<Uint8Array, Uint8Array>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const out = toClient.writable.getWriter();
  const send = (s: string) => out.write(enc.encode(s + "\r\n"));
  let upgrade: (() => SmtpSocket) | undefined;
  let closed = false;

  const authResult = (username: string, password: string) => {
    if (opts.credentials) return username === opts.credentials.username && password === opts.credentials.password ? AUTH_OK : AUTH_BAD;
    return opts.authReply ?? AUTH_OK;
  };

  (async () => {
    if (opts.silent) return;
    if (!carry?.greeted) await send(opts.greeting ?? "220 fake.test ESMTP ready");
    const reader = fromClient.readable.getReader();
    let buf = "";
    let inData = false;
    let authLoginStep = 0;
    let authLoginUser = "";
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            if (opts.dropAfterData) {
              closed = true;
              await out.close();
              return;
            }
            await send(opts.dataReply ?? "250 2.0.0 Ok: queued as FAKE123");
          } else {
            log.data += line + "\r\n";
          }
          continue;
        }
        log.commands.push(line);
        if (authLoginStep === 1) {
          authLoginStep = 2;
          authLoginUser = unb64(line);
          await send("334 UGFzc3dvcmQ6");
          continue;
        }
        if (authLoginStep === 2) {
          authLoginStep = 0;
          await send(authResult(authLoginUser, unb64(line)));
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          const lines = opts.ehloLines ?? ["fake.test", "SIZE 35882577", ...(tls ? [] : ["STARTTLS"]), `AUTH ${opts.authMechanisms ?? "PLAIN LOGIN"}`];
          for (let i = 0; i < lines.length; i++) await send(`250${i === lines.length - 1 ? " " : "-"}${lines[i]}`);
        } else if (upper === "STARTTLS") {
          await send("220 2.0.0 Ready to start TLS");
          upgrade = () => {
            log.tlsUpgraded = true;
            closed = true;
            reader.releaseLock();
            return makeSocket(opts, log, true, { greeted: true });
          };
          return;
        } else if (upper.startsWith("AUTH PLAIN")) {
          const [, user = "", pass = ""] = unb64(line.slice("AUTH PLAIN ".length)).split("\u0000");
          await send(authResult(user, pass));
        } else if (upper === "AUTH LOGIN") {
          authLoginStep = 1;
          await send("334 VXNlcm5hbWU6");
        } else if (upper.startsWith("MAIL FROM")) {
          await send("250 2.1.0 Ok");
        } else if (upper.startsWith("RCPT TO")) {
          const rcpt = line.slice(line.indexOf("<") + 1, line.indexOf(">"));
          await send(opts.rcptReply ? opts.rcptReply(rcpt) : "250 2.1.5 Ok");
        } else if (upper === "DATA") {
          inData = true;
          await send("354 End data with <CR><LF>.<CR><LF>");
        } else if (upper === "QUIT") {
          await send("221 2.0.0 Bye");
          closed = true;
          await out.close().catch(() => undefined);
        } else {
          await send("502 5.5.2 Command not recognized");
        }
      }
    }
  })().catch(() => undefined);

  return {
    readable: toClient.readable,
    writable: fromClient.writable,
    close: async () => {
      closed = true;
    },
    startTls: () => {
      if (!upgrade) throw new Error("STARTTLS not negotiated");
      return upgrade();
    },
  };
}
