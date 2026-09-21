/*
 * Kkongkkongi (꽁꽁이) — encrypt a note and unlock it inline.
 *
 * How it works
 *   A locked note renders as a little character hugging a padlock.
 *   Enter the password and the content unfolds right there as markdown.
 *   Leaving the note (or the window) locks it again.
 *
 * Crypto         : AES-256-GCM (the auth tag also detects tampering)
 * Key derivation : scrypt (N=32768, r=8, p=1) — never uses the password as a key
 * salt / IV      : freshly generated on every lock, stored with the ciphertext
 *
 * Plaintext is never written to disk. Decrypted content lives only in the DOM
 * and is dropped from memory when the note locks again.
 *
 * NOTE: there is no password recovery. By design.
 */

const {
  Plugin, PluginSettingTab, Modal, Notice, Setting, MarkdownRenderer,
} = require("obsidian");
const crypto = require("crypto");

const BLOCK_TAG = "kkong-v1";
const LEGACY_TAG = "note-lock-v1";   // notes locked under the old plugin name
const MARKER = "```" + BLOCK_TAG;
const FENCE = "```";

// scrypt needs a generous maxmem for N=32768, otherwise it throws
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

const DEFAULT_SETTINGS = {
  language: "auto",      // auto | en | ko
  relockOnLeave: true,   // lock again when moving to another note
  relockOnBlur: true,    // lock again when the window loses focus
  relockSeconds: 0,      // 0 = no time limit
  showCharacter: true,
};

// ── i18n ──────────────────────────────────────────────────────────────────

