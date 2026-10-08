import { AuthorizationError, OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_ORIGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_ALLOWED_LOGIN?: string;
  GITHUB_ALLOWED_LOGINS?: string;
  ADMIN_PAGE_CODE?: string;
  API_KEYS_ENCRYPTION_KEY?: string;
};

type ApiProviderConfig = {
  label: string;
  key: string;
  auth: "bearer" | "x-api-key";
  baseUrl: string;
};

const STATE_COOKIE = "__Host-web-extractor-state";
const ADMIN_COOKIE = "__Host-web-extractor-admin";
const TTL = 600;
const MAX_PAGE_BYTES = 600_000;
const MAX_YOUTUBE_SEARCH_BYTES = 2_200_000;
const MAX_ASSET_BYTES = 250_000;
const PROVIDER_UI_URI = "ui://web-bridge/providers-v4.html";

const providerWidgetHtml = (workerOrigin: string) => `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; min-height: 100%; margin: 0; overflow: hidden; background: #0b0d12; }
    iframe { display: block; width: 100%; height: 100vh; height: 100dvh; min-height: 100vh; border: 0; background: #0b0d12; }
  </style>
</head>
<body>
  <iframe title="Gestion des providers et des clés Web Bridge" src="${workerOrigin}/keys?embedded=1"></iframe>
</body>
</html>`;

type TweetRecord = {
  source: string;
  id: string;
  author: string | null;
  authorUrl: string | null;
  text: string;
  url: string;
  mediaUrls: string[];
};

type FxMedia = {
  type?: string;
  url?: string;
  width?: number;
  height?: number;
  altText?: string;
};

type FxStatus = {
  id?: string;
  url?: string;
  text?: string;
  created_timestamp?: number;
  author?: { name?: string; screen_name?: string; username?: string; url?: string };
  media?: { all?: FxMedia[] };
};

type FxThreadResponse = {
  code?: number;
  status?: FxStatus | null;
  thread?: FxStatus[] | null;
};

type MediaSource = {
  url: string;
  type: "image" | "gif";
  width: number | null;
  height: number | null;
  altText: string | null;
};

type AutoPost = {
  index: number;
  id: string;
  author: string | null;
  authorUrl: string | null;
  text: string;
  url: string;
  createdTimestamp: number | null;
  mediaSources: MediaSource[];
};

function origin(env: Env): string {
  const value = env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  if (!value || value.includes("REPLACE_WITH")) throw new Error("PUBLIC_ORIGIN is not configured.");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin.");
  }
  return parsed.origin;
}

function responseJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function textResult(data: unknown) {
  return { structuredContent: data as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function safeUrl(raw: string): URL {
  const value = raw.trim().match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/i)?.[1] ?? raw.trim();
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https URLs are supported.");
  return url;
}

function stripHtml(input: string): string {
  return input.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value))).replace(/&#x([\da-f]+);/gi, (_, value: string) => String.fromCodePoint(parseInt(value, 16))).replace(/\s+/g, " ").trim();
}

function tweetTextFromOembed(html: string): string {
  const post = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? html;
  return stripHtml(post).replace(/\s+pic\.twitter\.com\/\S+/gi, "").trim();
}

function absolute(base: URL, value: string): string | null {
  try { return new URL(value, base).toString(); } catch { return null; }
}

function linkedAssets(html: string, pageUrl: URL) {
  const css = [...html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)]
    .filter((m) => /stylesheet/i.test(m[0])).map((m) => absolute(pageUrl, m[1])).filter((x): x is string => Boolean(x));
  const js = [...html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)]
    .map((m) => absolute(pageUrl, m[1])).filter((x): x is string => Boolean(x));
  return { css: [...new Set(css)], javascript: [...new Set(js)] };
}

async function limitedFetch(url: string, limit: number, init?: RequestInit) {
  const response = await fetch(url, { ...init, redirect: "follow", headers: { "user-agent": "web-extractor-mcp/0.1", ...(init?.headers ?? {}) } });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > limit) throw new Error(`Response is larger than the ${limit} byte safety limit.`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw new Error(`Response is larger than the ${limit} byte safety limit.`);
  return { response, text };
}
function tweetId(url: string): string | null { return url.match(/status(?:es)?\/(\d+)/i)?.[1] ?? null; }

type YouTubeVideo = {
  videoId: string;
  title: string;
  channel: string | null;
  published: string | null;
  views: number | null;
  duration: string | null;
  url: string;
};

function readText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "simpleText" in value && typeof value.simpleText === "string") return value.simpleText;
  if (value && typeof value === "object" && "runs" in value && Array.isArray(value.runs)) {
    return value.runs.map((run) => run && typeof run === "object" && "text" in run && typeof run.text === "string" ? run.text : "").join("").trim() || null;
  }
  return null;
}

function boundedNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function videoFromRenderer(renderer: Record<string, unknown>): YouTubeVideo | null {
  const id = typeof renderer.videoId === "string" && /^[\w-]{11}$/.test(renderer.videoId) ? renderer.videoId : null;
  const title = readText(renderer.title);
  if (!id || !title) return null;
  const owner = renderer.ownerText ?? renderer.shortBylineText ?? renderer.longBylineText;
  return {
    videoId: id,
    title,
    channel: readText(owner),
    published: readText(renderer.publishedTimeText),
    views: boundedNumber(readText(renderer.viewCountText) ?? renderer.viewCountText),
    duration: readText(renderer.lengthText),
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function jsonObjectAt(source: string, start: number): { value: Record<string, unknown>; end: number } | null {
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        const value: unknown = JSON.parse(source.slice(open, i + 1));
        return value && typeof value === "object" && !Array.isArray(value) ? { value: value as Record<string, unknown>, end: i + 1 } : null;
      } catch { return null; }
    }
  }
  return null;
}

function parseYouTubeSearchHtml(html: string, limit: number): YouTubeVideo[] {
  const results: YouTubeVideo[] = [];
  const seen = new Set<string>();
  const marker = /"videoRenderer"\s*:\s*/g;
  for (let match = marker.exec(html); match && results.length < limit; match = marker.exec(html)) {
    const parsed = jsonObjectAt(html, marker.lastIndex);
    if (!parsed) continue;
    marker.lastIndex = parsed.end;
    const video = videoFromRenderer(parsed.value);
    if (video && !seen.has(video.videoId)) { seen.add(video.videoId); results.push(video); }
  }
  return results;
}

