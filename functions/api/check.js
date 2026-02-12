export async function onRequestPost({ request, env }) {
export async function onRequestPost({ request }) {
  try {
    const body = await request.json().catch(() => ({}));
    const username = (body.username || "").toString().trim();
    const platforms = Array.isArray(body.platforms) ? body.platforms : [];
    const body = await request.json();
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const platforms = Array.isArray(body?.platforms) ? body.platforms : [];

    // Basic request validation
    if (!username) return json({ error: "Username is required" }, 400);
    if (username.length < 2 || username.length > 32) return json({ error: "Username must be 2–32 chars" }, 400);
    if (!/^[a-zA-Z0-9._]{1,32}$/.test(username)) return json({ error: "Invalid username format" }, 400);
    if (!platforms.length) return json({ error: "Select at least one platform" }, 400);
    if (username.length < 2 || username.length > 32) {
      return json({ error: "Username must be 2–32 chars" }, 400);
    }
    if (!Array.isArray(platforms) || platforms.length === 0) {
      return json({ error: "Select at least one platform" }, 400);
    }

    // Normalize platform IDs to avoid case mismatch bugs (e.g. "Roblox")
    const normalizedPlatforms = platforms
      .map((p) => String(p || "").trim().toLowerCase())
      .filter(Boolean);

    const results = await Promise.all(platforms.map((p) => checkPlatform(p, username, env)));
    return json({ results });
  } catch (e) {
    const results = await Promise.all(
      normalizedPlatforms.map((platform) => checkPlatform(platform, username))
    );

    return json({ results }, 200);
  } catch (err) {
    return json({ error: "Bad request" }, 400);
  }
}
@@ -26,418 +38,88 @@ function json(obj, status = 200) {
  });
}

/**
 * Fetch helper with:
 * - timeout (Workers-friendly)
 * - basic headers that reduce bot “weird responses”
 * - optional redirect control
 */
async function smartFetch(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 7000;

  const headers = new Headers(opts.headers || {});
  if (!headers.has("User-Agent")) headers.set("User-Agent", "Mozilla/5.0 (compatible; taken.gg/1.0; +https://taken.gg)");
  if (!headers.has("Accept")) headers.set("Accept", "text/html,application/json;q=0.9,*/*;q=0.8");
  if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9");

  const init = {
    method: opts.method || "GET",
    headers,
    redirect: opts.redirect || "follow",
    body: opts.body,
    signal: AbortSignal.timeout(timeoutMs),
  };

  return fetch(url, init);
}

async function checkPlatform(platform, username, env) {
async function checkPlatform(platform, username) {
  switch (platform) {
    case "x":
      return checkX(username);
    case "roblox":
      return checkRobloxStrict(username);

    // Keep others as unknown for now (or your existing logic)
    case "tiktok":
      return checkTikTok(username);

    case "x":
    case "instagram":
      return checkInstagram(username);

    case "roblox":
      return checkRoblox(username);

    case "discord":
      // No public reliable username existence check without OAuth/bot presence.
      return { platform: "discord", status: "unknown" };
      return { platform, status: "unknown" };

    default:
      return { platform, status: "unknown" };
  }
}

/* -------------------------
   X (Twitter) — best method
   -------------------------
   Uses public syndication endpoint:
   - If user exists → returns array with objects
   - If not → returns []
*/
async function checkX(username) {
  const url = `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${encodeURIComponent(username)}`;

  try {
    const res = await smartFetch(url, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      timeoutMs: 6000,
    });

    if (res.status === 200) {
      const data = await res.json().catch(() => null);
      const exists = Array.isArray(data) && data.length > 0 && data[0]?.screen_name;
      if (exists) return { platform: "x", status: "taken", url: `https://x.com/${username}` };
      return { platform: "x", status: "available" };
    }

    // rate-limited / blocked
    if (res.status === 429 || res.status === 403) return { platform: "x", status: "unknown" };
    return { platform: "x", status: "unknown" };
  } catch {
    return { platform: "x", status: "unknown" };
  }
}