const LOCALES = {
  en: {
    // inline — locked
    lockedTitle:      "Tucked away safely",
    passwordHint:     "Enter password",
    open:             "Open",
    wrongPassword:    "Hmm, that's not it",
    // inline — unlocked
    unlocked:         "Unlocked!",
    unlockedTimed:    "Unlocked! Locking again in {sec}s",
    edit:             "Edit",
    lockAgain:        "Lock again",
    // commands
    cmdLock:          "Lock this note",
    cmdUnlock:        "Remove lock permanently (back to plaintext)",
    cmdRelockAll:     "Lock everything that is open",
    // modals
    password:         "Password",
    passwordAgain:    "Confirm password",
    cancel:           "Cancel",
    confirm:          "OK",
    lockIt:           "Lock",
    removeLock:       "Remove",
    lockTitle:        "Lock this note",
    lockNote:         "{name} — a forgotten password cannot be recovered.",
    unlockTitle:      "Remove lock permanently",
    unlockNote:       "{name} — this writes the content back to the file as plaintext.",
    saveAndLock:      "Save and lock",
    // notices
    needPassword:     "Please enter a password",
    tooShort:         "Use at least 8 characters",
    mismatch:         "The two passwords do not match",
    noActiveNote:     "No note is open",
    alreadyLocked:    "This note is already locked",
    emptyNote:        "An empty note cannot be locked",
    locked:           "🔒 Locked",
    lockFailed:       "Could not lock: {msg}",
    notLocked:        "This note is not locked",
    badPassword:      "Wrong password, or the content is damaged",
    unlockedPlain:    "🔓 Lock removed (plaintext)",
    relockedAll:      "🔒 Locked everything again",
    fileNotFound:     "File not found",
    unlockFirst:      "Unlock it first",
    savedAndLocked:   "🔒 Saved and locked again",
    saveFailed:       "Could not save: {msg}",
    badFormat:        "Unsupported format (v{v})",
    // settings
    heroName:         "Kkongkkongi",
    heroDesc:         "Keeps your notes tucked away",
    setLanguage:      "Language",
    setLanguageDesc:  "Reload Obsidian for command names to update.",
    langAuto:         "Follow Obsidian",
    setCharacter:     "Show the character",
    setCharacterDesc: "Turn off for a plain password box.",
    setLeave:         "Lock when leaving the note",
    setLeaveDesc:     "Keeps unlocked content off the screen.",
    setBlur:          "Lock when the window loses focus",
    setBlurDesc:      "Locks when you switch to another app.",
    setSeconds:       "Auto-lock after (seconds)",
    setSecondsDesc:   "Lock again this long after unlocking. 0 disables it.",
    warnLabel:        "Warning: ",
    warnBody:         "A forgotten password cannot be recovered. "
                    + "Back up important notes before locking them.",
    tip:              "Locked content unfolds in Reading view and Live Preview. "
                    + "Source mode shows the ciphertext, which is expected.",
  },
  ko: {
    lockedTitle:      "꽁꽁 숨겨뒀어요",
    passwordHint:     "암호를 알려주세요",
    open:             "열기",
    wrongPassword:    "앗, 암호가 달라요",
    unlocked:         "열었어요!",
    unlockedTimed:    "열었어요! {sec}초 뒤에 다시 꽁꽁할게요",
    edit:             "편집",
    lockAgain:        "다시 꽁꽁",
    cmdLock:          "이 노트 꽁꽁 잠그기",
    cmdUnlock:        "이 노트 잠금 영구 해제 (평문으로 되돌리기)",
    cmdRelockAll:     "열려 있는 것 모두 다시 꽁꽁",
    password:         "암호",
    passwordAgain:    "암호 확인",
    cancel:           "취소",
    confirm:          "확인",
    lockIt:           "꽁꽁",
    removeLock:       "해제",
    lockTitle:        "꽁꽁 잠그기",
    lockNote:         "{name} — 암호를 잊으면 복구할 수 없습니다.",
    unlockTitle:      "잠금 영구 해제",
    unlockNote:       "{name} — 평문으로 되돌립니다. 파일에 내용이 그대로 저장됩니다.",
    saveAndLock:      "저장하고 다시 꽁꽁",
    needPassword:     "암호를 입력하세요",
    tooShort:         "암호는 8자 이상으로 해주세요",
    mismatch:         "두 암호가 다릅니다",
    noActiveNote:     "열린 노트가 없습니다",
    alreadyLocked:    "이미 꽁꽁 잠긴 노트예요",
    emptyNote:        "빈 노트는 잠글 수 없습니다",
    locked:           "🔒 꽁꽁 잠갔어요",
    lockFailed:       "잠그기 실패: {msg}",
    notLocked:        "꽁꽁 잠긴 노트가 아니에요",
    badPassword:      "암호가 틀렸거나 내용이 손상됐습니다",
    unlockedPlain:    "🔓 잠금을 해제했어요 (평문)",
    relockedAll:      "🔒 모두 다시 꽁꽁 잠갔어요",
    fileNotFound:     "파일을 찾을 수 없습니다",
    unlockFirst:      "먼저 암호를 입력해 잠금을 해제하세요",
    savedAndLocked:   "🔒 저장하고 다시 꽁꽁 잠갔어요",
    saveFailed:       "저장 실패: {msg}",
    badFormat:        "지원하지 않는 형식입니다 (v{v})",
    heroName:         "꽁꽁이",
    heroDesc:         "노트를 꽁꽁 숨겨드려요",
    setLanguage:      "언어",
    setLanguageDesc:  "명령 이름까지 바뀌려면 옵시디언을 다시 시작하세요.",
    langAuto:         "옵시디언 설정 따르기",
    setCharacter:     "꽁꽁이 보여주기",
    setCharacterDesc: "끄면 캐릭터 없이 암호 입력창만 나옵니다.",
    setLeave:         "다른 노트로 가면 다시 꽁꽁",
    setLeaveDesc:     "풀어놓은 내용이 화면에 남지 않게 합니다.",
    setBlur:          "창을 벗어나면 다시 꽁꽁",
    setBlurDesc:      "다른 프로그램으로 전환할 때 잠급니다.",
    setSeconds:       "자동 잠금 시간 (초)",
    setSecondsDesc:   "푼 뒤 이 시간이 지나면 다시 잠급니다. 0 이면 시간 제한 없음.",
    warnLabel:        "주의: ",
    warnBody:         "암호를 잊으면 복구할 수 없습니다. "
                    + "중요한 노트는 잠그기 전에 백업하세요.",
    tip:              "잠긴 내용은 읽기 뷰와 라이브 프리뷰에서 펼쳐집니다. "
                    + "소스 모드에서는 암호문이 그대로 보입니다 (정상 동작).",
  },
};

let CURRENT_LANG = "en";

/** Read Obsidian's UI language; anything we don't ship falls back to English. */
function detectLang() {
  try {
    const v = window.localStorage.getItem("language");
    const code = String(v || "").slice(0, 2);
    if (LOCALES[code]) return code;
  } catch (e) { /* localStorage may be unavailable */ }
  return "en";
}

function setLang(pref) {
  CURRENT_LANG = pref && pref !== "auto" && LOCALES[pref] ? pref : detectLang();
  return CURRENT_LANG;
}

