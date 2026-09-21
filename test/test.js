/*
 * Kkongkkongi tests — loads main.js as-is, no build step.
 *   run: node test/test.js   (from the plugin folder)
 *
 * The obsidian module and the DOM are stubbed just enough to exercise
 * crypto, file format, lock/unlock/relock transitions, the character and i18n.
 */

const Module = require("module");
const fs = require("fs");
const pathmod = require("path");

const MAIN = pathmod.join(__dirname, "..", "main.js");

// ── fake DOM ──────────────────────────────────────────────────────────────

function mkEl(tag) {
  return {
    tag, children: [], classes: new Set(), attrs: {}, text: "", value: "",
    isConnected: true, listeners: {}, spellcheck: false, style: {},
    empty() { this.children = []; this.text = ""; return this; },
    addClass(c) { this.classes.add(c); return this; },
    removeClass(c) { this.classes.delete(c); return this; },
    setText(t) { this.text = t; return this; },
    appendText(t) { this.text += t; return this; },
    setAttribute(k, v) { this.attrs[k] = String(v); return this; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    select() {}, focus() {},
    createEl(t, o) {
      o = o || {};
      const c = mkEl(t);
      if (o.cls) String(o.cls).split(" ").forEach((x) => c.classes.add(x));
      if (o.text) c.text = o.text;
      if (o.attr) Object.assign(c.attrs, o.attr);
      if (o.type) c.attrs.type = o.type;
      this.children.push(c);
      return c;
    },
    createDiv(o) { return this.createEl("div", o); },
    createSpan(o) { return this.createEl("span", o); },
  };
}

let STORED_LANGUAGE = "";                 // what Obsidian would have in localStorage

global.document = {
  createElementNS(ns, tag) { const el = mkEl(tag); el.ns = ns; return el; },
};

global.window = {
  setTimeout: function () { return setTimeout.apply(null, arguments); },
  clearTimeout: function () { return clearTimeout.apply(null, arguments); },
  addEventListener() {},
  localStorage: { getItem(k) { return k === "language" ? STORED_LANGUAGE : null; } },
};

const walk = (el, out) => {
  out = out || [];
  out.push(el);
  el.children.forEach((c) => walk(c, out));
  return out;
};
const byClass = (el, cls) => walk(el).find((e) => e.classes.has(cls));
const byBtn = (el, label) => walk(el).find((e) => e.tag === "button" && e.text === label);
const allText = (el) => walk(el).map((e) => e.text).join("\n");
const click = (el) => (el.listeners.click || []).forEach((f) => f());
const shapes = (host) => {
  const svg = walk(host).find((e) => e.tag === "svg");
  return svg ? svg.children.map((c) => c.attrs.class) : [];
};
const hasShape = (host, cls) =>
  shapes(host).some((c) => c && c.split(" ").indexOf(cls) >= 0);

// ── obsidian stub ─────────────────────────────────────────────────────────

class Empty { constructor() {} }
const langs = [], cmds = [], rendered = [];
const stub = {
  Plugin: class {
    async loadData() { return null; }
    async saveData() {}
    registerMarkdownCodeBlockProcessor(tag, h) { langs.push(tag); stub.handler = h; }
    addCommand(c) { cmds.push(c); }
    addSettingTab() {} registerEvent() {} registerDomEvent() {}
  },
  PluginSettingTab: Empty, Modal: Empty, Setting: Empty,
  Notice: class { constructor(m) { stub.notice = m; } },
  MarkdownRenderer: { async render(app, md, el) { rendered.push(md); el.text = md; } },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === "obsidian") return stub;
  return origLoad.apply(this, arguments);
};

let src = fs.readFileSync(MAIN, "utf8");
src += "\nmodule.exports.__t = { encrypt, decrypt, wrap, unwrap, drawChar, setLang, detectLang, t,"
     + " LOCALES, CHAR_LOCKED, CHAR_OPEN, CHAR_WRONG };\n";
const mod = new Module(MAIN);
mod.paths = Module._nodeModulePaths(pathmod.dirname(MAIN));
mod._compile(src, MAIN);
const Kkong = mod.exports;
const T = Kkong.__t;
const L = T.LOCALES;

// ── runner ────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAIN = "## Account\n\npassword: p@ss워드!#$\nemoji 🥳🎉\n";
const PW = "correct horse battery";
const SECRET = "p@ss워드";

function newPlugin() {
  const p = new Kkong();
  p.app = {
    workspace: { on: () => ({}), getActiveFile: () => null },
    vault: { getAbstractFileByPath: () => ({ basename: "test" }) },
  };
  return p;
}

