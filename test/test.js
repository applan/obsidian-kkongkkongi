/*
 * 꽁꽁이 테스트 — 빌드 없이 main.js 를 그대로 로드해 검증한다.
 *   실행: node test/test.js   (플러그인 폴더에서)
 *
 *   obsidian 모듈과 DOM 은 최소한으로 흉내 낸다.
 *   검증 대상: 암호화 / 파일 포맷 / 잠금·해제·재잠금 상태 전이 / 캐릭터
 */

const Module = require("module");
const fs = require("fs");
const pathmod = require("path");

const MAIN = pathmod.join(__dirname, "..", "main.js");

// ── 가짜 DOM ──────────────────────────────────────────────────────────────

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

global.document = {
  createElementNS(ns, tag) {
    const el = mkEl(tag);
    el.ns = ns;
    return el;
  },
};

global.window = {
  setTimeout: function () { return setTimeout.apply(null, arguments); },
  clearTimeout: function () { return clearTimeout.apply(null, arguments); },
  addEventListener() {},
};

const walk = (el, out) => {
  out = out || [];
  out.push(el);
  el.children.forEach((c) => walk(c, out));
  return out;
};
const byClass = (el, cls) => walk(el).find((e) => e.classes.has(cls));
const byBtn = (el, t) => walk(el).find((e) => e.tag === "button" && e.text === t);
const allText = (el) => walk(el).map((e) => e.text).join("\n");
const click = (el) => (el.listeners.click || []).forEach((f) => f());
/** host 안 SVG 도형들의 class 속성 목록 */
const shapes = (host) => {
  const svg = walk(host).find((e) => e.tag === "svg");
  return svg ? svg.children.map((c) => c.attrs.class) : [];
};
const hasShape = (host, cls) => shapes(host).some((c) => c && c.split(" ").includes(cls));

// ── obsidian 스텁 ─────────────────────────────────────────────────────────

