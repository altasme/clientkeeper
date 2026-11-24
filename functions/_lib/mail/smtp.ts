// A real SMTP client (RFC 5321 + RFC 3207 STARTTLS + RFC 4954 AUTH) that
// runs on the Cloudflare Workers runtime over raw TCP. The socket itself is
// injected (SmtpConnector), so this file has no `cloudflare:sockets` import
// and is unit-tested under Node against a scripted fake server
// (tests/mail/smtp.test.ts); the real connector lives in smtpTransport.ts.
//
// Deliberately NOT Resend or any HTTP email API: the operator asked for
// literal SMTP for the webmail module (the existing Resend helper in
// functions/_lib/email.ts is untouched and still used by its own callers).
//
// Error model (drives retry policy in send.ts):
//   - 4xx reply / network error / timeout BEFORE the end-of-data marker
//     was sent  -> transient (safe to retry: the server hasn't accepted it)
//   - 5xx reply  -> permanent (never auto-retried)
//   - connection lost / timeout AFTER the end-of-data marker was written
//     but before the server's reply was read -> outcome UNKNOWN (the
//     server may have accepted and queued it). Never auto-retried, because
//     retrying could send a duplicate; surfaced to a human instead.
// Error messages carry the SMTP reply code and the server's reply text
// (e.g. "550 5.1.1 mailbox unavailable") but never any AUTH payload or a
// session transcript, and are length-capped.

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  clientName?: string; // EHLO name
  timeoutMs?: number;
}

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
  /** Upgrades a plaintext connection to TLS (STARTTLS); returns the new socket. */
  startTls?(): SmtpSocket;
}

export type SmtpConnector = (opts: { host: string; port: number; security: SmtpSecurity }) => SmtpSocket | Promise<SmtpSocket>;

export interface SmtpEnvelope {
  from: string;
  recipients: string[];
}

export interface SmtpResult {
  code: number;
  response: string; // server's final reply text, e.g. "2.0.0 Ok: queued as ABC123"
}

export type SmtpFailureKind = "transient" | "permanent" | "unknown";

export class SmtpError extends Error {
  code: number | null;
  kind: SmtpFailureKind;
  stage: string;
  constructor(message: string, opts: { code?: number | null; kind: SmtpFailureKind; stage: string }) {
    super(message.slice(0, 400));
    this.name = "SmtpError";
    this.code = opts.code ?? null;
    this.kind = opts.kind;
    this.stage = opts.stage;
  }
}

interface Reply {
  code: number;
  lines: string[];
}

class LineReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async readLine(timeoutMs: number): Promise<string> {
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx !== -1) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        return line;
      }
      if (this.buffer.length > 64 * 1024) throw new Error("Reply line too long");
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for server")), timeoutMs);
      });
      try {
        const { value, done } = await Promise.race([this.reader.read(), timeout]);
        if (done) throw new Error("Connection closed by server");
        this.buffer += this.decoder.decode(value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  }
  release() {
    try {
      this.reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

export function dotStuff(data: string): string {
  const normalized = data.replace(/\r?\n/g, "\r\n");
  const stuffed = normalized.replace(/(^|\r\n)\./g, "$1..");
  return stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`;
}

function b64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function assertSafeCommandArg(value: string) {
  if (/[\r\n<>]/.test(value)) throw new SmtpError("Invalid address in SMTP envelope", { kind: "permanent", stage: "envelope" });
}

/**
 * Sends one message over one SMTP session. `data` is the full RFC 5322
 * message (headers + body, CRLF line endings, NOT yet dot-stuffed).
 */
export async function smtpSend(connector: SmtpConnector, config: SmtpConfig, envelope: SmtpEnvelope, data: string): Promise<SmtpResult> {
  if (config.security === "none" && !isLocalHost(config.host)) {
    // Plaintext SMTP with credentials over the public internet would leak
    // the password; only allowed against a local test server.
    throw new SmtpError("Refusing unencrypted SMTP to a non-local host", { kind: "permanent", stage: "config" });
  }
  if (!envelope.recipients.length) throw new SmtpError("No recipients", { kind: "permanent", stage: "envelope" });
  assertSafeCommandArg(envelope.from);
  envelope.recipients.forEach(assertSafeCommandArg);

  const timeoutMs = config.timeoutMs ?? 30_000;
  const encoder = new TextEncoder();
  let stage = "connect";
  let dataTerminatorSent = false;
  // Held in an object (not bare `let`s) so TypeScript doesn't narrow them
  // to `null` across the closures below.
  const conn: { socket?: SmtpSocket; reader?: LineReader; writer?: WritableStreamDefaultWriter<Uint8Array> } = {};

  const readReply = async (): Promise<Reply> => {
    const lines: string[] = [];
    while (true) {
      const line = await conn.reader!.readLine(timeoutMs);
      const m = line.match(/^(\d{3})([ -])(.*)$/);
      if (!m) throw new Error(`Malformed server reply`);
      lines.push(m[3]!);
      if (m[2] === " ") return { code: Number(m[1]), lines };
      if (lines.length > 200) throw new Error("Reply too long");
    }
  };
  const write = async (s: string) => {
    await conn.writer!.write(encoder.encode(s));
  };
  const expect = async (accept: number[], label: string, redact = false): Promise<Reply> => {
    const reply = await readReply();
    if (!accept.includes(reply.code)) {
      const text = redact ? "" : ` ${reply.lines.join(" ").slice(0, 200)}`;
      throw new SmtpError(`${label} rejected: ${reply.code}${text}`, {
        code: reply.code,
        kind: reply.code >= 500 ? "permanent" : "transient",
        stage: label,
      });
    }
    return reply;
  };
  const command = async (cmd: string, accept: number[], label: string, redact = false) => {
    stage = label;
    await write(`${cmd}\r\n`);
    return expect(accept, label, redact);
  };
  const attach = (s: SmtpSocket) => {
    conn.socket = s;
    conn.reader = new LineReader(s.readable);
    conn.writer = s.writable.getWriter();
  };

  try {
    attach(await connector({ host: config.host, port: config.port, security: config.security }));
    stage = "greeting";
    await expect([220], "greeting");
    const ehloName = (config.clientName || "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
    let ehlo = await command(`EHLO ${ehloName}`, [250], "EHLO");

    if (config.security === "starttls") {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
        throw new SmtpError("Server does not offer STARTTLS", { kind: "permanent", stage: "STARTTLS" });
      }
      await command("STARTTLS", [220], "STARTTLS");
      if (!conn.socket!.startTls) throw new SmtpError("TLS upgrade not supported by transport", { kind: "permanent", stage: "STARTTLS" });
      conn.reader!.release();
      conn.writer!.releaseLock();
      attach(conn.socket!.startTls());
      ehlo = await command(`EHLO ${ehloName}`, [250], "EHLO");
    }

    const authLine = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l)) ?? "";
    const mechanisms = authLine.toUpperCase().split(/[ =]+/).slice(1);
    if (config.username) {
      stage = "AUTH";
      if (mechanisms.includes("PLAIN") || !mechanisms.includes("LOGIN")) {
        await command(`AUTH PLAIN ${b64(`\u0000${config.username}\u0000${config.password}`)}`, [235], "AUTH", true);
      } else {
        await command("AUTH LOGIN", [334], "AUTH", true);
        await command(b64(config.username), [334], "AUTH", true);
        await command(b64(config.password), [235], "AUTH", true);
      }
    }

    const sizeSupported = ehlo.lines.some((l) => /^SIZE\b/i.test(l));
    const payload = dotStuff(data);
    const byteLength = encoder.encode(payload).length;
    await command(`MAIL FROM:<${envelope.from}>${sizeSupported ? ` SIZE=${byteLength}` : ""}`, [250], "MAIL FROM");
    for (const rcpt of envelope.recipients) {
      await command(`RCPT TO:<${rcpt}>`, [250, 251], "RCPT TO");
    }
    await command("DATA", [354], "DATA");
    stage = "message body";
    // Write in chunks so a large attachment doesn't build one giant buffer.
    const CHUNK = 64 * 1024;
    for (let i = 0; i < payload.length; i += CHUNK) await write(payload.slice(i, i + CHUNK));
    await write(".\r\n");
    dataTerminatorSent = true;
    stage = "end of data";
    const final = await expect([250], "end of data");
    try {
      await write("QUIT\r\n");
      await readReply();
    } catch {
      /* the message is already accepted; a failed QUIT changes nothing */
    }
    return { code: final.code, response: final.lines.join(" ").slice(0, 300) };
  } catch (err) {
    if (err instanceof SmtpError) {
      // Politely abort the transaction where possible.
      if (err.kind !== "unknown") {
        try {
          if (conn.writer) await conn.writer.write(encoder.encode("QUIT\r\n"));
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : "SMTP failure";
    if (dataTerminatorSent) {
      throw new SmtpError(`Connection problem after the message was handed to the server (${message}); it may or may not have been accepted`, {
        kind: "unknown",
        stage,
      });
    }
    throw new SmtpError(`Network error during ${stage}: ${message}`, { kind: "transient", stage });
  } finally {
    try {
      conn.reader?.release();
      conn.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await conn.socket?.close();
    } catch {
      /* ignore */
    }
  }
}
