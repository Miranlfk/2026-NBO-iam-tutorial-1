// Server-side member sessions, indexed by SAML NameID + SessionIndex so that a
// back-channel LogoutRequest (which arrives from the IdP, without the member's
// browser or cookie) can find and end the right session. In memory: one
// container, and a restart signs everyone out of Rewards.

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

export interface MemberSession {
  id: string;
  nameID: string;
  nameIDFormat?: string;
  nameQualifier?: string;
  spNameQualifier?: string;
  sessionIndex?: string;
  issuer?: string;
  attributes: Record<string, string[]>;
  createdAt: number;
  lastSeen: number;
}

export interface EndedSession {
  reason: "single-logout";
  at: number;
}

const COOKIE_NAME = "rewards_sid";
const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const sessions = new Map<string, MemberSession>();
// The SAML key: NameID + SessionIndex -> ids of the sessions it opened.
const bySamlKey = new Map<string, Set<string>>();
// Remembers why a session ended, so the next visit can say "signed out by single logout".
const ended = new Map<string, EndedSession>();

function samlKey(nameID: string, sessionIndex = ""): string {
  return `${nameID}\n${sessionIndex}`;
}

function remove(session: MemberSession): void {
  sessions.delete(session.id);

  const key = samlKey(session.nameID, session.sessionIndex);
  const ids = bySamlKey.get(key);

  ids?.delete(session.id);

  if (ids?.size === 0) {
    bySamlKey.delete(key);
  }
}

function readCookie(request: Request): string | undefined {
  for (const part of (request.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");

    if (key === COOKIE_NAME) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return undefined;
}

export function createSession(
  request: Request,
  response: Response,
  data: Omit<MemberSession, "id" | "createdAt" | "lastSeen">
): MemberSession {
  const previous = readCookie(request);
  const previousSession = previous ? sessions.get(previous) : undefined;

  if (previousSession) {
    remove(previousSession);
  }

  if (previous) {
    ended.delete(previous);
  }

  const id = randomBytes(32).toString("base64url");
  const session: MemberSession = { ...data, id, createdAt: Date.now(), lastSeen: Date.now() };
  const key = samlKey(session.nameID, session.sessionIndex);

  sessions.set(id, session);
  bySamlKey.set(key, (bySamlKey.get(key) || new Set<string>()).add(id));
  response.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.secure,
    path: "/",
    maxAge: IDLE_TIMEOUT_MS
  });

  return session;
}

export function currentSession(request: Request): MemberSession | undefined {
  const id = readCookie(request);
  const session = id ? sessions.get(id) : undefined;

  if (session) {
    session.lastSeen = Date.now();
  }

  return session;
}

// Returns (once) why this browser's previous session ended, if it did.
export function takeEndedNotice(request: Request, response: Response): EndedSession | undefined {
  const id = readCookie(request);
  const notice = id ? ended.get(id) : undefined;

  if (id && notice) {
    ended.delete(id);
    response.clearCookie(COOKIE_NAME, { path: "/" });
  }

  return notice;
}

// Local sign-out from this browser.
export function endCurrentSession(request: Request, response: Response): MemberSession | undefined {
  const session = currentSession(request);

  if (session) {
    remove(session);
  }

  response.clearCookie(COOKIE_NAME, { path: "/" });
  return session;
}

// Back-channel single logout: end every session for this NameID and
// SessionIndex. A LogoutRequest without a SessionIndex ends all of the
// NameID's sessions (SAML 2.0 core, section 3.7.1).
export function endSessionsFor(nameID: string, sessionIndex?: string): MemberSession[] {
  const keys = sessionIndex
    ? [samlKey(nameID, sessionIndex)]
    : [...bySamlKey.keys()].filter((key) => key.startsWith(samlKey(nameID)));
  const matches = keys
    .flatMap((key) => [...(bySamlKey.get(key) || [])])
    .map((id) => sessions.get(id))
    .filter((session): session is MemberSession => session !== undefined);

  for (const session of matches) {
    remove(session);
    ended.set(session.id, { reason: "single-logout", at: Date.now() });
  }

  return matches;
}

export function activeSessionCount(): number {
  return sessions.size;
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;

  for (const session of sessions.values()) {
    if (session.lastSeen < cutoff) {
      remove(session);
    }
  }

  for (const [id, notice] of ended) {
    if (notice.at < cutoff) {
      ended.delete(id);
    }
  }
}, 15 * 60 * 1000).unref();
