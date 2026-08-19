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
- `api/lib/state.js` — Redis state, незалежні профілі фізосіб і відповідальних осіб ВЧ, counters та idempotency claims.
- `api/lib/meta-media.js` — завантаження WhatsApp media у `Buffer`.
- `api/lib/google-drive.js` — OAuth2 Google Drive, папки, document uploads і post-confirm finalization документів ВЧ та multi-заявок фізосіб.
- `api/lib/google-sheets.js` — monthly operator spreadsheets, single rows, multi master/detail blocks, statuses, clickable request IDs, rich-text document links і request-card lookup.
- `api/sheets-test.js` — безпечна діагностика current monthly spreadsheet.
- `api/request-card.js` — HMAC-захищена printable HTML-картка запиту.
- `api/request-card-test-url.js` — тимчасовий, наразі збережений для тестування endpoint генерації signed request-card URL.
- `api/request-card-links-test.js` — тимчасовий, наразі збережений для тестування endpoint міграції clickable request IDs у current monthly spreadsheet.

Основні інтеграції: WhatsApp Cloud API, Redis, Google Drive API, Google Sheets API, Vercel і GitHub. State не можна тримати лише в пам'яті процесу: Vercel виконує незалежні serverless-запити.

## Правила внесення змін

Перед зміною коду:

1. Прочитати актуальну реалізацію та стан Git.
2. Зрозуміти state machine, data flow і callers коду, що змінюється.
3. Врахувати Redis state, повторні webhook delivery, WhatsApp flow, Drive, Sheets та Vercel serverless-обмеження.
4. Зробити найменшу безпечну зміну й перевірити її пропорційно ризику.

Не переписувати робочі частини лише заради стилю. Не ламати Meta verification/POST webhook, Redis claims, media upload, Google Drive, Google Sheets або request-card інтеграції. Не припускати, що кожен документ є зображенням; зберігати коректне розширення файлу.

### Confirmation flow

Single individual і military paths не рефакторити через multi. Single зберігає `request.documents`/`request.documentIndex`, один Sheets row і current Drive/profile behavior. Multi використовує `request.beneficiaries[]`; applicant (`request.data`), beneficiary і recipient — різні ролі. Beneficiary існує лише всередині request: його phone не є persistent identity, не використовується для profile lookup/save, а його documents не стають saved applicant documents.

Порядок успішного підтвердження single/ВЧ критичний:

1. Стабілізувати `applicationId` і `confirmedAt` у Redis.
2. Записати заявку в Google Sheets.
3. Позначити `sheetsRecorded: true` і зберегти state.
4. Для фізособи зберегти `wa:profile:<phone>`.
5. Для ВЧ перемістити й перейменувати existing Drive files у `ВЧ/<номер ВЧ>/<фінальне ПІБ>/`, оновити document metadata у state та rich-text links у Sheets H.
6. Для ВЧ лише після Drive/Sheets finalize зберегти незалежний persistent profile `wa:military-contact:<phone>`; номер ВЧ у нього не входить.
7. Відправити WhatsApp success.
8. Лише після цього викликати `resetUserState()`.

При Sheets, military Drive finalize або military Sheets H update failure state не очищати й success не надсилати. Retry не повинен дублювати Sheets row або Drive file: `applicationId` і `driveFileId` залишаються стабільними. Не генерувати `applicationId` приховано в `sendText` або `sendMessage`.

Для individual multi порядок окремий і критичний: стабілізувати `applicationId`/`confirmedAt` → зберегти state → finalizувати existing Drive files за `driveFileId` у `ФІЗ/<фінальний applicant>/<фінальний beneficiary>/` → зберегти beneficiary metadata → завершити Sheets master/detail block, rich-text, clickable master ID і grouping → лише тоді `sheetsRecorded: true` → safe applicant profile handling → WhatsApp success → reset. До повного Drive/Sheets success state не очищати. `applicationId` не є Drive folder level; він входить у final multi filenames, а `driveFileId` не змінюється.

Multi Sheets: один master row із real/clickable `applicationId` у B і N grouped detail rows із labels `Особа 1`, `Особа 2`, … у B. Detail labels не є application IDs і не отримують request-card links. Не ламати matrix-write/retry recovery або не включати master у row group.

Drive hierarchy не змішувати: ВЧ — `ВЧ/<номер ВЧ>/<ПІБ>/`; individual single — `ФІЗ/<ПІБ>/`; individual multi collection/finalization — `ФІЗ/<applicant>/<beneficiary>/`. Нові root-level `<beneficiary> — Особа N` folders створювати не можна. Military та single paths мають залишатися без змін.

Military та individual profiles мають окремі Redis keys і не перезаписують один одного. Returning military contact автоматично використовує canonical ПІБ і все одно щоразу вводить номер ВЧ; фінальний підтверджений `edit_name` оновлює canonical profile.

У Sheets visible значення колонки B залишається exact `applicationId`, але є clickable signed request-card link. Не дублювати signing logic поза `buildRequestCardUrl()`.

`api/request-card-test-url.js` і `api/request-card-links-test.js` — temporary endpoints, currently retained for testing; не видаляти випадково. Поточну роботу над production WhatsApp Business App + Cloud API Coexistence не змінювати без окремого запиту: onboarding ще не завершений.

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
