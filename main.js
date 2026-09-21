/*
 * 꽁꽁이 (Kkongkkongi) — 노트를 꽁꽁 숨겨주는 옵시디언 플러그인
 *
 * 동작
 *   잠긴 블록 자리에 꽁꽁이가 자물쇠를 안고 나타난다.
 *   암호를 넣으면 자물쇠를 풀고, 그 자리에서 내용이 마크다운으로 펼쳐진다.
 *   다른 노트/화면으로 이동하면 다시 꽁꽁 잠근다.
 *
 * 암호화 : AES-256-GCM (인증 태그로 변조 감지까지 됨)
 * 키 유도 : scrypt (N=32768, r=8, p=1) — 비밀번호를 키로 바로 쓰지 않는다
 * salt/IV : 잠글 때마다 새로 랜덤 생성해 결과에 함께 저장
 *
 * 평문은 디스크에 절대 쓰지 않는다. 복호화 결과는 화면(DOM)에만 존재하고
 * 다시 잠글 때 메모리에서 지운다.
 *
 * ※ 비밀번호를 잊으면 복구 수단이 없다.
 */

const {
  Plugin, PluginSettingTab, Modal, Notice, Setting, MarkdownRenderer,
} = require("obsidian");
const crypto = require("crypto");

const LANG = "kkong-v1";
const LEGACY_LANG = "note-lock-v1";   // 예전 이름으로 잠근 노트도 열어준다
const MARKER = "```" + LANG;
const FENCE = "```";

// scrypt 파라미터 — maxmem 을 넉넉히 줘야 N=32768 에서 에러가 안 난다
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

const DEFAULT_SETTINGS = {
  relockOnLeave: true,   // 다른 노트/화면으로 이동하면 다시 잠근다
  relockOnBlur: true,    // 옵시디언 창에서 포커스가 나가면 다시 잠근다
  relockSeconds: 0,      // 0 이면 시간 제한 없음
  showCharacter: true,   // 꽁꽁이 캐릭터 표시
};

// ── 꽁꽁이 캐릭터 ─────────────────────────────────────────────────────────
//   innerHTML 을 쓰지 않고 DOM API 로 그린다 (커뮤니티 플러그인 심사 기준).
//   색은 CSS 변수로 빼서 라이트/다크 테마에 모두 맞춘다.

const SVG_NS = "http://www.w3.org/2000/svg";

// 세 표정이 공유하는 부분 — 귀 / 몸통 / 볼터치
const PART_BODY = [
  ["path",    { class: "kk-body",  d: "M35 46 L31 24 L52 37 Z" }],
  ["path",    { class: "kk-body",  d: "M85 46 L89 24 L68 37 Z" }],
  ["ellipse", { class: "kk-body",  cx: 60, cy: 66, rx: 36, ry: 34 }],
  ["ellipse", { class: "kk-blush", cx: 36, cy: 70, rx: 6.5, ry: 4 }],
  ["ellipse", { class: "kk-blush", cx: 84, cy: 70, rx: 6.5, ry: 4 }],
];

// 자물쇠를 안은 두 팔
const PART_ARMS = [
  ["ellipse", { class: "kk-body", cx: 38, cy: 92, rx: 10, ry: 7.5, transform: "rotate(-22 38 92)" }],
  ["ellipse", { class: "kk-body", cx: 82, cy: 92, rx: 10, ry: 7.5, transform: "rotate(22 82 92)" }],
];

// 잠긴 자물쇠 (고리 + 몸통 + 열쇠구멍)
const PART_LOCK_SHUT = [
  ["path",   { class: "kk-shackle", d: "M52 90 v-9 a8 8 0 0 1 16 0 v9" }],
  ["rect",   { class: "kk-lock", x: 45, y: 88, width: 30, height: 24, rx: 6 }],
  ["circle", { class: "kk-keyhole", cx: 60, cy: 97, r: 3.2 }],
  ["path",   { class: "kk-keyhole-stem", d: "M60 99 v6" }],
];