/** Translate. Unknown keys fall back to English, then to the key itself. */
function t(key, vars) {
  const table = LOCALES[CURRENT_LANG] || LOCALES.en;
  let s = table[key];
  if (s === undefined) s = LOCALES.en[key];
  if (s === undefined) return key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
  }
  return s;
}

// ── character ─────────────────────────────────────────────────────────────
//   Drawn with the DOM API rather than innerHTML (plugin review guideline).
//   Colors come from CSS variables so light and dark themes both work.

const SVG_NS = "http://www.w3.org/2000/svg";

// shared across all three faces — ears, body, blush
const PART_BODY = [
  ["path",    { class: "kk-body",  d: "M35 46 L31 24 L52 37 Z" }],
  ["path",    { class: "kk-body",  d: "M85 46 L89 24 L68 37 Z" }],
  ["ellipse", { class: "kk-body",  cx: 60, cy: 66, rx: 36, ry: 34 }],
  ["ellipse", { class: "kk-blush", cx: 36, cy: 70, rx: 6.5, ry: 4 }],
  ["ellipse", { class: "kk-blush", cx: 84, cy: 70, rx: 6.5, ry: 4 }],
];

// the two little arms hugging the padlock
const PART_ARMS = [
  ["ellipse", { class: "kk-body", cx: 38, cy: 92, rx: 10, ry: 7.5, transform: "rotate(-22 38 92)" }],
  ["ellipse", { class: "kk-body", cx: 82, cy: 92, rx: 10, ry: 7.5, transform: "rotate(22 82 92)" }],
];

// closed padlock — shackle, body, keyhole
const PART_LOCK_SHUT = [
  ["path",   { class: "kk-shackle", d: "M52 90 v-9 a8 8 0 0 1 16 0 v9" }],
  ["rect",   { class: "kk-lock", x: 45, y: 88, width: 30, height: 24, rx: 6 }],
  ["circle", { class: "kk-keyhole", cx: 60, cy: 97, r: 3.2 }],
  ["path",   { class: "kk-keyhole-stem", d: "M60 99 v6" }],
];

/** eyes shut, hugging the padlock */
const CHAR_LOCKED = [
  ...PART_BODY,
  ["path", { class: "kk-line", d: "M43 60 q6 -7 12 0" }],
  ["path", { class: "kk-line", d: "M65 60 q6 -7 12 0" }],
  ["path", { class: "kk-line kk-mouth", d: "M55 74 q5 5 10 0" }],
  ...PART_ARMS,
  ...PART_LOCK_SHUT,
];

/** padlock open, delighted */
const CHAR_OPEN = [
  ...PART_BODY,
  ["circle", { class: "kk-eye", cx: 49, cy: 60, r: 5 }],
  ["circle", { class: "kk-eye", cx: 71, cy: 60, r: 5 }],
  ["circle", { class: "kk-glint", cx: 50.8, cy: 58.2, r: 1.8 }],
  ["circle", { class: "kk-glint", cx: 72.8, cy: 58.2, r: 1.8 }],
  ["path",   { class: "kk-line kk-mouth", d: "M53 74 q7 7 14 0" }],
  ...PART_ARMS,
  ["path", { class: "kk-shackle", d: "M52 90 v-9 a8 8 0 0 1 16 0 v4", transform: "rotate(-32 52 84)" }],
  ["rect", { class: "kk-lock", x: 45, y: 88, width: 30, height: 24, rx: 6 }],
  ["path", { class: "kk-sparkle", d: "M96 34 l2.4 6 6 2.4 -6 2.4 -2.4 6 -2.4 -6 -6 -2.4 6 -2.4 Z" }],
];

/** startled by a wrong password */
const CHAR_WRONG = [
  ...PART_BODY,
  ["path",    { class: "kk-line", d: "M44 56 l10 8 M54 56 l-10 8" }],
  ["path",    { class: "kk-line", d: "M66 56 l10 8 M76 56 l-10 8" }],
  ["ellipse", { class: "kk-line kk-mouth-o", cx: 60, cy: 76, rx: 4, ry: 5 }],
  ...PART_ARMS,
  ...PART_LOCK_SHUT,
];

/** Build the SVG from a spec array and put it in host (clearing it first). */
function drawChar(host, spec, extraClass) {
  host.empty();
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", extraClass ? "kk-char " + extraClass : "kk-char");
  svg.setAttribute("viewBox", "0 0 120 120");
  svg.setAttribute("aria-hidden", "true");
  for (const item of spec) {
    const node = document.createElementNS(SVG_NS, item[0]);
    const attrs = item[1];
    for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
    svg.appendChild(node);
  }
  host.appendChild(svg);
  return svg;
}