function parseMirrorResults(payload: unknown, limit: number): YouTubeVideo[] {
  const items = Array.isArray(payload) ? payload : payload && typeof payload === "object" && "items" in payload && Array.isArray(payload.items) ? payload.items : [];
  const results: YouTubeVideo[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const rawUrl = typeof row.url === "string" ? row.url : "";
    const id = (typeof row.videoId === "string" ? row.videoId : "") || rawUrl.match(/[?&]v=([\w-]{11})/)?.[1] || rawUrl.match(/\/watch\/([\w-]{11})/)?.[1] || "";
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!/^[\w-]{11}$/.test(id) || !title || seen.has(id)) continue;
    seen.add(id);
    const duration = typeof row.duration === "number" ? formatDuration(row.duration) : typeof row.duration === "string" ? row.duration : null;
    results.push({ videoId: id, title, channel: typeof row.author === "string" ? row.author : null,
      published: typeof row.publishedText === "string" ? row.publishedText : typeof row.uploaded === "string" ? row.uploaded : null,
      views: boundedNumber(row.viewCount ?? row.views), duration, url: `https://www.youtube.com/watch?v=${id}` });
    if (results.length >= limit) break;
  }
  return results;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

async function boundedResponseText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error(`YouTube search response exceeded ${limit} bytes.`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

async function searchYouTube(query: string, limit: number, language: string, region: string) {
  const params = new URLSearchParams({ search_query: query, hl: language, gl: region });
  const youtubeUrl = `https://www.youtube.com/results?${params}`;
  let primaryError = "YouTube results could not be parsed.";
  try {
    const response = await fetch(youtubeUrl, { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": `${language},en;q=0.8`,
    } });
    if (!response.ok) throw new Error(`YouTube returned HTTP ${response.status}.`);
    const html = await boundedResponseText(response, MAX_YOUTUBE_SEARCH_BYTES);
    const results = parseYouTubeSearchHtml(html, limit);
    if (results.length) return { query, source: "youtube.com", fallbackUsed: false, results };
    primaryError = "YouTube returned a page, but no video results could be parsed.";
  } catch (error) { primaryError = error instanceof Error ? error.message : String(error); }

  const mirrorQueries = [
    (async () => {
      const url = new URL("https://invidious.f5.si/api/v1/search");
      url.searchParams.set("q", query);
      const response = await fetch(url, { signal: AbortSignal.timeout(7_000), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Invidious HTTP ${response.status}`);
      return { source: "invidious", results: parseMirrorResults(await response.json(), limit) } as const;
    })(),
    (async () => {
      const url = new URL("https://api.piped.private.coffee/search");
      url.searchParams.set("q", query);
      url.searchParams.set("filter", "videos");
      const response = await fetch(url, { signal: AbortSignal.timeout(7_000), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Piped HTTP ${response.status}`);
      return { source: "piped", results: parseMirrorResults(await response.json(), limit) } as const;
    })(),
  ];
  const settled = await Promise.allSettled(mirrorQueries);
  const fallback = settled.flatMap((entry) => entry.status === "fulfilled" && entry.value.results.length ? [entry.value] : [])
    .sort((a, b) => b.results.length - a.results.length)[0];
  if (fallback) return { query, source: fallback.source, fallbackUsed: true, primaryFailure: primaryError, results: fallback.results };
  const failures = settled.map((entry) => entry.status === "rejected" ? (entry.reason instanceof Error ? entry.reason.message : String(entry.reason)) : "no results");
  return { query, source: null, fallbackUsed: true, results: [], error: "YouTube search and the tested public fallbacks both failed.", diagnostics: { youtube: primaryError, mirrors: failures } };
}

function normalizeMediaUrls(urls: string[]): string[] {
  const quality = (value: string) => {
    const name = new URL(value).searchParams.get("name")?.toLowerCase();
    return name === "orig" ? 4 : name === "large" ? 3 : name === "medium" ? 2 : name === "small" ? 1 : 0;
  };
  const byMedia = new Map<string, string>();
  for (const raw of urls) {
    try {
      const parsed = safeUrl(raw.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/\\u0026/g, "&"));
      if (parsed.hostname !== "pbs.twimg.com" || !/^\/media\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/.test(parsed.pathname)) continue;
      if (parsed.searchParams.get("name") === "") parsed.searchParams.delete("name");
      const key = parsed.pathname.replace(/\.[A-Za-z0-9]+$/, "");
      const current = byMedia.get(key);
      if (!current || quality(parsed.toString()) > quality(current)) byMedia.set(key, parsed.toString());
    } catch { /* Ignore malformed candidates from HTML srcset attributes. */ }
  }
  return [...byMedia.values()].map((value) => {
    try {
      const parsed = safeUrl(value);
      if (parsed.hostname === "pbs.twimg.com" && /^\/media\//.test(parsed.pathname)) {
        parsed.searchParams.set("format", "jpg");
        parsed.searchParams.set("name", "large");
      }
      return parsed.toString();
    } catch {
      return value;
    }
  });
}

function mediaUrlsFromHtml(html: string): string[] {
  return normalizeMediaUrls((html
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/\\u0026/g, "&")
    .match(/https?:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+(?:\?[^\"'\\s<,]+)?/g) ?? []));
}

async function getTweet(url: string): Promise<TweetRecord> {
  const parsed = safeUrl(url);
  if (!/(^|\.)((x|twitter)\.com)$/.test(parsed.hostname)) throw new Error("The URL must be an x.com or twitter.com status URL.");
  const sourceUrl = parsed.toString();
  const id = tweetId(sourceUrl);
  if (!id) throw new Error("No tweet status ID was found in the URL.");
  console.log({ event: "tweet_fetch_start", id });
  const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(sourceUrl)}&omit_script=true`;
  const { response, text } = await limitedFetch(endpoint, 120_000, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`X oEmbed returned HTTP ${response.status}.`);
  const data = JSON.parse(text) as { author_name?: string; author_url?: string; html?: string; url?: string };
  let mediaUrls = mediaUrlsFromHtml(data.html ?? "");
  if (mediaUrls.length === 0) {
    const picLinks = [...new Set((data.html ?? "").match(/https?:\/\/(?:t\.co|pic\.twitter\.com)\/[^\"'\s<]+/gi) ?? [])];
    for (const picLink of picLinks.slice(0, 4)) {
      try {
        const linked = await limitedFetch(picLink, 400_000, { headers: { accept: "text/html,application/xhtml+xml" } });
        mediaUrls.push(...mediaUrlsFromHtml(linked.text));
      } catch { /* A single unavailable pic link must not hide the tweet. */ }
    }
    mediaUrls = [...new Set(mediaUrls)];
  }
  if (mediaUrls.length === 0) { try { const syndication = await limitedFetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en`, 300_000, { headers: { accept: "application/json" } }); const result = JSON.parse(syndication.text) as { mediaDetails?: Array<{ media_url_https?: string; media_url?: string }> }; mediaUrls = normalizeMediaUrls((result.mediaDetails ?? []).map((media) => media.media_url_https ?? media.media_url).filter((value): value is string => Boolean(value))); } catch { /* X may disable this public fallback for some tweets. */ } }
  if (mediaUrls.length === 0) { try { const fallback = await limitedFetch(`https://api.fxtwitter.com/status/${id}`, 500_000, { headers: { accept: "application/json" } }); const result = JSON.parse(fallback.text) as { tweet?: { media?: { all?: Array<{ url?: string }> } } }; mediaUrls = normalizeMediaUrls((result.tweet?.media?.all ?? []).map((media) => media.url).filter((value): value is string => Boolean(value))); } catch { /* Public mirrors can be unavailable; keep the text result. */ } }
  console.log({ event: "tweet_fetch_discovered", id, mediaUrlCount: mediaUrls.length });
  return { source: "X oEmbed", id, author: data.author_name ?? null, authorUrl: data.author_url ?? null, text: tweetTextFromOembed(data.html ?? ""), url: data.url ?? sourceUrl, mediaUrls };
}