class Empty { constructor() {} }
const langs = [], cmds = [], rendered = [];
const stub = {
  Plugin: class {
    async loadData() { return null; }
    async saveData() {}
    registerMarkdownCodeBlockProcessor(lang, h) { langs.push(lang); stub.handler = h; }
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
src += "\nmodule.exports.__t = { encrypt, decrypt, wrap, unwrap, drawChar, CHAR_LOCKED, CHAR_OPEN, CHAR_WRONG };\n";
const mod = new Module(MAIN);
mod.paths = Module._nodeModulePaths(pathmod.dirname(MAIN));
mod._compile(src, MAIN);
const Kkong = mod.exports;
const T = Kkong.__t;

// ── 러너 ──────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const PLAIN = "## 계정 정보\n\n비밀번호: p@ss워드!#$\n이모지 🥳🎉\n";
  const PW = "correct horse battery";
  const SECRET = "p@ss워드";

  console.log("\n[ 암호화 ]");
  const enc = T.encrypt(PLAIN, PW);
  ok("암호화 → 복호화 왕복", T.decrypt(enc, PW) === PLAIN);
  let threw = false;
  try { T.decrypt(enc, PW + "x"); } catch (e) { threw = true; }
  ok("틀린 암호는 예외", threw);
  const tampered = JSON.parse(enc);
  const buf = Buffer.from(tampered.data, "base64");
  buf[0] ^= 0xff;
  tampered.data = buf.toString("base64");
  threw = false;
  try { T.decrypt(JSON.stringify(tampered), PW); } catch (e) { threw = true; }
  ok("변조 감지 (GCM 인증 태그)", threw);
  ok("salt 매회 랜덤",
     JSON.parse(T.encrypt(PLAIN, PW)).salt !== JSON.parse(T.encrypt(PLAIN, PW)).salt);
  ok("IV 매회 랜덤",
     JSON.parse(T.encrypt(PLAIN, PW)).iv !== JSON.parse(T.encrypt(PLAIN, PW)).iv);
  const big = PLAIN.repeat(400);
  ok("큰 노트 왕복 (" + Math.round(Buffer.byteLength(big) / 1024) + "KB)",
     T.decrypt(T.encrypt(big, PW), PW) === big);

  console.log("\n[ 파일 포맷 ]");
  ok("wrap / unwrap 왕복", T.unwrap(T.wrap(enc)) === enc);
  ok("wrap 에 평문 없음", !T.wrap(enc).includes(SECRET));
  ok("kkong-v1 펜스 사용", T.wrap(enc).startsWith("```kkong-v1"));
  ok("예전 note-lock-v1 블록도 인식",
     T.unwrap("```note-lock-v1\n" + enc + "\n```") === enc);
  ok("일반 노트 → null", T.unwrap("# 그냥 노트") === null);
  ok("빈 문자열 → null", T.unwrap("") === null);

  console.log("\n[ 등록 ]");
  const plugin = new Kkong();
  plugin.app = {
    workspace: { on: () => ({}), getActiveFile: () => null },
    vault: { getAbstractFileByPath: () => ({ basename: "테스트" }) },
  };
  await plugin.onload();
  ok("코드블록 프로세서 2종",
     langs.indexOf("kkong-v1") >= 0 && langs.indexOf("note-lock-v1") >= 0, langs.join(", "));
  ok("명령 3개", cmds.length === 3, cmds.map((c) => c.id).join(", "));

  console.log("\n[ 잠금 → 해제 → 재잠금 ]");
  const el = mkEl("div");
  stub.handler(enc, el, { sourcePath: "t.md" });
  const e1 = Array.from(plugin.blocks)[0];
  ok("초기 상태는 잠김", e1.locked === true);
  ok("암호 입력창이 password 타입",
     (byClass(el, "kk-input") || { attrs: {} }).attrs.type === "password");
  ok("[열기] 버튼 존재", !!byBtn(el, "열기"));
  ok("잠긴 화면에 평문 없음", !allText(el).includes(SECRET));

  byClass(el, "kk-input").value = "wrong";
  click(byBtn(el, "열기"));
  await sleep(10);
  ok("틀린 암호 → 잠금 유지", e1.locked === true);
  ok("틀린 암호 → 안내 문구", byClass(el, "kk-msg").text.indexOf("달라요") >= 0);
  ok("틀린 암호 → 평문 노출 없음", !allText(el).includes(SECRET));

  byClass(el, "kk-input").value = PW;
  click(byBtn(el, "열기"));
  await sleep(20);
  ok("맞는 암호 → 해제", e1.locked === false);
  ok("내용이 인라인 렌더됨", rendered.indexOf(PLAIN) >= 0);
  ok("[다시 꽁꽁] 버튼", !!byBtn(el, "다시 꽁꽁"));
  ok("[편집] 버튼", !!byBtn(el, "편집"));
  ok("입력창 사라짐", !byClass(el, "kk-input"));

  plugin.relockAll();
  ok("이동 시 다시 잠김", e1.locked === true);
  ok("재잠금 후 암호 메모리에서 삭제", e1.pw === null);
  ok("재잠금 후 평문 노출 없음", !allText(el).includes(SECRET));
  ok("재잠금 후 입력창 복귀", !!byClass(el, "kk-input"));

  el.isConnected = false;
  plugin.relockAll();
  ok("떨어진 블록 정리", plugin.blocks.size === 0);

  console.log("\n[ 자동 잠금 타이머 ]");
  const el2 = mkEl("div");
  plugin.settings.relockSeconds = 1;
  stub.handler(enc, el2, { sourcePath: "t.md" });
  const e2 = Array.from(plugin.blocks)[0];
  byClass(el2, "kk-input").value = PW;
  click(byBtn(el2, "열기"));
  await sleep(20);
  ok("해제됨", e2.locked === false);
  ok("남은 시간 안내", byClass(el2, "kk-bar-text").text.indexOf("1초") >= 0);
  await sleep(1200);
  ok("시간 경과 후 자동 재잠금", e2.locked === true);
  el2.isConnected = false;
  plugin.relockAll();

  console.log("\n[ 꽁꽁이 캐릭터 ]");
  const el3 = mkEl("div");
  plugin.settings.relockSeconds = 0;
  plugin.settings.showCharacter = true;
  stub.handler(enc, el3, { sourcePath: "t.md" });
  const e3 = Array.from(plugin.blocks)[0];
  const host = byClass(el3, "kk-char-host");
  ok("잠김: 캐릭터 등장", !!host && shapes(host).length > 0, shapes(host).length + "개 도형");
  ok("잠김: 자물쇠를 안고 있음",
     hasShape(host, "kk-shackle") && hasShape(host, "kk-keyhole"));
  ok("잠김: 눈 감은 얼굴", hasShape(host, "kk-line") && !hasShape(host, "kk-eye"));
  ok("잠김: 볼터치", hasShape(host, "kk-blush"));

  byClass(el3, "kk-input").value = "wrong";
  click(byBtn(el3, "열기"));
  await sleep(10);
  ok("틀림: 놀란 얼굴", hasShape(host, "kk-mouth-o"));
  ok("틀림: 흔들림 애니메이션", host.classes.has("kk-shake"));
  await sleep(1300);
  ok("틀림: 잠시 뒤 원래 얼굴 복귀",
     !host.classes.has("kk-shake") && !hasShape(host, "kk-mouth-o"));

  byClass(el3, "kk-input").value = PW;
  click(byBtn(el3, "열기"));
  await sleep(20);
  const mini = byClass(el3, "kk-char-host--sm");
  ok("열림: 작은 캐릭터로 교체", !!mini);
  ok("열림: 눈 뜨고 반짝임", hasShape(mini, "kk-eye") && hasShape(mini, "kk-sparkle"));
  ok("열림: 자물쇠 열림 (열쇠구멍 없음)", !hasShape(mini, "kk-keyhole"));
  ok("열림: 등장 애니메이션", mini.classes.has("kk-pop"));

  plugin.settings.showCharacter = false;
  plugin.renderLocked(e3);
  ok("설정 끄면 캐릭터 미표시", !byClass(el3, "kk-char-host"));

  console.log("\n[ SVG 생성 ]");
  const specs = [["잠김", T.CHAR_LOCKED], ["열림", T.CHAR_OPEN], ["놀람", T.CHAR_WRONG]];
  for (const [name, spec] of specs) {
    const h = mkEl("div");
    const svg = T.drawChar(h, spec);
    ok(name + ": 도형 개수 일치", svg.children.length === spec.length, spec.length + "개");
    ok(name + ": viewBox 설정", svg.attrs.viewBox === "0 0 120 120");
    ok(name + ": 스크린리더에서 숨김", svg.attrs["aria-hidden"] === "true");
    const hardcoded = spec.some((it) =>
      String(it[1].fill || "").startsWith("#") || String(it[1].stroke || "").startsWith("#"));
    ok(name + ": 하드코딩 색상 없음 (테마 대응)", !hardcoded);
  }
  const h2 = mkEl("div");
  T.drawChar(h2, T.CHAR_OPEN, "kk-char--sm");
  ok("추가 클래스 반영", walk(h2).find((e) => e.tag === "svg").attrs.class === "kk-char kk-char--sm");

  console.log("\n  통과 " + pass + " / 실패 " + fail + "\n");
  process.exit(fail ? 1 : 0);
})();
