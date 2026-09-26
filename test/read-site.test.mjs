// Tests for read-site.mjs against a tiny fake site, with fetch stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReply } from "../../../process-runner/scripts/match-reply.mjs";
import { readRequest, readable, run } from "../scripts/read-site.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/read-site.mjs", import.meta.url));

const SITE = {
  "https://acme.test/": `<html><head><title>Acme &amp; Co</title><style>.x{}</style></head><body>
    <nav><a href="/menu">Menu words</a></nav><h1>Acme builds widgets</h1><p>We ship fast.</p>
    <script>alert("no")</script><a href="/pricing">Pricing</a> <a href="/about#team">About</a>
    <a href="https://other.test/x">Elsewhere</a></body></html>`,
  "https://acme.test/pricing": `<title>Pricing</title><h2>Plans</h2><p>Basic is $10 a month.</p><a href="/">Home</a>`,
  "https://acme.test/about": `<title>About</title><p>Founded in 2020.</p>`,
  "https://acme.test/menu": `<title>Menu</title><p>Menu page.</p>`,
};

function fakeFetch(seen = [], site = SITE, types = {}) {
  return async (url, opts) => {
    seen.push({ url: String(url), signal: opts?.signal });
    const body = site[String(url)];
    return {
      ok: body !== undefined,
      headers: { get: () => types[String(url)] ?? "text/html; charset=utf-8" },
      text: async () => body ?? "",
    };
  };
}

function jobWith(message) {
  const job = mkdtempSync(join(tmpdir(), "site-reader-"));
  writeFileSync(join(job, "message.txt"), message);
  return job;
}

test("reads the address and max_pages from the message, or defaults to ten", () => {
  assert.deepEqual(readRequest("url: https://acme.test/\nmax_pages: 3"), { url: "https://acme.test/", maxPages: 3 });
  assert.deepEqual(readRequest("Please read https://acme.test/pricing, thanks"), { url: "https://acme.test/pricing", maxPages: 10 });
});

test("reads the address from an input file named for the url port", () => {
  const job = jobWith("");
  const file = join(job, "url.txt");
  writeFileSync(file, "https://acme.test/about\n");
  assert.equal(readRequest("no address here", [file]).url, "https://acme.test/about");
});

