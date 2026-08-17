# Monstriv Bot — інструкції для агентів

## Проєкт і production

Monstriv Bot — WhatsApp-бот для збору та первинної реєстрації запитів від фізичних осіб і військових частин. Репозиторій: `MahlioPaluori/monstriv-bot`; основна гілка — `main`.

Production розгортається у Vercel із GitHub. Звичайний шлях змін:

```text
local VS Code → checks → commit → push main → Vercel deployment
```

Локальна зміна сама по собі не означає зміну production. Перед переходом між комп'ютерами: зробити commit і push на поточному, а на іншому — `git pull` або clone.

## Архітектура

- `api/webhook.js` — Vercel webhook, Meta verification, WhatsApp state machine, документи, delivery і confirmation.
- `api/lib/whatsapp.js` — WhatsApp Cloud API `v26.0`, текстові та інтерактивні повідомлення.
- `api/lib/state.js` — Redis state, профілі фізосіб, counters і idempotency claims.
- `api/lib/meta-media.js` — завантаження WhatsApp media у `Buffer`.
- `api/lib/google-drive.js` — OAuth2 Google Drive, папки та document uploads.
- `api/lib/google-sheets.js` — monthly operator spreadsheets, записи заявок, статуси, rich-text document links і request-card lookup.
- `api/sheets-test.js` — безпечна діагностика current monthly spreadsheet.
- `api/request-card.js` — HMAC-захищена printable HTML-картка запиту.
- `api/request-card-test-url.js` — тимчасовий endpoint генерації signed request-card URL.

Основні інтеграції: WhatsApp Cloud API, Redis, Google Drive API, Google Sheets API, Vercel і GitHub. State не можна тримати лише в пам'яті процесу: Vercel виконує незалежні serverless-запити.

## Правила внесення змін

Перед зміною коду:

1. Прочитати актуальну реалізацію та стан Git.
2. Зрозуміти state machine, data flow і callers коду, що змінюється.
3. Врахувати Redis state, повторні webhook delivery, WhatsApp flow, Drive, Sheets та Vercel serverless-обмеження.
4. Зробити найменшу безпечну зміну й перевірити її пропорційно ризику.

Не переписувати робочі частини лише заради стилю. Не ламати Meta verification/POST webhook, Redis claims, media upload, Google Drive, Google Sheets або request-card інтеграції. Не припускати, що кожен документ є зображенням; зберігати коректне розширення файлу.

### Confirmation flow

Порядок успішного підтвердження критичний:

1. Стабілізувати `applicationId` і `confirmedAt` у Redis.
2. Записати заявку в Google Sheets.
3. Позначити `sheetsRecorded`.
4. Для фізособи зберегти profile.
5. Відправити WhatsApp success.
6. Лише після цього викликати `resetUserState()`.

При Sheets failure state не очищати. Не генерувати `applicationId` приховано в `sendText` або `sendMessage`; ID має залишатися стабільним між retry.

## Secrets та environment variables

Не виводити й не записувати значення secrets у код, логи, документацію, commit або prompt.

- WhatsApp: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WEBHOOK_VERIFY_TOKEN`.
- Redis: `REDIS_URL`.
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
- Request card: `REQUEST_CARD_SIGNING_SECRET`, `REQUEST_CARD_TEST_SECRET`.
- `VERCEL_PROJECT_PRODUCTION_URL` — Vercel system environment variable для canonical production URL; це не secret і його не потрібно вручну зберігати в репозиторії.

Не змінювати Vercel configuration, secrets або environment variables без явного запиту користувача.

## Git і джерела істини

Ніколи не створювати commit або push без явного погодження користувача. Ніколи не force-push. Перед commit перевірити `git status` і релевантний diff; не додавати сторонні або untracked файли без явного дозволу.

Код — authoritative source фактично реалізованої поведінки. `docs/PROJECT_CONTEXT.md` — detailed business/project context. Якщо вони різняться, зафіксувати discrepancy і не виправляти поведінку автоматично. User-facing WhatsApp-тексти та комунікація проєкту — українською, якщо користувач не попросив інакше.
