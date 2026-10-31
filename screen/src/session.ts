// A tiny server-side session: the browser only holds an opaque, random id.
// Tokens never reach the screen's browser. In memory on purpose: one container,
// and a restart simply signs the screen out.

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { DeviceFlow, TokenSet, Traveller } from "./oauth.js";

export interface ScreenSession {
  device?: DeviceFlow;
  tokens?: TokenSet;
  traveller?: Traveller;
  notice?: string;
  lastSeen: number;
}

const COOKIE_NAME = "screen_sid";
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const sessions = new Map<string, ScreenSession>();

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return undefined;
}

export function getSession(request: Request): ScreenSession | undefined {
  const id = readCookie(request, COOKIE_NAME);
  const session = id ? sessions.get(id) : undefined;

  if (session) {
    session.lastSeen = Date.now();
  }

  return session;
}

export function getOrCreateSession(request: Request, response: Response): ScreenSession {
  const existing = getSession(request);

  if (existing) {
    return existing;
  }

  const id = randomBytes(32).toString("base64url");
  const session: ScreenSession = { lastSeen: Date.now() };

  sessions.set(id, session);
  response.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.secure,
    path: "/"
  });

  return session;
}

export function destroySession(request: Request, response: Response): void {
  const id = readCookie(request, COOKIE_NAME);

  if (id) {
    sessions.delete(id);
  }

  response.clearCookie(COOKIE_NAME, { path: "/" });
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;

  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) {
      sessions.delete(id);
    }
  }
}, 15 * 60 * 1000).unref();
