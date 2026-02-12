export async function onRequestPost({ request, env }) {
  try {
    const { username, platforms } = await request.json();

    // Basic validation
    if (!username || typeof username !== "string") {
      return json({ error: "Username is required" }, 400);
    }

    const clean = username.trim();
    if (clean.length < 2 || clean.length > 32) {
      return json({ error: "Username must be 2–32 chars" }, 400);
    }

    if (!Array.isArray(platforms) || platforms.length === 0) {
      return json({ error: "Select at least one platform" }, 400);
    }

    // Run checks (in parallel)
    const results = await Promise.all(
      platforms.map((p) => checkPlatform(p, clean, env))
    );

    return json({ results });
  } catch (e) {
    return json({ error: "Bad request" }, 400);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- Platform checks ----
// Rule of thumb:
// - If profile page returns 200 => taken
// - If 404 => available
// - If 403/429/captcha => unknown
async function checkPlatform(platform, username, env) {
  switch (platform) {
    case "x":
      return await checkByURL("x", `https://x.com/${username}`, username);
    case "instagram":
      return await checkByURL("instagram", `https://www.instagram.com/${username}/`, username);
    case "tiktok":
      return await checkByURL("tiktok", `https://www.tiktok.com/@${username}`, username);
    case "roblox":
      // Roblox is trickier: usernames are not always a direct profile URL.
      // We'll do a public endpoint lookup (may change) OR return unknown if blocked.
      return await checkRoblox(username);
    case "discord":
      // Discord usernames aren't publicly resolvable via URL (and handles changed).
      // Real check requires user OAuth or bot presence in server / special flows.
      return { platform, status: "unknown" };
    default:
      return { platform, status: "unknown" };
  }
}

async function checkByURL(platform, url, username) {
  try {
    const res = await fetch(url, {
      // A basic UA helps; some sites still block.
      headers: {
        "User-Agent": "taken.gg (+https://taken.gg)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });

    // Some sites 301/302 for existing users – treat as taken-ish
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      return { platform, status: "taken", url };
    }

    if (res.status === 200) return { platform, status: "taken", url };
    if (res.status === 404) return { platform, status: "available" };

    // blocked / rate limited / bot challenged
    if (res.status === 403 || res.status === 429) return { platform, status: "unknown" };

    return { platform, status: "unknown" };
  } catch {
    return { platform, status: "unknown" };
  }
}

async function checkRoblox(username) {
  try {
    // Unofficial but common lookup endpoint
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });

    if (!res.ok) return { platform: "roblox", status: "unknown" };

    const data = await res.json();
    const found = Array.isArray(data?.data) && data.data.length > 0;

    if (found) {
      const userId = data.data[0].id;
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