/** Run the whole lock/unlock/character flow in one language. */
async function uiSuite(lang, enc) {
  const s = L[lang];
  console.log("\n[ UI — " + lang + " ]");

  const plugin = newPlugin();
  await plugin.onload();
  T.setLang(lang);

  const el = mkEl("div");
  stub.handler(enc, el, { sourcePath: "t.md" });
  const entry = Array.from(plugin.blocks).pop();

  ok(lang + ": locked title", byClass(el, "kk-title").text === s.lockedTitle, s.lockedTitle);
  ok(lang + ": password placeholder",
     byClass(el, "kk-input").attrs.placeholder === s.passwordHint);
  ok(lang + ": open button", !!byBtn(el, s.open), s.open);
  ok(lang + ": no plaintext while locked", !allText(el).includes(SECRET));

  byClass(el, "kk-input").value = "wrong";
  click(byBtn(el, s.open));
  await sleep(10);
  ok(lang + ": wrong password message",
     byClass(el, "kk-msg").text === s.wrongPassword, s.wrongPassword);
  ok(lang + ": stays locked", entry.locked === true);

  byClass(el, "kk-input").value = PW;
  click(byBtn(el, s.open));
  await sleep(20);
  ok(lang + ": unlocked", entry.locked === false);
  ok(lang + ": unlocked banner", byClass(el, "kk-bar-text").text === s.unlocked, s.unlocked);
  ok(lang + ": edit button", !!byBtn(el, s.edit), s.edit);
  ok(lang + ": lock-again button", !!byBtn(el, s.lockAgain), s.lockAgain);
  ok(lang + ": content rendered", rendered.indexOf(PLAIN) >= 0);

  plugin.relockAll();
  ok(lang + ": relocked", entry.locked === true);
  ok(lang + ": password dropped from memory", entry.pw === null);
  ok(lang + ": no plaintext after relock", !allText(el).includes(SECRET));

  // timer message with interpolation
  plugin.settings.relockSeconds = 1;
  const el2 = mkEl("div");
  stub.handler(enc, el2, { sourcePath: "t.md" });
  const e2 = Array.from(plugin.blocks).pop();
  byClass(el2, "kk-input").value = PW;
  click(byBtn(el2, s.open));
  await sleep(20);
  ok(lang + ": timed banner interpolated",
     byClass(el2, "kk-bar-text").text === s.unlockedTimed.replace("{sec}", "1"),
     byClass(el2, "kk-bar-text").text);
  await sleep(1200);
  ok(lang + ": auto relock fired", e2.locked === true);

  el.isConnected = false;
  el2.isConnected = false;
  plugin.relockAll();
}

