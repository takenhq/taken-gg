export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const username = (body.username || "").toString().trim();
    const platforms = Array.isArray(body.platforms) ? body.platforms : [];

    if (!username) return json({ error: "Username is required" }, 400);
    if (username.length < 2 || username.length > 32) return json({ error: "Username must be 2–32 chars" }, 400);
    if (!/^[a-zA-Z0-9._]{1,32}$/.test(username)) return json({ error: "Invalid username characters" }, 400);
    if (platforms.length === 0) return json({ error: "Select at least one platform" }, 400);

    const uniquePlatforms = [...new Set(platforms)].slice(0, 10);

    const results = await Promise.all(
      uniquePlatforms.map(async (p) => {
        switch (p) {
          case "x":
            return await checkX(username);
          case "instagram":
            return await checkInstagram(username);
          case "tiktok":
            return await checkTikTok(username);
          case "roblox":
            return await checkRoblox(username);
          case "discord":
            // No reliable public availability check for Discord usernames.
            return { platform: "discord", status: "unknown", reason: "unsupported" };
          default:
            return { platform: p, status: "unknown" };
        }
      })
    );

    return json({ results });
  } catch {
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

async function fetchWithTimeout(url, init = {}, ms = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * X (Twitter) — best no-login check:
 * Returns [] if not found, or an object with id/name if found.
 */
async function checkX(username) {
  const screen = username.replace(/^@/, "");
  const url = `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${encodeURIComponent(screen)}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "taken.gg (+https://taken.gg)",
      },
    });

    if (!res.ok) return { platform: "x", status: "unknown" };

    const data = await res.json().catch(() => null);
    const found = Array.isArray(data) && data.length > 0;

    return found
      ? { platform: "x", status: "taken", url: `https://x.com/${screen}` }
      : { platform: "x", status: "available" };
  } catch {
    return { platform: "x", status: "unknown" };
  }
}

/**
 * Instagram — try a JSON endpoint first, then fallback to HTML phrase detection.
 */
async function checkInstagram(username) {
  const u = username.replace(/^@/, "");
  const profileUrl = `https://www.instagram.com/${u}/`;

  // Attempt JSON-ish endpoint (often works, sometimes blocked)
  const jsonUrl = `https://www.instagram.com/${u}/?__a=1&__d=dis`;

  try {
    const res = await fetchWithTimeout(jsonUrl, {
      headers: {
        "Accept": "application/json,text/plain,*/*",
        "User-Agent": "taken.gg (+https://taken.gg)",
      },
      redirect: "follow",
    }, 8000);

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    // If we actually got JSON, it’s a strong “taken”
    if (res.ok && ct.includes("application/json")) {
      return { platform: "instagram", status: "taken", url: profileUrl };
    }

    // If IG blocks and returns HTML/login, fall back to HTML check below
  } catch {
    // fall through
  }

  // HTML fallback: detect “page isn't available”
  try {
    const res2 = await fetchWithTimeout(profileUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "taken.gg (+https://taken.gg)",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }, 8000);

    if (res2.status === 404) return { platform: "instagram", status: "available" };
    if (!res2.ok) return { platform: "instagram", status: "unknown" };

    const html = await res2.text();

    // Common IG non-existent page text:
    if (html.includes("Sorry, this page isn't available") || html.includes("Page Not Found")) {
      return { platform: "instagram", status: "available" };
    }

    // If we got a login wall/captcha, don’t guess
    if (html.toLowerCase().includes("login") || html.toLowerCase().includes("challenge")) {
      return { platform: "instagram", status: "unknown" };
    }

    // Otherwise treat as taken
    return { platform: "instagram", status: "taken", url: profileUrl };
  } catch {
    return { platform: "instagram", status: "unknown" };
  }
}

/**
 * TikTok — HTML often returns 200 even when not found.
 * Detect “Couldn't find this account” or “couldn't find” etc.
 */
async function checkTikTok(username) {
  const u = username.replace(/^@/, "");
  const url = `https://www.tiktok.com/@${u}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "taken.gg (+https://taken.gg)",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }, 8000);

    // Hard 404 is definitely available
    if (res.status === 404) return { platform: "tiktok", status: "available" };
    if (!res.ok) {
      // 403/429/etc = unknown (bot wall)
      return { platform: "tiktok", status: "unknown" };
    }

    const html = await res.text();

    // Non-existent account message (seen in your screenshot)
    const lower = html.toLowerCase();
    if (lower.includes("couldn't find this account") || lower.includes("could not find this account")) {
      return { platform: "tiktok", status: "available" };
    }

    // Bot wall / captcha signals
    if (lower.includes("verify to continue") || lower.includes("captcha") || lower.includes("access denied")) {
      return { platform: "tiktok", status: "unknown" };
    }

    return { platform: "tiktok", status: "taken", url };
  } catch {
    return { platform: "tiktok", status: "unknown" };
  }
}

/**
 * Roblox — your approach is correct: username -> id lookup.
 */
async function checkRoblox(username) {
  try {
    const res = await fetchWithTimeout("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "taken.gg (+https://taken.gg)",
      },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    }, 8000);

    if (!res.ok) return { platform: "roblox", status: "unknown" };

    const data = await res.json().catch(() => null);
    const found = Array.isArray(data?.data) && data.data.length > 0;

    if (found) {
      const userId = data.data[0]?.id;
      if (!userId) return { platform: "roblox", status: "unknown" };

      return {
        platform: "roblox",
        status: "taken",
        url: `https://www.roblox.com/users/${userId}/profile`,
      };
    }

    return { platform: "roblox", status: "available" };
  } catch {
    return { platform: "roblox", status: "unknown" };
  }
}
