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