/* -------------------------
   TikTok — oEmbed first
   -------------------------
   TikTok profile pages are very unreliable via server-side fetch.
   The oEmbed endpoint tends to be much more consistent.
*/
async function checkTikTok(username) {
  const profileUrl = `https://www.tiktok.com/@${username}`;
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(profileUrl)}`;

  // 1) Try oEmbed
  try {
    const res = await smartFetch(oembedUrl, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      timeoutMs: 6500,
    });

    if (res.status === 200) {
      const data = await res.json().catch(() => null);
      // If oEmbed returns author_name / title, it almost always means it exists.
      if (data && (data.author_name || data.title || data.html)) {
        return { platform: "tiktok", status: "taken", url: profileUrl };
      }
      // If it returns something weird but 200, treat as unknown
      return { platform: "tiktok", status: "unknown" };
    }

    // Common: 404/400 when profile/user not found
    if (res.status === 404 || res.status === 400) {
      return { platform: "tiktok", status: "available" };
    }

    if (res.status === 429 || res.status === 403) return { platform: "tiktok", status: "unknown" };
  } catch {
    // continue to fallback
  }

  // 2) Fallback: fetch HTML and search for “not found” signals
  try {
    const res = await smartFetch(profileUrl, { redirect: "follow", timeoutMs: 7500 });

    if (res.status === 404) return { platform: "tiktok", status: "available" };
    if (res.status === 403 || res.status === 429) return { platform: "tiktok", status: "unknown" };

    const text = await res.text().catch(() => "");
    const lower = text.toLowerCase();

    // Keywords TikTok shows on missing profiles (varies by region/ui)
    const notFoundSignals = [
      "couldn't find this account",
      "could not find this account",
      "this account doesn't exist",
      "this account is private",
      "page not available",
      "isn't available",
    ];

    // If it clearly says "couldn't find", mark available
    if (notFoundSignals.some((s) => lower.includes(s))) {
      return { platform: "tiktok", status: "available" };
    }

    // If HTML is tiny / looks like a bot wall, mark unknown
    if (text.length < 1200) return { platform: "tiktok", status: "unknown" };

    // Otherwise likely exists (or at least not a clear “not found”)
    return { platform: "tiktok", status: "taken", url: profileUrl };
  } catch {
    return { platform: "tiktok", status: "unknown" };
  }
}

/* -------------------------
   Instagram — API attempt first
   -------------------------
   This endpoint sometimes works without cookies (not guaranteed):
   https://www.instagram.com/api/v1/users/web_profile_info/?username=
*/
async function checkInstagram(username) {
  const profileUrl = `https://www.instagram.com/${username}/`;
  const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
/**
 * STRICT ROBLOX CHECK (public API only)
 * Endpoint: POST https://users.roblox.com/v1/usernames/users
 *
 * Rules:
 * - If API returns a matching user in data[] => taken
 * - If API returns empty data[] => available
 * - If API returns errors / rate-limit / network failure => unknown
 */
async function checkRobloxStrict(username) {
  const platform = "roblox";

  // 1) Try JSON endpoint
  try {
    const res = await smartFetch(apiUrl, {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-IG-App-ID": "936619743392459", // common web app id (doesn’t guarantee access, but helps sometimes)
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      redirect: "follow",
      timeoutMs: 6500,
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: false
      }),
    });

    // If it works:
    if (res.status === 200) {
      const data = await res.json().catch(() => null);
      const user = data?.data?.user;
      if (user && user.username) return { platform: "instagram", status: "taken", url: profileUrl };
      // If structure differs, fallback to HTML
    // Hard failures: keep unknown (do NOT guess)
    if (!res.ok) {
      return { platform, status: "unknown", reason: `roblox_http_${res.status}` };
    }

    // Some cases return 404 when not found
    if (res.status === 404) return { platform: "instagram", status: "available" };
    const data = await res.json();

    // Blocked / challenge / rate limit
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      // fallback to HTML check
    // Roblox may return { data: [...] } and/or { errors: [...] }
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      return { platform, status: "unknown", reason: "roblox_errors" };
    }
  } catch {
    // continue to fallback
  }

  // 2) Fallback: fetch profile HTML and look for “not available”
  try {
    const res = await smartFetch(profileUrl, { redirect: "follow", timeoutMs: 7500 });

    if (res.status === 404) return { platform: "instagram", status: "available" };
    if (res.status === 403 || res.status === 429) return { platform: "instagram", status: "unknown" };

    const text = await res.text().catch(() => "");
    const lower = text.toLowerCase();

    // Instagram “missing profile” UI usually contains this text:
    const notFoundSignals = [
      "sorry, this page isn't available",
      "the link you followed may be broken",
      "page isn't available",
      "page not found",
    ];

    if (notFoundSignals.some((s) => lower.includes(s))) {
      return { platform: "instagram", status: "available" };
    if (!Array.isArray(data?.data)) {
      return { platform, status: "unknown", reason: "roblox_invalid_shape" };
    }

    // If it’s just a login wall, we can’t be 100% sure:
    // treat as unknown rather than lying.
    const looksLikeLoginWall =
      lower.includes("log in") && (lower.includes("sign up") || lower.includes("instagram"));

    if (looksLikeLoginWall && text.length < 50000) {
      return { platform: "instagram", status: "unknown" };
    }

    // Otherwise likely exists
    return { platform: "instagram", status: "taken", url: profileUrl };
  } catch {
    return { platform: "instagram", status: "unknown" };
  }
}