test("keeps headings as lines and strips script, style and nav", () => {
  const page = readable(SITE["https://acme.test/"]);
  assert.equal(page.title, "Acme & Co");
  assert.match(page.text, /^Acme builds widgets\nWe ship fast\./);
  assert.doesNotMatch(page.text, /alert|Menu words|\.x\{/);
});

test("reads the same-site pages, each fetch with a timeout, and writes site-read and pieces", async () => {
  const seen = [];
  const job = jobWith("url: https://acme.test/");
  const r = await run(["--job", job, "--text-file", join(job, "message.txt")], fakeFetch(seen));
  assert.match(r.reply, /^Read 4 pages from acme\.test\. /);
  const read = JSON.parse(readFileSync(join(job, "out", "site-read.json"), "utf8"));
  assert.deepEqual(read.pages.map((p) => p.url), ["https://acme.test/", "https://acme.test/menu", "https://acme.test/pricing", "https://acme.test/about"]);
  assert.match(read.pages[2].text, /Basic is \$10 a month\./);
  assert.ok(seen.every((s) => s.url.startsWith("https://acme.test/") && s.signal instanceof AbortSignal));
  const pieces = JSON.parse(readFileSync(join(job, "pieces.json"), "utf8"));
  assert.equal(pieces[0].path, "out/site-read.json");
  assert.equal(pieces[0].media_type, "application/json");
});

test("stops at max_pages", async () => {
  const job = jobWith("url: https://acme.test/\nmax_pages: 2");
  const r = await run(["--job", job, "--text-file", join(job, "message.txt")], fakeFetch());
  assert.match(r.reply, /^Read 2 pages from acme\.test\. /);
  assert.equal(JSON.parse(readFileSync(join(job, "out", "site-read.json"), "utf8")).pages.length, 2);
});

test("with no address, or no page at it to read, it refuses in words the process runner reads as a refusal", async () => {
  // A work order from an empty Start form, through the command the spec names.
  const empty = jobWith("run r-20260924-ab12 phase read-the-site: here is work\ninputs: none named by the process, and the run carried no material.\n");
  const r = spawnSync(process.execPath, [SCRIPT, "--job", empty, "--text-file", join(empty, "message.txt")], { encoding: "utf8" });
  const printed = JSON.parse(r.stdout).reply;
  assert.equal(printed, "I cannot read a site: there is no web address in the message. Send one as `url: https://example.com`.");
  assert.equal(existsSync(join(empty, "pieces.json")), false);
  const reply = async (message, site = SITE) => {
    const job = jobWith(message);
    return (await run(["--job", job, "--text-file", join(job, "message.txt")], fakeFetch([], site))).reply;
  };
  const replies = [
    printed,
    await reply("read our website please"),
    await reply("url: https://[not-an-address"),
    await reply("url: https://gone.test/"),
    await reply(`url: https://gone.test/${"deep/".repeat(150)}`),
  ];
  for (const said of replies) {
    assert.ok(said.length < 600, `${said.length} characters: ${said}`);
    assert.match(said, /^I cannot /);
    assert.equal(classifyReply({ text: said, files: [] }), "refused", said);
  }
  assert.match(replies[3], /^I cannot read https:\/\/gone\.test\/: no page there could be read\./);
  const read = await reply("url: https://acme.test/");
  assert.notEqual(classifyReply({ text: read, files: [] }), "refused", "a site read does not read as a refusal, even with its files left off");
});

// Who the site is (2.0.2): the subject piece, { name, one_line, url }, the shape
// pitch-writer and scene-writer read, taken from what the site says about itself.

const TAGGED = {
  "https://brightwater.test/": `<html><head><title>Home | Clean water, proven</title>
    <meta property="og:site_name" content="Brightwater Labs">
    <meta name="description" content="Brightwater Labs tests drinking water for small towns.">
    </head><body><h1>Clean water, proven</h1><p>We test water.</p></body></html>`,
};
const TITLED = {
  "https://www.kestrel.test/": `<html><head><title>Move more for less | Kestrel Freight</title></head><body>
    <h1>Move more for less</h1><p>Kestrel Freight moves pallets across the Midwest every night. Call us.</p></body></html>`,
};
const BARE = { "https://www.quiet.test/": `<html><body><div>ok</div></body></html>` };

async function readWith(site, message, files = []) {
  const job = jobWith(message);
  const argv = ["--job", job, "--text-file", join(job, "message.txt")];
  for (const [name, body] of files) {
    writeFileSync(join(job, name), body);
    argv.push("--file", `${join(job, name)}::application/json`);
  }
  const r = await run(argv, fakeFetch([], site));
  const subject = JSON.parse(readFileSync(join(job, "out", "subject.json"), "utf8"));
  const pieces = JSON.parse(readFileSync(join(job, "pieces.json"), "utf8"));
  return { r, subject, pieces };
}

test("a site with a site name tag and a description: the subject is the name and line it gives itself", async () => {
  const { r, subject, pieces } = await readWith(TAGGED, "url: https://brightwater.test/");
  assert.deepEqual(subject, { name: "Brightwater Labs", one_line: "Brightwater Labs tests drinking water for small towns.", url: "https://brightwater.test/" });
  assert.deepEqual(pieces.map((p) => [p.name, p.path, p.media_type]), [
    ["site-read", "out/site-read.json", "application/json"],
    ["subject", "out/subject.json", "application/json"],
  ]);
  assert.equal(r.reply, "Read 1 page from brightwater.test. The company is Brightwater Labs, from the name the site gives itself.");
});

test("a site with only a title: the name is the title's part that is not a tagline, the line its first full sentence", async () => {
  const { r, subject } = await readWith(TITLED, "url: https://www.kestrel.test/");
  assert.deepEqual(subject, { name: "Kestrel Freight", one_line: "Kestrel Freight moves pallets across the Midwest every night.", url: "https://www.kestrel.test/" });
  assert.match(r.reply, /The company is Kestrel Freight, from the home page title\.$/);
});

test("a given subject keeps its name and line; the site fills only what it leaves blank", async () => {
  const asFile = await readWith(TAGGED, "url: https://brightwater.test/", [["subject.json", JSON.stringify({ name: "Brightwater Co-op", one_line: "", url: "" })]]);
  assert.deepEqual(asFile.subject, { name: "Brightwater Co-op", one_line: "Brightwater Labs tests drinking water for small towns.", url: "https://brightwater.test/" });
  assert.match(asFile.r.reply, /The company is Brightwater Co-op, as given\./);
  const asLine = await readWith(TAGGED, 'url: https://brightwater.test/\n  subject: {"name":"BWL","one_line":"We test water.","url":"https://bwl.example/"}');
  assert.deepEqual(asLine.subject, { name: "BWL", one_line: "We test water.", url: "https://bwl.example/" });
});

// Plain text (2.0.4): words pasted into a solution's web-address box arrive as
// a plain text link, and were thrown away as "not a web page".

const PASTED = "https://app.test/v1/pieces/tok_abc";
const PASTED_SITE = {
  [PASTED]: "Northwind Bakery\r\n\r\nNorthwind Bakery bakes sourdough for cafes across Leeds every morning.\n  We deliver before seven.  \n",
};
const PLAIN_TYPE = { [PASTED]: "text/plain; charset=utf-8" };

test("plain text at the address is read as one page, and the subject comes from its first line", async () => {
  const job = jobWith(`url: ${PASTED}`);
  const r = await run(["--job", job, "--text-file", join(job, "message.txt")], fakeFetch([], PASTED_SITE, PLAIN_TYPE));
  const read = JSON.parse(readFileSync(join(job, "out", "site-read.json"), "utf8"));
  assert.deepEqual(read.pages, [{
    url: PASTED,
    title: "Northwind Bakery",
    text: "Northwind Bakery\nNorthwind Bakery bakes sourdough for cafes across Leeds every morning.\nWe deliver before seven.",
  }]);
  const subject = JSON.parse(readFileSync(join(job, "out", "subject.json"), "utf8"));
  assert.deepEqual(subject, { name: "Northwind Bakery", one_line: "Northwind Bakery bakes sourdough for cafes across Leeds every morning.", url: PASTED });
  assert.equal(r.reply, "Read the plain text at app.test as one page; plain text has no links to follow. The company is Northwind Bakery, from the text's first line.");
  assert.notEqual(classifyReply({ text: r.reply, files: [] }), "refused");
});

test("a site's crawl still reads only web pages: a plain text file it links to is not a page", async () => {
  const site = { ...SITE, "https://acme.test/": SITE["https://acme.test/"].replace("</body>", `<a href="/notes.txt">Notes</a></body>`), "https://acme.test/notes.txt": "just notes" };
  const job = jobWith("url: https://acme.test/");
  await run(["--job", job, "--text-file", join(job, "message.txt")], fakeFetch([], site, { "https://acme.test/notes.txt": "text/plain" }));
  const read = JSON.parse(readFileSync(join(job, "out", "site-read.json"), "utf8"));
  assert.equal(read.pages.some((p) => p.url.endsWith("/notes.txt")), false);
  assert.equal(read.pages.length, 4);
});

test("an address that answers with neither a web page nor plain text still refuses", async () => {
  const job = jobWith("url: https://acme.test/logo.png");
  const r = await run(["--job", job, "--text-file", join(job, "message.txt")], fakeFetch([], { "https://acme.test/logo.png": "\u0089PNG" }, { "https://acme.test/logo.png": "image/png" }));
  assert.match(r.reply, /^I cannot read https:\/\/acme\.test\/logo\.png: no page there could be read\..*neither a web page nor plain text/);
  assert.equal(classifyReply({ text: r.reply, files: [] }), "refused");
});

test("a site that names nothing: the name is its host, the line is blank, and the reply says so", async () => {
  const { r, subject } = await readWith(BARE, "url: https://www.quiet.test/");
  assert.deepEqual(subject, { name: "quiet.test", one_line: "", url: "https://www.quiet.test/" });
  assert.equal(r.reply, "Read 1 page from www.quiet.test. Nothing on the site names the company, so I named it by its address, quiet.test. Nothing on the site describes it in a line, so the line is blank.");
});