function fxStatusMedia(status: FxStatus): MediaSource[] {
  const seen = new Set<string>();
  return (status.media?.all ?? []).flatMap((media) => {
    if (!media.url) return [];
    const isImage = media.type === "photo" || media.type === "gif" || /pbs\.twimg\.com\/media\//i.test(media.url);
    if (!isImage) return [];
    const url = normalizeMediaUrls([media.url])[0];
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{
      url,
      type: media.type === "gif" ? ("gif" as const) : ("image" as const),
      width: media.width ?? null,
      height: media.height ?? null,
      altText: media.altText ?? null,
    }];
  });
}

function fxStatusUrl(status: FxStatus): string {
  if (status.url) return status.url;
  const handle = status.author?.screen_name ?? status.author?.username ?? "i";
  return `https://x.com/${handle}/status/${status.id}`;
}

function fxStatusPost(status: FxStatus, index: number): AutoPost {
  return {
    index,
    id: status.id ?? "",
    author: status.author?.name ?? status.author?.screen_name ?? status.author?.username ?? null,
    authorUrl: status.author?.url ?? null,
    text: status.text ?? "",
    url: fxStatusUrl(status),
    createdTimestamp: status.created_timestamp ?? null,
    mediaSources: fxStatusMedia(status),
  };
}

function tweetPost(tweet: TweetRecord): AutoPost {
  return {
    index: 0,
    id: tweet.id,
    author: tweet.author,
    authorUrl: tweet.authorUrl,
    text: tweet.text,
    url: tweet.url,
    createdTimestamp: null,
    mediaSources: tweet.mediaUrls.map((url) => ({ url, type: "image", width: null, height: null, altText: null })),
  };
}

function autoPostManifest(post: AutoPost) {
  return {
    index: post.index,
    id: post.id,
    author: post.author,
    authorUrl: post.authorUrl,
    text: post.text,
    url: post.url,
    createdTimestamp: post.createdTimestamp,
    mediaCount: post.mediaSources.length,
    mediaItems: post.mediaSources.map((media, index) => ({
      index,
      type: media.type,
      imageUrl: media.url,
      width: media.width,
      height: media.height,
      altText: media.altText,
    })),
  };
}

function fxStatusManifest(status: FxStatus, index: number) {
  const mediaItems = fxStatusMedia(status);
  return {
    index,
    id: status.id ?? null,
    author: status.author?.name ?? status.author?.screen_name ?? status.author?.username ?? null,
    authorUrl: status.author?.url ?? null,
    text: status.text ?? "",
    url: fxStatusUrl(status),
    createdTimestamp: status.created_timestamp ?? null,
    mediaCount: mediaItems.length,
    mediaItems: mediaItems.map(({ url, ...media }, mediaIndex) => ({ index: mediaIndex, imageUrl: url, ...media })),
  };
}

type FxThreadData = {
  source: string;
  focalPostId: string;
  url: string;
  posts: AutoPost[];
  totalPosts: number;
  truncated: boolean;
  complete: boolean;
};

async function fetchFxThread(url: string, maxPosts = 30): Promise<FxThreadData> {
  const parsed = safeUrl(url);
  if (!/(^|\.)((x|twitter)\.com)$/.test(parsed.hostname)) throw new Error("The URL must be an x.com or twitter.com status URL.");
  const sourceUrl = parsed.toString();
  const id = tweetId(sourceUrl);
  if (!id) throw new Error("No tweet status ID was found in the URL.");
  console.log({ event: "tweet_thread_fetch_start", id, maxPosts });
  const endpoint = `https://api.fxtwitter.com/2/thread/${id}`;
  const { response, text } = await limitedFetch(endpoint, 1_000_000, { headers: { accept: "application/json" } });
  const payload = JSON.parse(text) as FxThreadResponse;
  if (!response.ok || payload.code !== 200 || !payload.status) throw new Error(`FxTwitter thread returned HTTP ${response.status}.`);

  const candidates = [...(payload.thread ?? [])];
  if (!candidates.some((status) => status.id === payload.status?.id)) candidates.push(payload.status);
  const unique = [...new Map(candidates.filter((status) => status.id).map((status) => [status.id, status])).values()];
  const posts = unique.slice(0, maxPosts).map((status, index) => fxStatusPost(status, index));
  return {
    source: "FxTwitter public API",
    focalPostId: id,
    url: sourceUrl,
    posts,
    totalPosts: unique.length,
    truncated: unique.length > posts.length,
    complete: unique.length <= posts.length,
  };
}

async function getTweetOverview(url: string) {
  let data: FxThreadData;
  try {
    data = await fetchFxThread(url, 30);
  } catch (error) {
    const tweet = await getTweet(url);
    data = {
      source: "X oEmbed fallback",
      focalPostId: tweet.id,
      url: tweet.url,
      posts: [tweetPost(tweet)],
      totalPosts: 1,
      truncated: false,
      complete: false,
    };
    console.log({ event: "tweet_thread_fallback", id: tweet.id, reason: error instanceof Error ? error.message : "thread lookup failed" });
  }

  const posts = data.posts.map(autoPostManifest);
  const mediaCount = data.posts.reduce((count, post) => count + post.mediaSources.length, 0);
  const result = {
    source: data.source,
    mode: "post_or_thread_manifest",
    focalPostId: data.focalPostId,
    url: data.url,
    postCount: posts.length,
    totalPosts: data.totalPosts,
    truncated: data.truncated,
    complete: data.complete,
    mediaCount,
    imageUrlsIncluded: mediaCount > 0,
    posts,
  };
  console.log({ event: "tweet_overview_result", id: data.focalPostId, postCount: result.postCount, mediaCount });
  return { structuredContent: result, content: [{ type: "text" as const, text: `Web Bridge retrieved ${result.postCount} post(s).` }] };
}