/* -------------------------
   Roblox — best approach (your method)
   ------------------------- */
// ---------- Roblox (hardened) ----------

// Roblox username format constraints (public-facing practical constraints)
export async function onRequestPost({ request }) {
  try {
    const body = await request.json();
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const platforms = Array.isArray(body?.platforms) ? body.platforms : [];

    // Basic request validation
    if (!username) return json({ error: "Username is required" }, 400);
    if (username.length < 2 || username.length > 32) {
      return json({ error: "Username must be 2–32 chars" }, 400);
    }
    if (!Array.isArray(platforms) || platforms.length === 0) {
      return json({ error: "Select at least one platform" }, 400);
    }

    // Normalize platform IDs to avoid case mismatch bugs (e.g. "Roblox")
    const normalizedPlatforms = platforms
      .map((p) => String(p || "").trim().toLowerCase())
      .filter(Boolean);

    const results = await Promise.all(
      normalizedPlatforms.map((platform) => checkPlatform(platform, username))
    );

    return json({ results }, 200);
  } catch (err) {
    return json({ error: "Bad request" }, 400);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function checkPlatform(platform, username) {
  switch (platform) {
    case "roblox":
      return checkRobloxStrict(username);

    // Keep others as unknown for now (or your existing logic)
    case "tiktok":
    case "x":
    case "instagram":
    case "discord":
      return { platform, status: "unknown" };

    default:
      return { platform, status: "unknown" };
  }
}

/**
 * STRICT ROBLOX CHECK (public API only)
 * Endpoint: POST https://users.roblox.com/v1/usernames/users
 *
 * Rules:
 * - If API returns a matching user in data[] => taken
 * - If API returns empty data[] => available
 * - If API returns errors / rate-limit / network failure => unknown
 */
async function checkRobloxStrict(username) {
  const platform = "roblox";

  try {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: false
      }),
    });

    // Hard failures: keep unknown (do NOT guess)
    if (!res.ok) {
      return { platform, status: "unknown", reason: `roblox_http_${res.status}` };
    }

    const data = await res.json();

    // Roblox may return { data: [...] } and/or { errors: [...] }
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      return { platform, status: "unknown", reason: "roblox_errors" };
    }

    if (!Array.isArray(data?.data)) {
      return { platform, status: "unknown", reason: "roblox_invalid_shape" };
    }

    // Exact case-insensitive username match
    const found = data.data.find(
      (u) =>
        u &&
        typeof u.name === "string" &&
        u.name.toLowerCase() === username.toLowerCase() &&
        (typeof u.id === "number" || typeof u.id === "string")
    );

    if (found) {
      const userId = found.id;
      return {
        platform,
        status: "taken",
        userId,
        username: found.name,
        displayName: found.displayName ?? null,
        url: `https://www.roblox.com/users/${userId}/profile`,
      };
    }

    // No user returned for that username => available
    return { platform, status: "available" };
  } catch {
    return { platform, status: "unknown", reason: "roblox_network_error" };
  }
}
