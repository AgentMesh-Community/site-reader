// Read a website: fetch the address and the same-site pages it links to, keep each
// page's readable text in reading order, and write out/site-read.json. Say who the
// site is, from what it says about itself: the company's name and one-line
// description, and the address read, in out/subject.json. pieces.json lists both.
// No model is called, and nothing is made up: when nothing on the site names the
// company, the name is the site's host and the reply says so.
//
//   needs: node >= 22
//   node scripts/read-site.mjs --job <job folder> --text-file <message> [--file <path>::<media type>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stopReplyFor } from "./stop-notice.mjs";

const BATCH = 5;
const TIMEOUT_MS = 10000;

export function parseArgs(argv) {
  const out = { job: "", textFile: "", files: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--job") out.job = value, i++;
    else if (flag === "--text-file") out.textFile = value, i++;
    else if (flag === "--file") out.files.push(String(value).split("::")[0]), i++;
    else if (flag === "--records" || flag === "--work") i++;
  }
  return out;
}

function firstAddress(text) {
  const m = String(text).match(/https?:\/\/[^\s"'<>)\]]+/);
  return m ? m[0].replace(/[.,;]+$/, "") : "";
}

// The address and max_pages, from the message text and the input files.
export function readRequest(text, files = []) {
  const said = String(text ?? "").match(/url\s*:\s*(https?:\/\/\S+)/i);
  let url = said ? firstAddress(said[1]) : "";
  if (!url) {
    const named = files.find((f) => /url/i.test(basename(f)) && existsSync(f));
    if (named) url = firstAddress(readFileSync(named, "utf8"));
  }
  if (!url) url = firstAddress(text);
  const n = String(text ?? "").match(/max_pages\s*:\s*(\d+)/i);
  const maxPages = n && Number(n[1]) > 0 ? Number(n[1]) : 10;
  return { url, maxPages };
}

const objectIn = (s) => {
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
};

// A subject given as input: an input file whose name contains subject, else a
// `subject: {...}` line in the message. Null when none was given.
export function givenSubject(text, files = []) {
  for (const f of files) {
    if (!/subject/i.test(basename(f)) || !existsSync(f)) continue;
    const v = objectIn(readFileSync(f, "utf8"));
    if (v) return v;
  }
  const line = String(text ?? "").match(/^\s*subject\s*:\s*(\{.*\})\s*$/im);
  return line ? objectIn(line[1]) : null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

// The page's title and its readable text, one line per heading or block.
export function readable(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|nav|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _h, inner) => `\n${inner.replace(/<[^>]+>/g, " ")}\n`)
    .replace(/<(br|\/?(p|div|li|ul|ol|tr|td|th|section|article|header|footer|main|table|blockquote|pre|dd|dt))\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const lines = decode(text).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  return { title, text: lines.join("\n") };
}

// ---- Who the site is ----

const clean = (s) => decode(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const squash = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const bareHost = (host) => String(host).toLowerCase().replace(/:\d+$/, "").replace(/^www\d*\./, "");
const GENERIC = /^(home|home ?page|index|main|untitled|welcome|official (web ?)?site)$/i;
const ORG = /organi[sz]ation|corporation|business|company|^ngo$/i;
const SUFFIX = /^(inc|co|ltd|llc|corp|plc|gmbh|ag|sa|s\.a|bv|pty)\.$/i;

// Short enough to be a name and not a sentence: at most six words, and no
// ending stop unless it is a company suffix such as Inc.
function nameLike(s) {
  if (!s || s.length > 60 || !/[\p{L}\p{N}]/u.test(s) || GENERIC.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length > 6) return false;
  return !/[.!?]$/.test(s) || SUFFIX.test(words[words.length - 1]);
}

// The page's meta tags by property or name, first of each kept.
export function metaOf(html) {
  const out = {};
  for (const m of String(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const at = {};
    for (const a of m[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) at[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const key = String(at.property || at.name || at.itemprop || "").toLowerCase();
    const value = clean(at.content);
    if (key && value && !(key in out)) out[key] = value;
  }
  return out;
}

// The name of the organisation the site's structured data describes, when that
// organisation is the site's own (no address, or an address on the same host).
function organisationName(html, host) {
  const names = [];
  const own = (url) => {
    if (typeof url !== "string" || !url.trim()) return true;
    try { return bareHost(new URL(url, `https://${host}/`).host) === bareHost(host); } catch { return false; }
  };
  const visit = (v) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const types = [].concat(v["@type"] ?? []).map(String);
    if (types.some((t) => ORG.test(t)) && typeof v.name === "string" && own(v.url)) names.push(clean(v.name));
    if (v["@graph"]) visit(v["@graph"]);
  };
  for (const m of String(html).matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* not JSON */ }
  }
  return names.find(Boolean) ?? "";
}

// The name in a page title: the title cut at its separators, without the
// taglines and the words every site uses (Home, Welcome to). The part that
// matches the host wins, else the first.
export function nameInTitle(title, host) {
  const parts = clean(title)
    .split(/\s*[|\u00b7\u2022\u00bb\u005c]\s*|\s+[-\u2013\u2014/~]\s+|\s*[\u2013\u2014]\s*|:\s+/)
    .map((p) => p.replace(/^welcome to\s+/i, "").trim())
    .filter((p) => p && !GENERIC.test(p));
  const label = squash(bareHost(host).split(".")[0]);
  const matching = parts.find((p) => { const s = squash(p); return s.length >= 3 && (s.includes(label) || label.includes(s)); });
  const pick = matching ?? parts[0] ?? "";
  return nameLike(pick) ? pick : "";
}

function firstHeading(html) {
  const body = String(html).replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ");
  const h1 = clean(body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  return nameLike(h1) ? h1 : "";
}

// One line: the description as the site wrote it, or its first sentence when it runs long.
function oneLineOf(s) {
  if (s.length <= 200) return s;
  const first = s.split(/(?<=[.!?])\s+/)[0];
  if (first.length <= 240) return first;
  const cut = first.slice(0, 200);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\s]+$/, "")}...`;
}

// The first full sentence of the page's text: six words or more, ending in a stop.
function firstSentence(text) {
  for (const line of String(text).split("\n")) {
    for (const s of line.split(/(?<=[.!?])\s+/)) {
      const t = s.trim();
      if (/[.!?]$/.test(t) && t.split(/\s+/).length >= 6 && t.length <= 240) return t;
    }
  }
  return "";
}

/**
 * Who the site is, from the home page it read: { subject: { name, one_line,
 * url }, from: { name, line } }, where from says in words where each came from.
 * A given subject keeps its name and line; only what it leaves blank is taken
 * from the site. Nothing is made up: with nothing on the site naming the
 * company, the name is the host and from.name is null; with nothing
 * describing it, the line is blank and from.line is null.
 */
export function subjectFrom({ html, page, address, given = null }) {
  const host = new URL(address).host;
  const g = given && typeof given === "object" ? given : {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const meta = metaOf(html);
  let name = str(g.name), nameFrom = name ? "as given" : null;
  if (!name) {
    const found = [
      [meta["og:site_name"], "from the name the site gives itself"],
      [meta["application-name"], "from the site's application name"],
      [organisationName(html, host), "from the site's own organisation record"],
      [nameInTitle(page?.title ?? "", host), "from the home page title"],
      [firstHeading(html), "from the home page's first heading"],
    ].find(([v]) => v && v.length <= 80 && !GENERIC.test(v));
    if (found) [name, nameFrom] = found;
  }
  let line = str(g.one_line) || str(g.line), lineFrom = line ? "as given" : null;
  if (!line) {
    const said = meta.description || meta["og:description"];
    if (said) [line, lineFrom] = [oneLineOf(said), "from the site's description"];
    else {
      const first = firstSentence(page?.text ?? "");
      if (first) [line, lineFrom] = [first, "from the home page's first sentence"];
    }
  }
  const url = str(g.url) || str(g.website) || address;
  return { subject: { name: name || bareHost(host), one_line: line, url }, from: { name: nameFrom, line: lineFrom } };
}

// Same-host links on the page, absolute, without their #fragment.
export function sameSiteLinks(html, pageUrl, host) {
  const found = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(decode(m[1]), pageUrl);
      u.hash = "";
      if (/^https?:$/.test(u.protocol) && u.host === host) found.push(u.href);
    } catch { /* not an address */ }
  }
  return found;
}

const PLAIN = /^text\/(plain|markdown)\b/i;

// One page: { html } for a web page, { plain } for plain text, null for
// anything else or a page that did not answer in time.
async function fetchPage(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    const type = res.headers?.get?.("content-type") ?? "text/html";
    if (!res.ok) return null;
    if (/html/i.test(type)) return { html: await res.text() };
    if (PLAIN.test(type)) return { plain: await res.text() };
    return null;
  } catch { return null; }
}

/**
 * Plain text read as one page: its lines with the spacing squeezed and the
 * blank lines dropped, and for a title its first line when that line is
 * short enough to be one. Words pasted into a solution's web-address box
 * arrive this way, as a plain text link, and were thrown away as "not a web
 * page" (2026-09-25).
 */
export function readablePlain(body) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const title = lines.length && lines[0].length <= 120 ? lines[0] : "";
  return { title, text: lines.join("\n") };
}

// Fetch pages breadth first, in parallel batches, until max_pages are read.
// Plain text is read only at the address itself, as one page: it has no links
// to follow, and a crawl should not pick up every .txt file a site links to.
export async function readSite(start, maxPages, fetchImpl = fetch) {
  const first = new URL(start);
  first.hash = "";
  const host = first.host;
  const seen = new Set([first.href]);
  let queue = [first.href];
  const pages = [];
  let home = "";
  let plain = false;
  while (queue.length && pages.length < maxPages) {
    const batch = queue.splice(0, Math.min(BATCH, maxPages - pages.length));
    const got = await Promise.all(batch.map((u) => fetchPage(u, fetchImpl)));
    got.forEach((page, i) => {
      if (page == null || pages.length >= maxPages) return;
      if (page.plain != null) {
        if (batch[i] !== first.href || pages.length) return;
        plain = true;
        pages.push({ url: batch[i], ...readablePlain(page.plain) });
        return;
      }
      const html = page.html;
      if (!pages.length) home = html;
      pages.push({ url: batch[i], ...readable(html) });
      for (const link of sameSiteLinks(html, batch[i], host)) {
        if (!seen.has(link)) seen.add(link), queue.push(link);
      }
    });
  }
  // home: the markup of the page at the address, which says who the site is.
  // plain: the address answered with plain text, read as the one page.
  return { host, pages, home, plain };
}

/**
 * A reply that says the job cannot be done. It opens "I cannot", the words
 * the process runner reads as a refusal (classifyReply in
 * process-runner/scripts/match-reply.mjs), and is cut short of 600
 * characters, past which the runner reads none. "I need a web address" and
 * "I could not read any page" were read as questions for the owner, and a run
 * waits on an answer nobody can give (2026-09-24).
 */
export function refusal(text) {
  return text.length < 600 ? text : `${text.slice(0, 596)}...`;
}

export async function run(argv, fetchImpl = fetch) {
  const args = parseArgs(argv);
  // The runner's stop notice is not a request to read anything (stop-notice.mjs).
  const stopped = stopReplyFor(args.textFile);
  if (stopped) return { reply: stopped };
  const text = args.textFile && existsSync(args.textFile) ? readFileSync(args.textFile, "utf8") : "";
  const { url, maxPages } = readRequest(text, args.files);
  if (!url) return { reply: "I cannot read a site: there is no web address in the message. Send one as `url: https://example.com`." };
  let host = "";
  try { host = new URL(url).host; } catch { return { reply: refusal(`I cannot read ${url}; it is not a web address.`) }; }
  const site = await readSite(url, maxPages, fetchImpl);
  if (!site.pages.length) return { reply: refusal(`I cannot read ${url}: no page there could be read. Each one failed to load, took longer than ${TIMEOUT_MS / 1000} seconds, or was neither a web page nor plain text. Check the address and send it again.`) };
  const who = subjectFrom({ html: site.home, page: site.pages[0], address: url, given: givenSubject(text, args.files) });
  const out = join(args.job || ".", "out");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "site-read.json"), JSON.stringify({ pages: site.pages }, null, 2) + "\n");
  writeFileSync(join(out, "subject.json"), JSON.stringify(who.subject, null, 2) + "\n");
  const pieces = [{
    name: "site-read", step: "read-site", path: "out/site-read.json", media_type: "application/json",
    about: "The pages of the site in reading order, each with its url, title and readable text.",
    produced_from: [url],
  }, {
    name: "subject", step: "read-site", path: "out/subject.json", media_type: "application/json",
    about: "Who the site is: the company's name and one-line description as the site gives them, and the address read.",
    produced_from: [url],
  }];
  writeFileSync(join(args.job || ".", "pieces.json"), JSON.stringify(pieces, null, 2) + "\n");
  const n = site.pages.length;
  const where = site.plain ? "in the text" : "on the site";
  const said = [site.plain
    ? `Read the plain text at ${host} as one page; plain text has no links to follow.`
    : `Read ${n} page${n === 1 ? "" : "s"} from ${host}.`];
  if (who.from.name) said.push(`The company is ${who.subject.name}, ${site.plain ? who.from.name.replace("the home page title", "the text's first line") : who.from.name}.`);
  else said.push(`Nothing ${where} names the company, so I named it by its address, ${who.subject.name}.`);
  if (!who.from.line) said.push(`Nothing ${where} describes it in a line, so the line is blank.`);
  return { reply: said.join(" ") };
}

const thisFile = process.argv[1] ? basename(process.argv[1].replace(/\\/g, "/")) : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  run(process.argv.slice(2))
    .then((r) => console.log(JSON.stringify(r)))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