async function pageCode(url: string, includeAssets: boolean) {
  const parsed = safeUrl(url);
  const { response, text: html } = await limitedFetch(parsed.toString(), MAX_PAGE_BYTES, { headers: { accept: "text/html,application/xhtml+xml" } });
  const assets = linkedAssets(html, parsed);
  const result: Record<string, unknown> = {
    url: response.url,
    status: response.status,
    contentType: response.headers.get("content-type"),
    html,
    title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null,
    metaDescription: html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? null,
    assets: { css: assets.css, javascript: assets.javascript },
    mediaDownloaded: false,
  };
  if (includeAssets) {
    const read = async (items: string[]) => Promise.all(items.slice(0, 12).map(async (asset) => {
      try { const fetched = await limitedFetch(asset, MAX_ASSET_BYTES); return { url: asset, status: fetched.response.status, content: fetched.text }; }
      catch (error) { return { url: asset, error: error instanceof Error ? error.message : "asset fetch failed" }; }
    }));
    result.cssFiles = await read(assets.css);
    result.javascriptFiles = await read(assets.javascript);
  }
  return result;
}

function cookie(request: Request, name: string) { return (request.headers.get("cookie") ?? "").split(";").map((x) => x.trim()).find((x) => x.startsWith(`${name}=`))?.slice(name.length + 1) ?? null; }
function cookieHeader(name: string, value: string, maxAge: number, partitioned = false) { return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; ${partitioned ? "SameSite=None; Partitioned" : "SameSite=Lax"}`; }
function bytesToB64(bytes: ArrayBuffer | Uint8Array) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function b64ToBytes(value: string) { return Uint8Array.from(atob(value), (c) => c.charCodeAt(0)); }

async function cryptoKey(env: Env) {
  if (!env.API_KEYS_ENCRYPTION_KEY) throw new Error("API_KEYS_ENCRYPTION_KEY is not configured.");
  return crypto.subtle.importKey("raw", b64ToBytes(env.API_KEYS_ENCRYPTION_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(value: string, env: Env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env), new TextEncoder().encode(value));
  return `${bytesToB64(iv)}.${bytesToB64(ciphertext)}`;
}
async function decrypt(value: string, env: Env) {
  const [iv, ciphertext] = value.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(iv) }, await cryptoKey(env), b64ToBytes(ciphertext));
  return new TextDecoder().decode(plain);
}

async function storedProvider(provider: string, env: Env): Promise<ApiProviderConfig | null> {
  const stored = await env.OAUTH_KV.get(`api-key:${provider.toLowerCase()}`);
  if (!stored) return null;
  return JSON.parse(await decrypt(stored, env)) as ApiProviderConfig;
}

async function apiKey(provider: string, env: Env) {
  const config = await storedProvider(provider, env);
  if (!config || !config.key) throw new Error(`No API key configured for provider '${provider}'.`);
  return config;
}

async function saveProviderMetadata(provider: string, baseUrl: string, auth: "bearer" | "x-api-key", env: Env) {
  const normalizedUrl = safeUrl(baseUrl);
  if (normalizedUrl.protocol !== "https:") throw new Error("Provider base URL must use HTTPS.");
  const existing = await storedProvider(provider, env);
  const config: ApiProviderConfig = {
    label: provider,
    key: existing?.key ?? "",
    baseUrl: normalizedUrl.origin,
    auth,
  };
  await env.OAUTH_KV.put(`api-key:${provider.toLowerCase()}`, await encrypt(JSON.stringify(config), env));
}

async function configuredApiProviders(env: Env) {
  const listed = await env.OAUTH_KV.list({ prefix: "api-key:" });
  const providers = await Promise.all(listed.keys.map(async (entry) => {
    const provider = entry.name.slice("api-key:".length);
    try {
      const item = JSON.parse(await decrypt((await env.OAUTH_KV.get(entry.name))!, env)) as { baseUrl?: string; auth?: string; key?: string };
      return { provider, baseUrl: item.baseUrl ?? null, auth: item.auth === "x-api-key" ? "x-api-key" : "bearer", keyConfigured: Boolean(item.key) };
    } catch {
      return { provider, baseUrl: null, auth: null, configurationError: true };
    }
  }));
  return {
    providers,
    count: providers.length,
    privateApiPolicy: "These providers use private server-side keys. Never call a private API unless the user explicitly asks for it. Public fetch, tweet, image and page-code requests do not authorize private API calls.",
  };
}

function createServer(env: Env) {
  const server = new McpServer({ name: "web-bridge", version: "0.6.0" });
  const readMeta = {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
  const writeMeta = {
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  server.registerResource("provider-dashboard", PROVIDER_UI_URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({
    contents: [{
      uri: PROVIDER_UI_URI,
      mimeType: "text/html;profile=mcp-app",
      text: providerWidgetHtml(origin(env)),
      _meta: {
        ui: {
          prefersBorder: false,
          domain: origin(env),
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [origin(env)] },
        },
        "openai/ui": { availableDisplayModes: ["fullscreen"] },
      },
    }],
  }));

  server.registerTool("get_tweet", {
    title: "Fetch X post or thread manifest",
    description: "Primary tool for any public X/Twitter status URL. Automatically detects a single post or thread and retrieves all available post text.",
    inputSchema: {
      url: z.string().url().describe("Public X/Twitter status URL; a Markdown link is also accepted."),
    },
  ...readMeta,
  }, async ({ url }) => getTweetOverview(url));

  server.registerTool("get_page_code", {
    title: "Get public page code",
    description: "Fetch public HTML and optionally linked CSS and JavaScript so the model can audit frontend code. Does not render the page or download media.",
    inputSchema: { url: z.string().url(), includeAssets: z.boolean().default(true) },
    ...readMeta,
  }, async ({ url, includeAssets }) => textResult(await pageCode(url, includeAssets)));

  server.registerTool("search_youtube_videos", {
    title: "Search YouTube videos",
    description: "Search YouTube for videos and return titles, channels, dates, durations, view counts, and canonical watch URLs. No API key is needed. When the user also asks for a summary, use the best matching result's canonical URL with an available YouTube transcript tool and base the summary on its transcript; do not summarize from the title alone. If the request is only to find videos, return the candidates without fetching transcripts.",
    inputSchema: {
      query: z.string().trim().min(1).max(200).describe("What to search for on YouTube."),
      limit: z.number().int().min(1).max(10).default(5),
      language: z.string().regex(/^[a-z]{2,3}$/).default("fr").describe("Preferred results-page language, e.g. fr or en."),
      region: z.string().regex(/^[A-Z]{2}$/).default("FR").describe("YouTube results region, e.g. FR or US."),
    },
    ...readMeta,
  }, async ({ query, limit, language, region }) => textResult(await searchYouTube(query, limit, language, region)));

  server.registerTool("search_youtube_mentions", {
    title: "Find YouTube videos to mention",
    description: "Search YouTube for selectable video links in ChatGPT's desktop composer mention picker. This is a user-facing picker only; use search_youtube_videos for normal model-driven searches.",
    inputSchema: { query: z.string().trim().max(200).describe("The user's composer typeahead query; may be empty.") },
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }],
      "openai/extensions": { "mentions/search": {} },
      ui: { visibility: ["app"] },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query }) => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) return { content: [], structuredContent: { items: [] } };
    const result = await searchYouTube(normalizedQuery, 6, "fr", "FR");
    const items = result.results.map((video) => ({
      type: "resource_link" as const,
      uri: video.url,
      name: video.title,
      title: video.title,
      description: [video.channel, video.duration, video.published].filter(Boolean).join(" · ") || "YouTube video",
      mimeType: "text/uri-list",
    }));
    return { content: [], structuredContent: { items } };
  });

  server.registerTool("fetch_public_data", {
    title: "Fetch public data",
    description: "Fetch data from a public URL or API endpoint without authentication and return the raw JSON, text, XML or HTML response. Use this for public APIs or when the user explicitly asks for the raw response.",
    inputSchema: { url: z.string().url(), query: z.record(z.string(), z.string()).optional() },
    ...readMeta,
  }, async ({ url, query }) => {
    const parsed = safeUrl(url);
    for (const [key, value] of Object.entries(query ?? {})) parsed.searchParams.set(key, value);
    const { response, text } = await limitedFetch(parsed.toString(), MAX_PAGE_BYTES, { headers: { accept: "application/json,text/plain,*/*" } });
    return textResult({ url: response.url, status: response.status, contentType: response.headers.get("content-type"), body: text });
  });

  server.registerTool("list_configured_api_providers", {
    title: "API providers",
    description: "List the names and allowed origins of private API providers configured by the user, without revealing keys. Call this only when the user explicitly asks which private APIs are available or configured.",
    inputSchema: {},
    icons: [{ src: `${origin(env)}/web-bridge-icon.svg`, mimeType: "image/svg+xml", sizes: ["20x20"] }],
    ...readMeta,
    _meta: {
      ...readMeta._meta,
      ui: { resourceUri: PROVIDER_UI_URI },
      "openai/ui": { entrypoints: [{ type: "global" }] },
    },
  }, async () => textResult(await configuredApiProviders(env)));

  server.registerTool("save_configured_api_provider", {
    title: "Add or edit provider metadata",
    description: "PRIVATE PROVIDER CONFIGURATION. Add or update a provider name, HTTPS base URL and authentication scheme without accepting or returning an API key. Use only when the user explicitly asks to add or modify a provider. Never request or store an API key through this tool; keys are managed separately in the Web Bridge vault.",
    inputSchema: {
      provider: z.string().regex(/^[a-zA-Z0-9._-]{1,50}$/),
      baseUrl: z.string().url(),
      auth: z.enum(["bearer", "x-api-key"]).default("bearer"),
    },
    ...writeMeta,
  }, async ({ provider, baseUrl, auth }) => {
    await saveProviderMetadata(provider.toLowerCase(), baseUrl, auth, env);
    return textResult(await configuredApiProviders(env));
  });

  server.registerTool("call_configured_api", {
    title: "Call configured API",
    description: "PRIVATE API ACTION. Call a configured provider with its server-side key only when the user explicitly requests a private/API-key-backed call. Never use a specific private API unless the user explicitly asks to use that API. The URL must stay on the provider base origin; keys are never returned.",
    inputSchema: { provider: z.string().regex(/^[a-zA-Z0-9._-]{1,50}$/), url: z.string().url(), method: z.enum(["GET", "POST"]).default("GET"), body: z.string().max(100_000).optional() },
    ...readMeta,
  }, async ({ provider, url, method, body }) => {
    const configured = await apiKey(provider, env);
    const target = safeUrl(url);
    if (target.origin !== new URL(configured.baseUrl).origin) throw new Error(`URL is outside the configured origin for '${provider}'.`);
    const headers: Record<string, string> = { accept: "application/json,text/plain,*/*", "content-type": "application/json" };
    headers[configured.auth === "bearer" ? "authorization" : "x-api-key"] = configured.auth === "bearer" ? `Bearer ${configured.key}` : configured.key;
    const { response, text } = await limitedFetch(target.toString(), MAX_PAGE_BYTES, { method, headers, body: method === "POST" ? body : undefined });
    return textResult({ provider, url: response.url, status: response.status, body: text, keyExposed: false });
  });

  return server;
}


function htmlPage(message = "") {
  return `<!doctype html>
<html lang='fr'>
<head>
  <meta charset='utf-8'>
  <meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>
  <link rel='icon' href='/favicon.svg'>
  <title>Providers</title>
  <style>
    :root{color-scheme:dark;--bg:#0b0d12;--panel:#131722;--line:#293142;--text:#f5f7fb;--muted:#9aa5b8;--blue:#7896ff;--red:#ff7182}
    *{box-sizing:border-box}
    html,body{min-width:100%;min-height:100%;margin:0}
    body{background:var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
    .manager{width:min(100%,980px);min-height:100vh;min-height:100dvh;margin:0 auto;padding:max(22px,env(safe-area-inset-top)) 24px max(30px,env(safe-area-inset-bottom))}
    .toolbar{display:flex;justify-content:flex-end;margin-bottom:18px}
    .provider-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:12px;margin:0;padding:0;list-style:none}
    .provider-row{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
    .provider-name{min-width:0;overflow-wrap:anywhere;font-size:16px;font-weight:700}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    button{font:inherit;color:var(--text);cursor:pointer;border:1px solid #3a465e;border-radius:9px;background:#20283a;padding:9px 14px}
    button:hover{border-color:var(--blue);background:#273454}
    button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
    .primary{border-color:#6e8eff;background:#4d6ee0}
    .danger{color:#ffb1ba;border-color:#7b3442;background:#321b23}
    .secondary{background:transparent}
    .empty{padding:24px;border:1px dashed #354158;border-radius:13px;color:var(--muted);text-align:center}
    .notice{margin:0 0 16px;padding:12px 14px;border:1px solid #8d3947;border-radius:10px;color:#ffc0c7;background:#321b23}
    dialog{width:min(520px,calc(100vw - 32px));max-width:100%;max-height:min(88dvh,820px);overflow:auto;padding:0;border:1px solid #38445b;border-radius:16px;color:var(--text);background:#111621;box-shadow:0 24px 90px #0009}
    dialog::backdrop{background:#02040acc;backdrop-filter:blur(4px)}
    .dialog-inner{padding:22px}
    .dialog-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:18px}
    .dialog-head h2{margin:0;font-size:19px;letter-spacing:-.02em}
    .close{width:36px;height:36px;padding:0;font-size:20px;line-height:1}
    .field{margin-top:14px}
    .field:first-of-type{margin-top:0}
    label{display:block;margin-bottom:6px;color:#c8d0df;font-size:13px;font-weight:650}
    input,select{width:100%;font:inherit;color:var(--text);background:#0c1018;border:1px solid #303b50;border-radius:9px;padding:11px 12px}
    input[readonly]{color:var(--muted)}
    .hint{margin:6px 0 0;color:var(--muted);font-size:12px}
    .dialog-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:20px}
    .delete-actions{display:flex;justify-content:flex-start;margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}
    .login{width:min(100% - 32px,420px);margin:12vh auto}
    .login-card{padding:22px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
    .login-card h1{margin:0 0 18px;font-size:20px}
    @media(max-width:520px){.manager{padding-left:16px;padding-right:16px}.provider-list{grid-template-columns:1fr}.dialog-inner{padding:18px}}
  </style>
</head>
<body>${message}
  <script>
    document.getElementById('open-add')?.addEventListener('click', () => document.getElementById('add-dialog')?.showModal());
    document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => button.closest('dialog')?.close()));
    document.querySelectorAll('[data-edit-provider]').forEach((button) => {
      button.addEventListener('click', () => {
        const provider = button.getAttribute('data-edit-provider') || '';
        const editDialog = document.getElementById('edit-dialog');
        const editForm = document.getElementById('edit-form');
        if (!editDialog || !editForm) return;
        editForm.querySelector('[name=provider]').value = provider;
        document.getElementById('edit-provider-name').value = provider;
        document.getElementById('edit-base-url').value = button.getAttribute('data-base-url') || '';
        document.getElementById('edit-auth').value = button.getAttribute('data-auth') || 'bearer';
        document.getElementById('edit-key').value = '';
        document.getElementById('delete-provider').value = provider;
        const deleteForm = document.getElementById('delete-form');
        deleteForm.dataset.confirmed = 'false';
        deleteForm.dataset.confirm = 'Supprimer définitivement ' + provider + ' ?';
        deleteForm.querySelector('button').textContent = 'Supprimer';
        editDialog.showModal();
      });
    });
    document.getElementById('edit-dialog')?.addEventListener('close', () => document.getElementById('edit-form')?.reset());
    document.getElementById('add-dialog')?.addEventListener('close', () => document.getElementById('add-form')?.reset());
    document.querySelectorAll('[data-confirm]').forEach(function(form){form.addEventListener('submit',function(e){if(!confirm(form.dataset.confirm))e.preventDefault()})});
  </script>
</body>
</html>`;
}

function favicon(): Response { return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#92aaff"/><stop offset="1" stop-color="#4264dc"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="#10182d"/><path d="M17 22 7 32l10 10M47 22l10 10-10 10" fill="none" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 33h32" stroke="#32ded0" stroke-width="5" stroke-linecap="round"/><circle cx="16" cy="33" r="4" fill="#32ded0"/><circle cx="48" cy="33" r="4" fill="#32ded0"/><path d="M20 27c7-8 17-8 24 0" fill="none" stroke="#32ded0" stroke-width="3" stroke-linecap="round"/></svg>`, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } }); }

function webBridgeIcon(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.25" stroke="currentColor" stroke-width="1.33"/><path d="M2.9 8.15h14.2M2.9 11.85h14.2" stroke="currentColor" stroke-width="1.33" stroke-linecap="round"/><path d="M10 2.75c2.35 2 3.45 4.4 3.45 7.25S12.35 15.25 10 17.25C7.65 15.25 6.55 12.85 6.55 10S7.65 4.75 10 2.75Z" stroke="currentColor" stroke-width="1.33" stroke-linejoin="round"/></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}
function escapeHtml(value: string) { return value.replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char)); }
async function adminPage(env: Env, request: Request): Promise<Response> {
  if (!env.ADMIN_PAGE_CODE) return new Response("ADMIN_PAGE_CODE is not configured", { status: 503 });
  const session = cookie(request, ADMIN_COOKIE);
  if (session !== env.ADMIN_PAGE_CODE) {
    return new Response(htmlPage(`<main class='login'><section class='login-card'><h1>Accès</h1><form method='post' action='/keys/login'><div class='field'><label for='access-code'>Code d’accès</label><input id='access-code' name='code' type='password' required autofocus autocomplete='current-password'></div><div class='dialog-actions'><button class='primary' type='submit'>Continuer</button></div></form></section></main>`), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const listed = await env.OAUTH_KV.list({ prefix: "api-key:" });
  const rows = await Promise.all(listed.keys.map(async (entry) => {
    const provider = entry.name.slice("api-key:".length);
    let baseUrl = "";
    let auth = "bearer";
    try {
      const encrypted = await env.OAUTH_KV.get(entry.name);
      if (!encrypted) throw new Error("Provider disappeared during listing");
      const item = JSON.parse(await decrypt(encrypted, env)) as { baseUrl?: string; auth?: string };
      baseUrl = item.baseUrl ?? "";
      auth = item.auth === "x-api-key" ? "x-api-key" : "bearer";
    } catch {
      // Keep the entry editable so a replacement key can repair unreadable metadata.
    }
    return `<li class='provider-row'><span class='provider-name'>${escapeHtml(provider)}</span><button type='button' data-edit-provider='${escapeHtml(provider)}' data-base-url='${escapeHtml(baseUrl)}' data-auth='${auth}'>Modifier</button></li>`;
  }));

  const errorCode = new URL(request.url).searchParams.get("error");
  const errorMessages: Record<string, string> = {
    exists: "Ce nom de provider existe déjà. Ouvre sa fenêtre Modifier pour changer sa configuration.",
    missing: "Une clé API est nécessaire pour ajouter un provider.",
    unreadable: "La clé existante n’a pas pu être conservée. Saisis une nouvelle clé API et réessaie.",
  };
  const notice = errorCode && errorMessages[errorCode] ? `<p class='notice' role='alert'>${errorMessages[errorCode]}</p>` : "";
  const providerRows = rows.length ? `<ul class='provider-list'>${rows.join("")}</ul>` : `<div class='empty'>Aucun provider configuré.</div>`;
  const content = `<main class='manager'><h1 class='sr-only'>Providers</h1>${notice}<div class='toolbar'><button id='open-add' class='primary' type='button'>Ajouter un provider</button></div>${providerRows}
    <dialog id='add-dialog' aria-labelledby='add-title'><div class='dialog-inner'><div class='dialog-head'><h2 id='add-title'>Ajouter un provider</h2><button class='close' type='button' data-close-modal aria-label='Fermer'>×</button></div>
      <form id='add-form' method='post' action='/keys'><input type='hidden' name='mode' value='add'><div class='field'><label for='add-provider'>Nom du provider</label><input id='add-provider' name='provider' required pattern='[A-Za-z0-9._-]{1,50}' placeholder='openrouter' autocomplete='off'></div>
        <div class='field'><label for='add-base-url'>URL de base autorisée</label><input id='add-base-url' name='baseUrl' type='url' required placeholder='https://api.example.com'></div>
        <div class='field'><label for='add-key'>Clé API</label><input id='add-key' name='key' type='password' required autocomplete='new-password'></div>
        <div class='field'><label for='add-auth'>Authentification</label><select id='add-auth' name='auth'><option value='bearer'>Authorization: Bearer</option><option value='x-api-key'>x-api-key</option></select></div>
        <div class='dialog-actions'><button class='secondary' type='button' data-close-modal>Annuler</button><button class='primary' type='submit'>Enregistrer</button></div></form></div></dialog>
    <dialog id='edit-dialog' aria-labelledby='edit-title'><div class='dialog-inner'><div class='dialog-head'><h2 id='edit-title'>Modifier le provider</h2><button class='close' type='button' data-close-modal aria-label='Fermer'>×</button></div>
      <form id='edit-form' method='post' action='/keys'><input type='hidden' name='mode' value='edit'><input type='hidden' name='provider'>
        <div class='field'><label for='edit-provider-name'>Nom du provider</label><input id='edit-provider-name' type='text' readonly></div>
        <div class='field'><label for='edit-base-url'>URL de base autorisée</label><input id='edit-base-url' name='baseUrl' type='url' required></div>
        <div class='field'><label for='edit-key'>Nouvelle clé API</label><input id='edit-key' name='key' type='password' autocomplete='new-password' placeholder='Laisser vide pour conserver la clé actuelle'><p class='hint'>La clé actuelle n’est jamais affichée.</p></div>
        <div class='field'><label for='edit-auth'>Authentification</label><select id='edit-auth' name='auth'><option value='bearer'>Authorization: Bearer</option><option value='x-api-key'>x-api-key</option></select></div>
        <div class='dialog-actions'><button class='secondary' type='button' data-close-modal>Annuler</button><button class='primary' type='submit'>Enregistrer</button></div></form>
      <form id='delete-form' class='delete-actions' method='post' action='/keys/delete' data-confirm='Supprimer définitivement ce provider ?'><input id='delete-provider' type='hidden' name='provider'><button class='danger' type='submit'>Supprimer</button></form></div></dialog>
  </main>`;
  return new Response(htmlPage(content), { headers: { "content-type": "text/html; charset=utf-8" } });
}

function preserveEmbeddedKeysActions(html: string, embedded: boolean) {
  if (!embedded) return html;
  return html
    .replaceAll('action="/keys/delete"', 'action="/keys/delete?embedded=1"')
    .replaceAll('action="/keys/logout"', 'action="/keys/logout?embedded=1"')
    .replaceAll('action="/keys/login"', 'action="/keys/login?embedded=1"')
    .replaceAll('action="/keys"', 'action="/keys?embedded=1"')
    .replaceAll("action='/keys/delete'", "action='/keys/delete?embedded=1'")
    .replaceAll("action='/keys/logout'", "action='/keys/logout?embedded=1'")
    .replaceAll("action='/keys/login'", "action='/keys/login?embedded=1'")
    .replaceAll("action='/keys'", "action='/keys?embedded=1'")
    .replaceAll('if(!confirm(form.dataset.confirm))e.preventDefault()', 'if(form.dataset.confirmed==="true")return;e.preventDefault();form.dataset.confirmed="true";var button=form.querySelector("button");if(button)button.textContent="Confirmer la suppression"');
}

async function keysPage(env: Env, request: Request): Promise<Response> {
  const embedded = new URL(request.url).searchParams.get("embedded") === "1";
  const response = await adminPage(env, request);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(preserveEmbeddedKeysActions(await response.text(), embedded), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function keysPageUrl(embedded: boolean, error?: string) {
  const params = new URLSearchParams();
  if (embedded) params.set("embedded", "1");
  if (error) params.set("error", error);
  const query = params.toString();
  return `/keys${query ? `?${query}` : ""}`;
}

async function keysPost(request: Request, env: Env) {
  const url = new URL(request.url);
  const embedded = url.searchParams.get("embedded") === "1";
  const form = await request.formData();
  const path = url.pathname;
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== origin(env)) return new Response("Forbidden", { status: 403 });
  if (path === "/keys/login") {
    if (form.get("code") !== env.ADMIN_PAGE_CODE) return new Response(preserveEmbeddedKeysActions(htmlPage(`<main class='login'><section class='login-card'><h1>Accès</h1><p class='notice' role='alert'>Code incorrect.</p><form method='post' action='/keys/login'><div class='field'><label for='access-code'>Code d’accès</label><input id='access-code' name='code' type='password' required autofocus autocomplete='current-password'></div><div class='dialog-actions'><button class='primary' type='submit'>Continuer</button></div></form></section></main>`), embedded), { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
    return new Response(null, { status: 303, headers: { Location: `/keys${embedded ? "?embedded=1" : ""}`, "set-cookie": cookieHeader(ADMIN_COOKIE, env.ADMIN_PAGE_CODE!, 86400, embedded) } });
  }
  if (cookie(request, ADMIN_COOKIE) !== env.ADMIN_PAGE_CODE) return new Response("Forbidden", { status: 403 });
  if (path === "/keys/logout") return new Response(null, { status: 303, headers: { Location: `/keys${embedded ? "?embedded=1" : ""}`, "set-cookie": cookieHeader(ADMIN_COOKIE, "", 0, embedded) } });

  const provider = String(form.get("provider") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,50}$/.test(provider)) return new Response("Invalid provider", { status: 400 });
  if (path === "/keys/delete") {
    await env.OAUTH_KV.delete(`api-key:${provider}`);
  } else if (path === "/keys") {
    const mode = String(form.get("mode") ?? "");
    if (mode !== "add" && mode !== "edit") return new Response("Invalid operation", { status: 400 });
    const keyName = `api-key:${provider}`;
    const existing = await env.OAUTH_KV.get(keyName);
    if (mode === "add" && existing) {
      return new Response(null, { status: 303, headers: { Location: keysPageUrl(embedded, "exists") } });
    }
    if (mode === "edit" && !existing) return new Response("Provider not found", { status: 404 });
    let apiKey = String(form.get("key") ?? "");
    if (mode === "edit" && !apiKey && existing) {
      try {
        const previous = JSON.parse(await decrypt(existing, env)) as { key?: unknown };
        apiKey = typeof previous.key === "string" ? previous.key : "";
      } catch {
        return new Response(null, { status: 303, headers: { Location: keysPageUrl(embedded, "unreadable") } });
      }
      if (!apiKey) return new Response(null, { status: 303, headers: { Location: keysPageUrl(embedded, "unreadable") } });
    }
    if (mode === "add" && !apiKey) return new Response(null, { status: 303, headers: { Location: keysPageUrl(embedded, "missing") } });
    const baseUrl = safeUrl(String(form.get("baseUrl") ?? "")).origin;
    await env.OAUTH_KV.put(keyName, await encrypt(JSON.stringify({ label: provider, baseUrl, key: apiKey, auth: form.get("auth") === "x-api-key" ? "x-api-key" : "bearer" }), env));
  } else {
    return new Response("Not found", { status: 404 });
  }
  return new Response(null, { status: 303, headers: { Location: keysPageUrl(embedded) } });
}

function authError(error: unknown): Response { if (!(error instanceof AuthorizationError)) throw error; if (!error.redirectUri) return new Response(error.description, { status: 400 }); const redirect = new URL(error.redirectUri); redirect.searchParams.set("error", error.code); redirect.searchParams.set("error_description", error.description); if (error.state) redirect.searchParams.set("state", error.state); return Response.redirect(redirect, 302); }
const STATE_COOKIE_NAME = STATE_COOKIE;
function allowed(env: Env) { return new Set([env.GITHUB_ALLOWED_LOGIN, ...(env.GITHUB_ALLOWED_LOGINS ?? "").split(",")].map((x) => x?.trim().toLowerCase()).filter(Boolean)); }
function stateCookie(value: string, maxAge = TTL) { return cookieHeader(STATE_COOKIE_NAME, value, maxAge); }
function randomToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join(""); }
async function authorize(request: Request, env: Env) { if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return new Response("GitHub OAuth is not configured.", { status: 503 }); let authRequest: AuthRequest; try { authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request); } catch (e) { return authError(e); } const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId); if (!client) return new Response("Unknown OAuth client", { status: 400 }); const state = randomToken(); await env.OAUTH_KV.put(`github-state:${state}`, JSON.stringify(authRequest), { expirationTtl: TTL }); const github = new URL("https://github.com/login/oauth/authorize"); github.searchParams.set("client_id", env.GITHUB_CLIENT_ID); github.searchParams.set("redirect_uri", `${origin(env)}/callback`); github.searchParams.set("scope", "read:user"); github.searchParams.set("state", state); return new Response(null, { status: 302, headers: { Location: github.toString(), "set-cookie": stateCookie(state) } }); }
async function callback(request: Request, env: Env) { const url = new URL(request.url); const state = url.searchParams.get("state"); const code = url.searchParams.get("code"); if (!state || !code || cookie(request, STATE_COOKIE_NAME) !== state) return new Response("Invalid OAuth callback", { status: 400 }); const stored = await env.OAUTH_KV.get(`github-state:${state}`); await env.OAUTH_KV.delete(`github-state:${state}`); if (!stored) return new Response("OAuth request expired", { status: 400 }); const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${origin(env)}/callback` }) }); const token = await tokenResponse.json() as { access_token?: string }; if (!token.access_token) return new Response("GitHub authentication failed", { status: 502 }); const userResponse = await fetch("https://api.github.com/user", { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "web-extractor-mcp" } }); const user = await userResponse.json() as { id?: number; login?: string }; if (!user.id || !user.login) return new Response("Could not identify GitHub account", { status: 502 }); const allowlist = allowed(env); if (allowlist.size && !allowlist.has(user.login.toLowerCase())) return new Response("GitHub account is not allowed", { status: 403 }); const authRequest = JSON.parse(stored) as AuthRequest; const result = await env.OAUTH_PROVIDER.completeAuthorization({ request: authRequest, userId: String(user.id), metadata: { githubLogin: user.login }, scope: authRequest.scope.filter((x) => x === "mcp:read"), props: { githubLogin: user.login, githubId: user.id } }); return new Response(null, { status: 302, headers: { Location: result.redirectTo, "set-cookie": stateCookie("", 0) } }); }

let defaultHandler: ExportedHandler<Env>;
defaultHandler = { async fetch(request, env) { const url = new URL(request.url); if (url.pathname === "/keys" && request.method === "GET") return await keysPage(env, request); if ((url.pathname === "/keys" || url.pathname === "/keys/login" || url.pathname === "/keys/delete" || url.pathname === "/keys/logout") && request.method === "POST") return keysPost(request, env); if (url.pathname === "/authorize" && request.method === "GET") return authorize(request, env); if (url.pathname === "/callback" && request.method === "GET") return callback(request, env); if (url.pathname === "/") return new Response("Web Bridge MCP"); return new Response("Not found", { status: 404 }); } };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const directPath = new URL(request.url).pathname;
    if (directPath === "/favicon.svg" && request.method === "GET") return favicon();
    if (directPath === "/web-bridge-icon.svg" && request.method === "GET") return webBridgeIcon();
    if (directPath === "/keys" && request.method === "GET") return await keysPage(env, request);
    if ((directPath === "/keys" || directPath === "/keys/login" || directPath === "/keys/delete" || directPath === "/keys/logout") && request.method === "POST") return keysPost(request, env);

    const publicOrigin = origin(env);
    const provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        fetch: (req, e, c) => {
          const handler = createMcpHandler(() => createServer(e), { route: "/mcp", responseMode: "auto" });
          return handler(req, e, c);
        },
      },
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["mcp:read"],
      resourceMetadata: {
        resource: `${publicOrigin}/mcp`,
        authorization_servers: [publicOrigin],
        scopes_supported: ["mcp:read"],
        resource_name: "Web Bridge MCP",
      },
      clientIdMetadataDocumentEnabled: true,
    });

    let providerRequest = request;
    if (new URL(request.url).pathname === "/register" && request.method === "POST") {
      const metadata = await request.clone().json() as Record<string, unknown>;
      if (!metadata.token_endpoint_auth_method) metadata.token_endpoint_auth_method = "none";
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      providerRequest = new Request(request, { body: JSON.stringify(metadata), headers });
    }

    return provider.fetch(providerRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;