// ── crypto ────────────────────────────────────────────────────────────────

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32, SCRYPT);
}

function encrypt(plain, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}

function decrypt(payloadJson, password) {
  const p = JSON.parse(payloadJson);
  if (p.v !== 1) throw new Error(t("badFormat", { v: p.v }));
  const key = deriveKey(password, Buffer.from(p.salt, "base64"));
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm", key, Buffer.from(p.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(p.tag, "base64"));
  // A wrong password fails the auth tag check here and throws.
  const out = Buffer.concat([
    decipher.update(Buffer.from(p.data, "base64")),
    decipher.final(),
  ]);
  return out.toString("utf8");
}

// ── file format ───────────────────────────────────────────────────────────

function wrap(payloadJson) {
  return [MARKER, payloadJson, FENCE, ""].join("\n");
}

/** Returns the payload JSON for a locked note, otherwise null. */
function unwrap(content) {
  for (const tag of [BLOCK_TAG, LEGACY_TAG]) {
    const marker = "```" + tag;
    const i = content.indexOf(marker);
    if (i === -1) continue;
    const start = i + marker.length;
    const end = content.indexOf(FENCE, start);
    if (end === -1) continue;
    const payload = content.slice(start, end).trim();
    if (payload.length) return payload;
  }
  return null;
}

// ── markdown rendering (absorbs API differences across versions) ──────────

async function renderMarkdown(app, md, el, sourcePath, component) {
  if (typeof MarkdownRenderer.render === "function") {
    await MarkdownRenderer.render(app, md, el, sourcePath, component);
  } else {
    await MarkdownRenderer.renderMarkdown(md, el, sourcePath, component);
  }
}

// ── modals ────────────────────────────────────────────────────────────────

/** Password prompt. confirm=true also asks for a second entry (when locking). */
class PasswordModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.heading = opts.title;
    this.note = opts.note;
    this.confirm = opts.confirm !== false;
    this.cta = opts.cta || t("confirm");
    this.onSubmit = opts.onSubmit;
    this.pw = "";
    this.pw2 = "";
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("kk-modal");
    contentEl.createEl("h3", { text: this.heading });
    if (this.note) contentEl.createEl("p", { cls: "kk-modal-note", text: this.note });

    const submit = () => {
      if (!this.pw) return new Notice(t("needPassword"));
      if (this.confirm) {
        if (this.pw.length < 8) return new Notice(t("tooShort"));
        if (this.pw !== this.pw2) return new Notice(t("mismatch"));
      }
      this.done = true;
      const pw = this.pw;
      this.close();
      this.onSubmit(pw);
    };

    const mkInput = (label, key, focus) => {
      new Setting(contentEl).setName(label).addText((input) => {
        input.inputEl.type = "password";
        input.onChange((v) => { this[key] = v; });
        input.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
        });
        if (focus) window.setTimeout(() => input.inputEl.focus(), 0);
      });
    };

    mkInput(t("password"), "pw", true);
    if (this.confirm) mkInput(t("passwordAgain"), "pw2", false);

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.cta).setCta().onClick(submit));
  }

  onClose() {
    this.contentEl.empty();
    this.pw = "";
    this.pw2 = "";
    if (!this.done) this.onSubmit(null);
  }
}

/** Edit the decrypted text, then re-encrypt with the same password on save. */
class EditModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.heading = opts.title;
    this.text = opts.text;
    this.onSave = opts.onSave;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("kk-edit-modal");
    contentEl.createEl("h3", { text: "🔓 " + this.heading });

    const ta = contentEl.createEl("textarea", { cls: "kk-edit", text: this.text });
    ta.spellcheck = false;

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText(t("saveAndLock")).setCta().onClick(async () => {
          const v = ta.value;
          this.close();
          await this.onSave(v);
        })
      );
  }

  onClose() {
    this.contentEl.empty();
    this.text = "";
  }
}

// ── settings tab ──────────────────────────────────────────────────────────

class KkongSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const hero = containerEl.createDiv({ cls: "kk-hero" });
    drawChar(hero.createDiv({ cls: "kk-char-host" }), CHAR_LOCKED);
    hero.createDiv({ cls: "kk-hero-name", text: t("heroName") });
    hero.createDiv({ cls: "kk-hero-desc", text: t("heroDesc") });

    new Setting(containerEl)
      .setName(t("setLanguage"))
      .setDesc(t("setLanguageDesc"))
      .addDropdown((d) => {
        d.addOption("auto", t("langAuto"));
        d.addOption("en", "English");
        d.addOption("ko", "한국어");
        d.setValue(this.plugin.settings.language);
        d.onChange(async (v) => {
          this.plugin.settings.language = v;
          await this.plugin.saveSettings();
          setLang(v);
          this.plugin.relockAll();   // redraw open blocks in the new language
          this.display();            // and this tab too
        });
      });

    new Setting(containerEl)
      .setName(t("setCharacter"))
      .setDesc(t("setCharacterDesc"))
      .addToggle((x) =>
        x.setValue(this.plugin.settings.showCharacter).onChange(async (v) => {
          this.plugin.settings.showCharacter = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("setLeave"))
      .setDesc(t("setLeaveDesc"))
      .addToggle((x) =>
        x.setValue(this.plugin.settings.relockOnLeave).onChange(async (v) => {
          this.plugin.settings.relockOnLeave = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("setBlur"))
      .setDesc(t("setBlurDesc"))
      .addToggle((x) =>
        x.setValue(this.plugin.settings.relockOnBlur).onChange(async (v) => {
          this.plugin.settings.relockOnBlur = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("setSeconds"))
      .setDesc(t("setSecondsDesc"))
      .addText((x) =>
        x
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.relockSeconds))
          .onChange(async (v) => {
            const n = Number(v);
            this.plugin.settings.relockSeconds =
              Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
            await this.plugin.saveSettings();
          })
      );

    const warn = containerEl.createEl("p", { cls: "kk-warn" });
    warn.createEl("strong", { text: t("warnLabel") });
    warn.appendText(t("warnBody"));

    containerEl.createEl("p", { cls: "kk-tip", text: t("tip") });
  }
}

// ── plugin ────────────────────────────────────────────────────────────────

module.exports = class KkongkkongiPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    setLang(this.settings.language);

    // blocks currently rendered on screen — iterated when locking again
    this.blocks = new Set();

    const handler = (source, el, ctx) => {
      const entry = {
        el,
        payload: source.trim(),
        sourcePath: ctx.sourcePath,
        locked: true,
        pw: null,
        timer: null,
      };
      this.blocks.add(entry);
      this.renderLocked(entry);
    };

    this.registerMarkdownCodeBlockProcessor(BLOCK_TAG, handler);
    this.registerMarkdownCodeBlockProcessor(LEGACY_TAG, handler);

    this.addCommand({ id: "lock-note", name: t("cmdLock"), callback: () => this.lockActive() });
    this.addCommand({ id: "unlock-note", name: t("cmdUnlock"), callback: () => this.unlockActive() });
    this.addCommand({
      id: "relock-all",
      name: t("cmdRelockAll"),
      callback: () => { this.relockAll(); new Notice(t("relockedAll")); },
    });

    this.addSettingTab(new KkongSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      if (this.settings.relockOnLeave) this.relockAll();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      if (this.settings.relockOnLeave) this.relockAll();
    }));
    this.registerDomEvent(window, "blur", () => {
      if (this.settings.relockOnBlur) this.relockAll();
    });
  }

  onunload() {
    this.relockAll();
    if (this.blocks) this.blocks.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── inline rendering ──

  /** Locked — the character waits for a password. */
  renderLocked(entry) {
    this.clearTimer(entry);
    entry.locked = true;
    entry.pw = null;

    const el = entry.el;
    el.empty();
    el.addClass("kk");

    const box = el.createDiv({ cls: "kk-box" });

    let charHost = null;
    if (this.settings.showCharacter) {
      charHost = box.createDiv({ cls: "kk-char-host" });
      drawChar(charHost, CHAR_LOCKED);
    }

    box.createDiv({ cls: "kk-title", text: t("lockedTitle") });

    const row = box.createDiv({ cls: "kk-row" });
    const input = row.createEl("input", {
      cls: "kk-input",
      attr: { type: "password", placeholder: t("passwordHint") },
    });
    const btn = row.createEl("button", { cls: "kk-btn kk-btn--cta", text: t("open") });
    const msg = box.createDiv({ cls: "kk-msg" });

    const startle = () => {
      if (!charHost) return;
      drawChar(charHost, CHAR_WRONG);
      charHost.addClass("kk-shake");
      window.setTimeout(() => {
        if (!entry.locked || !charHost.isConnected) return;
        charHost.removeClass("kk-shake");
        drawChar(charHost, CHAR_LOCKED);
      }, 1200);
    };

    const go = () => {
      if (!input.value) return;
      let text;
      try {
        text = decrypt(entry.payload, input.value);
      } catch (e) {
        msg.setText(t("wrongPassword"));
        startle();
        input.select();
        return;
      }
      const pw = input.value;
      input.value = "";
      this.renderUnlocked(entry, text, pw);
    };

    btn.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });
  }

  /** Unlocked — content unfolds right here as markdown. */
  async renderUnlocked(entry, text, pw) {
    entry.locked = false;
    entry.pw = pw;

    const el = entry.el;
    el.empty();
    el.addClass("kk");

    const bar = el.createDiv({ cls: "kk-bar" });

    if (this.settings.showCharacter) {
      const mini = bar.createDiv({ cls: "kk-char-host kk-char-host--sm kk-pop" });
      drawChar(mini, CHAR_OPEN, "kk-char--sm");
    }

    const sec = this.settings.relockSeconds;
    bar.createSpan({
      cls: "kk-bar-text",
      text: sec > 0 ? t("unlockedTimed", { sec: sec }) : t("unlocked"),
    });

    const actions = bar.createDiv({ cls: "kk-actions" });
    actions
      .createEl("button", { cls: "kk-btn", text: t("edit") })
      .addEventListener("click", () => this.editEntry(entry, text));
    actions
      .createEl("button", { cls: "kk-btn", text: t("lockAgain") })
      .addEventListener("click", () => this.renderLocked(entry));

    const body = el.createDiv({ cls: "kk-content" });
    await renderMarkdown(this.app, text, body, entry.sourcePath, this);

    if (sec > 0) {
      entry.timer = window.setTimeout(() => this.renderLocked(entry), sec * 1000);
    }
  }

  clearTimer(entry) {
    if (entry.timer) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /** Lock every unlocked block again, dropping ones no longer on screen. */
  relockAll() {
    if (!this.blocks) return;
    for (const entry of Array.from(this.blocks)) {
      if (!entry.el || !entry.el.isConnected) {
        this.clearTimer(entry);
        this.blocks.delete(entry);
        continue;
      }
      if (!entry.locked) this.renderLocked(entry);
    }
  }

  // ── editing ──

  editEntry(entry, text) {
    const file = this.app.vault.getAbstractFileByPath(entry.sourcePath);
    if (!file) return new Notice(t("fileNotFound"));
    const pw = entry.pw;
    if (!pw) return new Notice(t("unlockFirst"));

    new EditModal(this.app, {
      title: file.basename,
      text: text,
      onSave: async (newText) => {
        if (newText === text) return this.renderLocked(entry);
        try {
          await this.app.vault.modify(file, wrap(encrypt(newText, pw)));
          new Notice(t("savedAndLocked"));
        } catch (e) {
          new Notice(t("saveFailed", { msg: e.message }));
        }
      },
    }).open();
  }

  // ── commands ──

  activeFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice(t("noActiveNote"));
      return null;
    }
    return file;
  }

  async lockActive() {
    const file = this.activeFile();
    if (!file) return;

    const content = await this.app.vault.read(file);
    if (unwrap(content)) return new Notice(t("alreadyLocked"));
    if (!content.trim()) return new Notice(t("emptyNote"));

    new PasswordModal(this.app, {
      title: t("lockTitle"),
      note: t("lockNote", { name: file.basename }),
      confirm: true,
      cta: t("lockIt"),
      onSubmit: async (pw) => {
        if (!pw) return;
        try {
          await this.app.vault.modify(file, wrap(encrypt(content, pw)));
          new Notice(t("locked"));
        } catch (e) {
          new Notice(t("lockFailed", { msg: e.message }));
        }
      },
    }).open();
  }

  async unlockActive() {
    const file = this.activeFile();
    if (!file) return;

    const content = await this.app.vault.read(file);
    const payload = unwrap(content);
    if (!payload) return new Notice(t("notLocked"));

    new PasswordModal(this.app, {
      title: t("unlockTitle"),
      note: t("unlockNote", { name: file.basename }),
      confirm: false,
      cta: t("removeLock"),
      onSubmit: async (pw) => {
        if (!pw) return;
        let text;
        try {
          text = decrypt(payload, pw);
        } catch (e) {
          return new Notice(t("badPassword"));
        }
        await this.app.vault.modify(file, text);
        new Notice(t("unlockedPlain"));
      },
    }).open();
  }
};