/** 자물쇠를 꼭 안고 눈을 감은 꽁꽁이 */
const CHAR_LOCKED = [
  ...PART_BODY,
  ["path", { class: "kk-line", d: "M43 60 q6 -7 12 0" }],
  ["path", { class: "kk-line", d: "M65 60 q6 -7 12 0" }],
  ["path", { class: "kk-line kk-mouth", d: "M55 74 q5 5 10 0" }],
  ...PART_ARMS,
  ...PART_LOCK_SHUT,
];

/** 자물쇠가 열려 신난 꽁꽁이 */
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

/** 암호가 틀려 놀란 꽁꽁이 */
const CHAR_WRONG = [
  ...PART_BODY,
  ["path",    { class: "kk-line", d: "M44 56 l10 8 M54 56 l-10 8" }],
  ["path",    { class: "kk-line", d: "M66 56 l10 8 M76 56 l-10 8" }],
  ["ellipse", { class: "kk-line kk-mouth-o", cx: 60, cy: 76, rx: 4, ry: 5 }],
  ...PART_ARMS,
  ...PART_LOCK_SHUT,
];

/** 스펙 배열을 SVG 로 만들어 host 에 넣는다 (기존 내용은 비운다) */
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

// ── 암호화 ────────────────────────────────────────────────────────────────

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
  if (p.v !== 1) throw new Error("지원하지 않는 형식입니다 (v" + p.v + ")");
  const key = deriveKey(password, Buffer.from(p.salt, "base64"));
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm", key, Buffer.from(p.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(p.tag, "base64"));
  // 암호가 틀리면 여기서 인증 태그 검증에 실패해 예외가 난다
  const out = Buffer.concat([
    decipher.update(Buffer.from(p.data, "base64")),
    decipher.final(),
  ]);
  return out.toString("utf8");
}

// ── 파일 포맷 ─────────────────────────────────────────────────────────────

function wrap(payloadJson) {
  return [MARKER, payloadJson, FENCE, ""].join("\n");
}

/** 잠긴 노트면 payload(JSON 문자열), 아니면 null */
function unwrap(content) {
  for (const lang of [LANG, LEGACY_LANG]) {
    const marker = "```" + lang;
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

// ── 마크다운 렌더 (API 버전 차이 흡수) ────────────────────────────────────

async function renderMarkdown(app, md, el, sourcePath, component) {
  if (typeof MarkdownRenderer.render === "function") {
    await MarkdownRenderer.render(app, md, el, sourcePath, component);
  } else {
    await MarkdownRenderer.renderMarkdown(md, el, sourcePath, component);
  }
}

// ── 모달 ──────────────────────────────────────────────────────────────────

/** 암호 입력 — confirm=true 면 확인 입력까지 받는다 (잠글 때) */
class SetPasswordModal extends Modal {
  constructor(app, { title, note, confirm, cta, onSubmit }) {
    super(app);
    this.title = title;
    this.note = note;
    this.confirm = confirm !== false;
    this.cta = cta || "확인";
    this.onSubmit = onSubmit;
    this.pw = "";
    this.pw2 = "";
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("kk-modal");
    contentEl.createEl("h3", { text: this.title });
    if (this.note) {
      contentEl.createEl("p", { cls: "kk-modal-note", text: this.note });
    }

    const submit = () => {
      if (!this.pw) return new Notice("암호를 입력하세요");
      if (this.confirm) {
        if (this.pw.length < 8) return new Notice("암호는 8자 이상으로 해주세요");
        if (this.pw !== this.pw2) return new Notice("두 암호가 다릅니다");
      }
      this.done = true;
      const pw = this.pw;
      this.close();
      this.onSubmit(pw);
    };

    const mkInput = (label, key, focus) => {
      new Setting(contentEl).setName(label).addText((t) => {
        t.inputEl.type = "password";
        t.onChange((v) => { this[key] = v; });
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
        });
        if (focus) window.setTimeout(() => t.inputEl.focus(), 0);
      });
    };

    mkInput("암호", "pw", true);
    if (this.confirm) mkInput("암호 확인", "pw2", false);

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("취소").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.cta).setCta().onClick(submit));
  }

  onClose() {
    this.contentEl.empty();
    this.pw = "";
    this.pw2 = "";
    if (!this.done) this.onSubmit(null);
  }
}

