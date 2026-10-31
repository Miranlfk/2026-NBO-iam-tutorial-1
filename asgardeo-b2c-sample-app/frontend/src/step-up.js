import { useEffect, useState } from "react";
import { useAsgardeo } from "@asgardeo/react";

const RETURN_PATH_KEY = "wayfinder:return-to";

/**
 * Step-up re-authentication: sign the user in again with an acr_values the
 * Wayfinder login flow acts on (face liveness, the high-value payment policy),
 * then come back to the page that asked.
 *
 * The SDK's signIn() returns the current session when there is one, so the
 * SDK's own session data is cleared first. The identity provider's session is
 * kept; prompt=login makes it authenticate the user again for the new acr.
 */
export function startStepUp(signIn, acr) {
  try {
    const { pathname, search, hash } = window.location;

    sessionStorage.setItem(RETURN_PATH_KEY, `${pathname}${search}${hash}`);

    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("session_data")) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Without session storage the SDK keeps the session: nothing to step up.
  }

  return signIn({ acr_values: acr, prompt: "login" });
}

/** The page a step-up started from, once: a same-origin path or "". */
export function takeReturnPath() {
  try {
    const path = sessionStorage.getItem(RETURN_PATH_KEY) || "";

    sessionStorage.removeItem(RETURN_PATH_KEY);

    return path.startsWith("/") && !path.startsWith("//") ? path : "";
  } catch {
    return "";
  }
}

/**
 * How the current session was authenticated, from the ID token: acr (set by
 * the login flow for a step-up), amr and auth_time (seconds).
 */
export function useAuthenticationContext() {
  const { isSignedIn, getDecodedIdToken } = useAsgardeo();
  const [context, setContext] = useState({ acr: "", amr: [], authTime: 0 });

  useEffect(() => {
    let cancelled = false;

    if (!isSignedIn) {
      setContext({ acr: "", amr: [], authTime: 0 });

      return undefined;
    }

    getDecodedIdToken()
      .then((token) => {
        if (!cancelled) {
          setContext({
            acr: typeof token?.acr === "string" ? token.acr : "",
            amr: Array.isArray(token?.amr) ? token.amr : [],
            authTime: Number(token?.auth_time) || 0
          });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [getDecodedIdToken, isSignedIn]);

  return context;
}
