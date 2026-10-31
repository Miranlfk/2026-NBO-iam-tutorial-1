import { API_BASE_URL } from "./config.js";

// CDS keys `application_data` by the Asgardeo application ID, not the OAuth client ID.
export { ASGARDEO_APPLICATION_ID, ASGARDEO_CLIENT_ID } from "./config.js";

const CDS_PROFILE_ID_STORAGE_KEY = "cds_profile_id";
const CDS_ANON_TRACKER_STORAGE_KEY = "cds_anonymous_profile_tracker";

let cdsProfileCreatePromise = null;
let cdsProfileId = null;
let cdsAnonymousProfileTracker = null;

function getStorageValue(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStorageValue(key, value) {
  if (!value) {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage write errors and continue with in-memory values.
  }
}

function removeStorageValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage removal errors.
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    },
    ...options
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const requestError = new Error(body.error || "API request failed");

    requestError.status = response.status;

    throw requestError;
  }

  return body;
}

export async function createCDSProfile(profilePayload = {}) {
  return requestJson("/api/cds/profiles", {
    method: "POST",
    body: JSON.stringify(profilePayload)
  });
}

export async function ensureCDSProfile(profilePayload = {}) {
  if (cdsProfileId) {
    return {
      profile_id: cdsProfileId,
      anonymous_profile_tracker: cdsAnonymousProfileTracker
    };
  }

  const storedProfileId = getStorageValue(CDS_PROFILE_ID_STORAGE_KEY);
  const storedAnonymousProfileTracker = getStorageValue(CDS_ANON_TRACKER_STORAGE_KEY);

  if (storedProfileId) {
    cdsProfileId = storedProfileId;
    cdsAnonymousProfileTracker = storedAnonymousProfileTracker || null;

    return {
      profile_id: storedProfileId,
      anonymous_profile_tracker: cdsAnonymousProfileTracker
    };
  }

  if (!cdsProfileCreatePromise) {
    cdsProfileCreatePromise = createCDSProfile(profilePayload)
      .then((response) => {
        cdsProfileId = response.profile_id || response.id || null;
        cdsAnonymousProfileTracker = response.anonymous_profile_tracker || null;

        if (cdsProfileId) {
          setStorageValue(CDS_PROFILE_ID_STORAGE_KEY, cdsProfileId);
        }

        if (cdsAnonymousProfileTracker) {
          setStorageValue(CDS_ANON_TRACKER_STORAGE_KEY, cdsAnonymousProfileTracker);
        }

        return response;
      })
      .finally(() => {
        cdsProfileCreatePromise = null;
      });
  }

  return cdsProfileCreatePromise;
}

export async function updateCDSProfile(profileId, profilePayload = {}) {
  if (!profileId) {
    throw new Error("Profile ID is required");
  }

  return requestJson(`/api/cds/profiles/${profileId}`, {
    method: "PATCH",
    body: JSON.stringify(profilePayload)
  });
}

export async function getCDSProfile(profileId) {
  if (!profileId) {
    throw new Error("Profile ID is required");
  }

  return requestJson(
    `/api/cds/profiles/${profileId}?application_identifier=*&includeApplicationData=true`,
    { method: "GET" }
  );
}

// Temporary (anonymous) CDS profiles can be removed server-side, which leaves the cached
// profile ID in local storage pointing at a profile that no longer exists. Every call then
// fails with a 404, so replace the stale ID with a fresh profile and retry once.
function isProfileNotFoundError(error) {
  return error?.status === 404;
}

async function replaceStaleCDSProfile() {
  clearCDSCookies();

  const profile = await ensureCDSProfile({});

  return profile?.profile_id || profile?.id || null;
}

export async function getCDSProfileWithRecovery(profileId) {
  try {
    return { profile: await getCDSProfile(profileId), profileId };
  } catch (error) {
    if (!isProfileNotFoundError(error)) {
      throw error;
    }

    const replacementProfileId = await replaceStaleCDSProfile();

    if (!replacementProfileId) {
      throw error;
    }

    return {
      profile: await getCDSProfile(replacementProfileId),
      profileId: replacementProfileId
    };
  }
}

export async function updateCDSProfileWithRecovery(profileId, profilePayload = {}) {
  try {
    return { profile: await updateCDSProfile(profileId, profilePayload), profileId };
  } catch (error) {
    if (!isProfileNotFoundError(error)) {
      throw error;
    }

    const replacementProfileId = await replaceStaleCDSProfile();

    if (!replacementProfileId) {
      throw error;
    }

    return {
      profile: await updateCDSProfile(replacementProfileId, profilePayload),
      profileId: replacementProfileId
    };
  }
}

export function initializeCDSFromCookie() {
  const profileId = getStorageValue(CDS_PROFILE_ID_STORAGE_KEY);
  const anonymousProfileTracker = getStorageValue(CDS_ANON_TRACKER_STORAGE_KEY);

  if (profileId) {
    cdsProfileId = profileId;
  }

  if (anonymousProfileTracker) {
    cdsAnonymousProfileTracker = anonymousProfileTracker;
  }

  return profileId;
}

export function getAnonymousProfileTracker() {
  if (cdsAnonymousProfileTracker) {
    return cdsAnonymousProfileTracker;
  }

  const storedAnonymousProfileTracker = getStorageValue(CDS_ANON_TRACKER_STORAGE_KEY);

  if (storedAnonymousProfileTracker) {
    cdsAnonymousProfileTracker = storedAnonymousProfileTracker;
  }

  return cdsAnonymousProfileTracker;
}

export async function createSignInConfigWithCDSTracker() {
  let anonymousProfileTracker = getAnonymousProfileTracker();

  if (!anonymousProfileTracker) {
    try {
      const profile = await ensureCDSProfile({});
      anonymousProfileTracker = profile?.anonymous_profile_tracker || getAnonymousProfileTracker();
    } catch {
      anonymousProfileTracker = getAnonymousProfileTracker();
    }
  }

  return anonymousProfileTracker
    ? { anonymous_profile_tracker: anonymousProfileTracker }
    : {};
}

export function clearCDSCookies() {
  removeStorageValue(CDS_PROFILE_ID_STORAGE_KEY);
  removeStorageValue(CDS_ANON_TRACKER_STORAGE_KEY);
  cdsProfileId = null;
  cdsAnonymousProfileTracker = null;
  cdsProfileCreatePromise = null;
}
