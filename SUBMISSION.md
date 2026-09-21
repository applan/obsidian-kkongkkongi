# 커뮤니티 플러그인 제출 메모

## 1. obsidian-releases 에 추가할 항목

`obsidianmd/obsidian-releases` 저장소의 `community-plugins.json` **배열 맨 끝**에 아래를 추가한다.
(`repo` 의 `USERNAME` 을 본인 GitHub 계정으로 바꿀 것)

```json
{
  "id": "kkongkkongi",
  "name": "Kkongkkongi",
  "author": "mschoi",
  "description": "Encrypt note content with AES-256-GCM and reveal it inline. A little character hugs a padlock while your note is locked.",
  "repo": "USERNAME/obsidian-kkongkkongi"
}
```

## 2. 릴리스에 첨부할 파일 (저장소 루트 아님, 릴리스 asset 으로)

- `manifest.json`
- `main.js`
- `styles.css`

태그 이름은 `v` 없이 버전 그대로: **`1.0.0`**

## 3. 심사 체크리스트

| 항목 | 상태 |
| --- | --- |
| `innerHTML` / `outerHTML` 미사용 | 통과 (DOM API 로 전환) |
| 인라인 스타일 대신 CSS 클래스 사용 | 통과 (`styles.css`) |
| 플러그인 이름에 "Obsidian" 미포함 | 통과 |
| `manifest.json` 필수 필드 | 통과 |
| `versions.json` 존재 | 통과 |
| LICENSE 존재 | 통과 (MIT) |
| README 존재 | 통과 |
| Node API 사용 시 `isDesktopOnly: true` | 통과 |
| `console.log` 남용 없음 | 통과 |
| 전역 변수 오염 없음 | 통과 |
| 테스트 | 81개 통과 (`node test/test.js`) |

## 4. 심사에서 나올 만한 질문

- **암호 복구 불가** — 의도된 설계. README 와 설정 화면, 잠글 때 모달에 모두 경고를 넣었다.
- **기존 암호화 플러그인과 차이** — 화면만 가리는 방식이 아니라 파일에 저장되는 내용 자체를 암호화한다.
- **키 유도 파라미터** — scrypt N=32768, r=8, p=1. 자체 설계한 암호 알고리즘 없음, Node 내장 `crypto` 표준 조합만 사용.
- **다국어** — UI 는 옵시디언 언어 설정을 따른다(en / ko, 설정에서 고정 가능). 목록에 표시되는 이름과 설명은 영문이다.
- **테스트** — `node test/test.js` 81개 통과 (en/ko 양쪽 UI 흐름 포함).
