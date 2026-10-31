// Pure, side-effect-free helpers kept separate from Discord/voice/yt-dlp code
// so they're easy to unit test in isolation.

function secondsToTime(rawSeconds) {
  const seconds = Number(rawSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00:00";

  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");

  return `${h}:${m}:${s}`;
}

function totalQueueTime(songs) {
  const total = songs.reduce((sum, song) => sum + (parseInt(song.duration, 10) || 0), 0);
  return secondsToTime(total);
}

// Pulls a video ID out of a YouTube URL (watch, youtu.be, shorts, live or embed,
// on www/m/music or no subdomain). Returns null if the first arg isn't a
// recognised YouTube URL, so the caller knows to fall back to a text search.
function extractVideoId(args) {
  const firstArg = args?.[0];
  if (!firstArg) return null;

  let url;
  try {
    url = new URL(firstArg);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1];
  } else if (host === "youtube.com") {
    id = url.pathname === "/watch"
      ? url.searchParams.get("v")
      : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1];
  }

  return /^[\w-]+$/.test(id ?? "") ? id : null;
}

module.exports = { secondsToTime, totalQueueTime, extractVideoId };