(async () => {
  T.setLang("en");

  console.log("\n[ crypto ]");
  const enc = T.encrypt(PLAIN, PW);
  ok("round trip", T.decrypt(enc, PW) === PLAIN);
  let threw = false;
  try { T.decrypt(enc, PW + "x"); } catch (e) { threw = true; }
  ok("wrong password throws", threw);
  const tampered = JSON.parse(enc);
  const buf = Buffer.from(tampered.data, "base64");
  buf[0] ^= 0xff;
  tampered.data = buf.toString("base64");
  threw = false;
  try { T.decrypt(JSON.stringify(tampered), PW); } catch (e) { threw = true; }
  ok("tampering detected (GCM auth tag)", threw);
  ok("fresh salt each time",
     JSON.parse(T.encrypt(PLAIN, PW)).salt !== JSON.parse(T.encrypt(PLAIN, PW)).salt);
  ok("fresh IV each time",
     JSON.parse(T.encrypt(PLAIN, PW)).iv !== JSON.parse(T.encrypt(PLAIN, PW)).iv);
  const big = PLAIN.repeat(400);
  ok("large note (" + Math.round(Buffer.byteLength(big) / 1024) + "KB)",
     T.decrypt(T.encrypt(big, PW), PW) === big);

  console.log("\n[ file format ]");
  ok("wrap / unwrap round trip", T.unwrap(T.wrap(enc)) === enc);
  ok("no plaintext in wrapped output", !T.wrap(enc).includes(SECRET));
  ok("kkong-v1 fence", T.wrap(enc).startsWith("```kkong-v1"));
  ok("legacy note-lock-v1 still readable",
     T.unwrap("```note-lock-v1\n" + enc + "\n```") === enc);
  ok("plain note -> null", T.unwrap("# just a note") === null);
  ok("empty string -> null", T.unwrap("") === null);

  console.log("\n[ i18n ]");
  const enKeys = Object.keys(L.en).sort();
  const koKeys = Object.keys(L.ko).sort();
  ok("en / ko key sets match", enKeys.join(",") === koKeys.join(","),
     enKeys.length + " keys");
  const emptyEn = enKeys.filter((k) => !String(L.en[k]).trim());
  const emptyKo = koKeys.filter((k) => !String(L.ko[k]).trim());
  ok("no empty strings", emptyEn.length === 0 && emptyKo.length === 0);
  const ph = (s) => (String(s).match(/\{[a-z]+\}/g) || []).sort().join(",");
  const badPh = enKeys.filter((k) => ph(L.en[k]) !== ph(L.ko[k]));
  ok("placeholders consistent across locales", badPh.length === 0, badPh.join(", "));

  STORED_LANGUAGE = "";     T.setLang("auto");
  ok("auto -> en when Obsidian is English", T.t("open") === L.en.open);
  STORED_LANGUAGE = "ko";   T.setLang("auto");
  ok("auto -> ko when Obsidian is Korean", T.t("open") === L.ko.open);
  STORED_LANGUAGE = "fr";   T.setLang("auto");
  ok("auto -> en for an unsupported language", T.t("open") === L.en.open);
  STORED_LANGUAGE = "ko";   T.setLang("en");
  ok("explicit en overrides Obsidian", T.t("open") === L.en.open);
  T.setLang("ko");
  ok("explicit ko overrides Obsidian", T.t("open") === L.ko.open);
  ok("unknown key falls back to the key itself", T.t("nope__") === "nope__");
  ok("interpolation", T.t("unlockedTimed", { sec: 7 }).indexOf("7") >= 0);
  STORED_LANGUAGE = "";

  console.log("\n[ registration ]");
  const p0 = newPlugin();
  await p0.onload();
  ok("two code block processors",
     langs.indexOf("kkong-v1") >= 0 && langs.indexOf("note-lock-v1") >= 0,
     Array.from(new Set(langs)).join(", "));
  ok("three commands", cmds.length === 3, cmds.map((c) => c.id).join(", "));

  await uiSuite("en", enc);
  await uiSuite("ko", enc);

  console.log("\n[ character ]");
  T.setLang("en");
  const plugin = newPlugin();
  await plugin.onload();
  plugin.settings.relockSeconds = 0;
  plugin.settings.showCharacter = true;
  const el3 = mkEl("div");
  stub.handler(enc, el3, { sourcePath: "t.md" });
  const e3 = Array.from(plugin.blocks).pop();
  const host = byClass(el3, "kk-char-host");
  ok("locked: character drawn", !!host && shapes(host).length > 0,
     shapes(host).length + " shapes");
  ok("locked: hugging a shut padlock",
     hasShape(host, "kk-shackle") && hasShape(host, "kk-keyhole"));
  ok("locked: eyes shut", hasShape(host, "kk-line") && !hasShape(host, "kk-eye"));
  ok("locked: blush", hasShape(host, "kk-blush"));

  byClass(el3, "kk-input").value = "wrong";
  click(byBtn(el3, L.en.open));
  await sleep(10);
  ok("wrong: startled face", hasShape(host, "kk-mouth-o"));
  ok("wrong: shake animation", host.classes.has("kk-shake"));
  await sleep(1300);
  ok("wrong: face restored",
     !host.classes.has("kk-shake") && !hasShape(host, "kk-mouth-o"));

  byClass(el3, "kk-input").value = PW;
  click(byBtn(el3, L.en.open));
  await sleep(20);
  const mini = byClass(el3, "kk-char-host--sm");
  ok("open: swapped to the small character", !!mini);
  ok("open: eyes open and sparkling",
     hasShape(mini, "kk-eye") && hasShape(mini, "kk-sparkle"));
  ok("open: padlock opened (no keyhole)", !hasShape(mini, "kk-keyhole"));
  ok("open: pop animation", mini.classes.has("kk-pop"));

  plugin.settings.showCharacter = false;
  plugin.renderLocked(e3);
  ok("character can be turned off", !byClass(el3, "kk-char-host"));

  console.log("\n[ svg ]");
  const specs = [["locked", T.CHAR_LOCKED], ["open", T.CHAR_OPEN], ["wrong", T.CHAR_WRONG]];
  for (const [name, spec] of specs) {
    const h = mkEl("div");
    const svg = T.drawChar(h, spec);
    ok(name + ": shape count", svg.children.length === spec.length, spec.length + "");
    ok(name + ": viewBox", svg.attrs.viewBox === "0 0 120 120");
    ok(name + ": aria-hidden", svg.attrs["aria-hidden"] === "true");
    const hardcoded = spec.some((it) =>
      String(it[1].fill || "").startsWith("#") || String(it[1].stroke || "").startsWith("#"));
    ok(name + ": no hardcoded colors (theme aware)", !hardcoded);
  }
  const h2 = mkEl("div");
  T.drawChar(h2, T.CHAR_OPEN, "kk-char--sm");
  ok("extra class applied",
     walk(h2).find((e) => e.tag === "svg").attrs.class === "kk-char kk-char--sm");

  console.log("\n  passed " + pass + " / failed " + fail + "\n");
  process.exit(fail ? 1 : 0);
})();