/** 풀린 상태에서 내용을 고칠 때 쓰는 편집창 — 저장하면 같은 암호로 다시 잠근다 */
class EditModal extends Modal {
  constructor(app, { title, text, onSave }) {
    super(app);
    this.title = title;
    this.text = text;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.style.width = "min(900px, 90vw)";
    contentEl.createEl("h3", { text: "🔓 " + this.title });

    const ta = contentEl.createEl("textarea", { cls: "kk-edit", text: this.text });
    ta.spellcheck = false;

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("취소").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("저장하고 다시 꽁꽁").setCta().onClick(async () => {
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

// ── 설정 탭 ───────────────────────────────────────────────────────────────

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
    hero.createDiv({ cls: "kk-hero-name", text: "꽁꽁이" });
    hero.createDiv({ cls: "kk-hero-desc", text: "노트를 꽁꽁 숨겨드려요" });

    new Setting(containerEl)
      .setName("꽁꽁이 보여주기")
      .setDesc("끄면 캐릭터 없이 암호 입력창만 나옵니다.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showCharacter).onChange(async (v) => {
          this.plugin.settings.showCharacter = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("다른 노트로 가면 다시 꽁꽁")
      .setDesc("풀어놓은 내용이 화면에 남지 않게 합니다.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.relockOnLeave).onChange(async (v) => {
          this.plugin.settings.relockOnLeave = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("창을 벗어나면 다시 꽁꽁")
      .setDesc("다른 프로그램으로 전환할 때 잠급니다.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.relockOnBlur).onChange(async (v) => {
          this.plugin.settings.relockOnBlur = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("자동 잠금 시간 (초)")
      .setDesc("푼 뒤 이 시간이 지나면 다시 잠급니다. 0 이면 시간 제한 없음.")
      .addText((t) =>
        t
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
    warn.createEl("strong", { text: "주의: " });
    warn.appendText("암호를 잊으면 복구할 수 없습니다. 중요한 노트는 잠그기 전에 백업하세요.");

    containerEl.createEl("p", {
      cls: "kk-tip",
      text: "잠긴 내용은 읽기 뷰와 라이브 프리뷰에서 펼쳐집니다. "
          + "소스 모드에서는 암호문이 그대로 보입니다 (정상 동작).",
    });
  }
}

// ── 플러그인 본체 ─────────────────────────────────────────────────────────

module.exports = class KkongkkongiPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // 화면에 렌더된 잠금 블록들 — 다시 잠글 때 순회한다
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

    this.registerMarkdownCodeBlockProcessor(LANG, handler);
    this.registerMarkdownCodeBlockProcessor(LEGACY_LANG, handler);

    this.addCommand({
      id: "lock-note",
      name: "이 노트 꽁꽁 잠그기",
      callback: () => this.lockActive(),
    });

    this.addCommand({
      id: "unlock-note",
      name: "이 노트 잠금 영구 해제 (평문으로 되돌리기)",
      callback: () => this.unlockActive(),
    });

    this.addCommand({
      id: "relock-all",
      name: "열려 있는 것 모두 다시 꽁꽁",
      callback: () => {
        this.relockAll();
        new Notice("🔒 모두 다시 꽁꽁 잠갔어요");
      },
    });

    this.addSettingTab(new KkongSettingTab(this.app, this));

    // 다른 노트/화면으로 이동하면 다시 잠근다
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.settings.relockOnLeave) this.relockAll();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        if (this.settings.relockOnLeave) this.relockAll();
      })
    );

    // 옵시디언 창에서 포커스가 나가면 다시 잠근다
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

  // ── 인라인 렌더 ──

  /** 잠긴 상태 — 꽁꽁이가 자물쇠를 안고 암호를 기다린다 */
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

    box.createDiv({ cls: "kk-title", text: "꽁꽁 숨겨뒀어요" });

    const row = box.createDiv({ cls: "kk-row" });
    const input = row.createEl("input", {
      cls: "kk-input",
      attr: { type: "password", placeholder: "암호를 알려주세요" },
    });
    const btn = row.createEl("button", { cls: "kk-btn kk-btn--cta", text: "열기" });
    const msg = box.createDiv({ cls: "kk-msg" });

    const shake = () => {
      if (charHost) {
        drawChar(charHost, CHAR_WRONG);
        charHost.addClass("kk-shake");
        window.setTimeout(() => {
          if (!entry.locked || !charHost.isConnected) return;
          charHost.removeClass("kk-shake");
          drawChar(charHost, CHAR_LOCKED);
        }, 1200);
      }
    };

    const go = () => {
      if (!input.value) return;
      let text;
      try {
        text = decrypt(entry.payload, input.value);
      } catch {
        msg.setText("앗, 암호가 달라요");
        shake();
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

  /** 풀린 상태 — 꽁꽁이가 자물쇠를 열고, 내용이 그 자리에 펼쳐진다 */
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
      text: sec > 0 ? `열었어요! ${sec}초 뒤에 다시 꽁꽁할게요` : "열었어요!",
    });

    const actions = bar.createDiv({ cls: "kk-actions" });
    actions
      .createEl("button", { cls: "kk-btn", text: "편집" })
      .addEventListener("click", () => this.editEntry(entry, text));
    actions
      .createEl("button", { cls: "kk-btn", text: "다시 꽁꽁" })
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

  /** 풀려 있는 블록을 전부 다시 잠근다 (화면에서 사라진 블록은 정리) */
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

  // ── 편집 ──

  editEntry(entry, text) {
    const file = this.app.vault.getAbstractFileByPath(entry.sourcePath);
    if (!file) return new Notice("파일을 찾을 수 없습니다");
    const pw = entry.pw;
    if (!pw) return new Notice("먼저 암호를 입력해 잠금을 해제하세요");

    new EditModal(this.app, {
      title: file.basename,
      text,
      onSave: async (newText) => {
        if (newText === text) return this.renderLocked(entry);
        try {
          await this.app.vault.modify(file, wrap(encrypt(newText, pw)));
          new Notice("🔒 저장하고 다시 꽁꽁 잠갔어요");
        } catch (e) {
          new Notice("저장 실패: " + e.message);
        }
      },
    }).open();
  }

  // ── 명령 ──

  activeFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("열린 노트가 없습니다");
      return null;
    }
    return file;
  }

  async lockActive() {
    const file = this.activeFile();
    if (!file) return;

    const content = await this.app.vault.read(file);
    if (unwrap(content)) return new Notice("이미 꽁꽁 잠긴 노트예요");
    if (!content.trim()) return new Notice("빈 노트는 잠글 수 없습니다");

    new SetPasswordModal(this.app, {
      title: "꽁꽁 잠그기",
      note: `${file.basename} — 암호를 잊으면 복구할 수 없습니다.`,
      confirm: true,
      cta: "꽁꽁",
      onSubmit: async (pw) => {
        if (!pw) return;
        try {
          await this.app.vault.modify(file, wrap(encrypt(content, pw)));
          new Notice("🔒 꽁꽁 잠갔어요");
        } catch (e) {
          new Notice("잠그기 실패: " + e.message);
        }
      },
    }).open();
  }

  async unlockActive() {
    const file = this.activeFile();
    if (!file) return;

    const content = await this.app.vault.read(file);
    const payload = unwrap(content);
    if (!payload) return new Notice("꽁꽁 잠긴 노트가 아니에요");

    new SetPasswordModal(this.app, {
      title: "잠금 영구 해제",
      note: `${file.basename} — 평문으로 되돌립니다. 파일에 내용이 그대로 저장됩니다.`,
      confirm: false,
      cta: "해제",
      onSubmit: async (pw) => {
        if (!pw) return;
        let text;
        try {
          text = decrypt(payload, pw);
        } catch {
          return new Notice("암호가 틀렸거나 내용이 손상됐습니다");
        }
        await this.app.vault.modify(file, text);
        new Notice("🔓 잠금을 해제했어요 (평문)");
      },
    }).open();
  }
};
