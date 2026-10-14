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
- `lib/whatsapp.js` — WhatsApp Cloud API `v26.0`, текстові та інтерактивні повідомлення.
- `lib/state.js` — Redis state, незалежні профілі фізосіб і відповідальних осіб ВЧ, counters та idempotency claims.
- `lib/meta-media.js` — bounded streaming download WhatsApp media, перевірки Meta/HTTP metadata та передача `Buffer` у validation pipeline.
- `lib/media-validation.js` — централізована MIME/structure/size validation, canonical extension і validation metadata для media documents.
- `lib/google-drive.js` — OAuth2 Google Drive, папки, document uploads і post-confirm finalization документів ВЧ та multi-заявок фізосіб.
- `lib/google-sheets.js` — monthly operator spreadsheets, single rows, multi master/detail blocks, statuses, clickable request IDs, rich-text document links і request-card lookup.
- `api/request-card.js` — HMAC-захищена printable HTML-картка запиту.
- `api/meta/oauth-callback.js` — callback Meta-hosted Embedded Signup OAuth: приймає `code` або повідомляє про OAuth error; не обмінює code на токени й не змінює bot state.

Основні інтеграції: WhatsApp Cloud API, Redis, Google Drive API, Google Sheets API, Vercel і GitHub. State не можна тримати лише в пам'яті процесу: Vercel виконує незалежні serverless-запити.

### Vercel Hobby function limit

Vercel Hobby дозволяє не більше 12 Serverless Functions у deployment. Production helpers зберігаються в кореневому `lib/`, а не в `api/`, щоб не витрачати function budget. У `api/` залишаються лише HTTP endpoint-файли; перед додаванням нового endpoint перевіряти їх кількість. Не відновлювати застарілі `api/drive-test.js`, `api/drive-upload-test.js`, `api/sheets-test.js` або `api/request-card-test-url.js`: це були одноразові тестові routes, уже видалені після production-перевірок.

## Правила внесення змін

Перед зміною коду:

1. Прочитати актуальну реалізацію та стан Git.
2. Зрозуміти state machine, data flow і callers коду, що змінюється.
3. Врахувати Redis state, повторні webhook delivery, WhatsApp flow, Drive, Sheets та Vercel serverless-обмеження.
4. Зробити найменшу безпечну зміну й перевірити її пропорційно ризику.

Не переписувати робочі частини лише заради стилю. Не ламати Meta verification/POST webhook, Redis claims, media upload, Google Drive, Google Sheets або request-card інтеграції. Не припускати, що кожен документ є зображенням; зберігати коректне розширення файлу.

### Перевірки

Для змінених JavaScript-файлів запускати `node --check`; для поведінкових змін — `node --test` або релевантний production-oriented test file; перед передачею роботи — `git diff --check` і перегляд фактичного diff. Тести мають викликати production functions через контрольовані mocks і не повинні звертатися до production Redis, Google Drive, Google Sheets або WhatsApp API. Не вважати mock-тест доказом реальної доставки зовнішнім API.

WhatsApp interactive reply buttons мають містити 1–3 кнопки. Для більшої кількості варіантів використовувати list message: не більше 10 rows сумарно, короткі унікальні row IDs, button text до 20 символів і row/section titles до 24 символів. `sendEditMenu()` використовує list із 5–6 rows; webhook повинен зберігати підтримку `interactive.list_reply.id`, `interactive.button_reply.id` і legacy `button.payload`.

### Secure Media Upload

Усі нові WhatsApp media uploads мають проходити єдиним шляхом: `downloadWhatsAppMedia()` у `lib/meta-media.js` → `validateMediaBuffer()` у `lib/media-validation.js` → `saveIncomingDocument()` в `api/webhook.js` → `uploadBufferToDrive()`. Не створювати альтернативний шлях до Google Drive upload в обхід validation pipeline.

- Дозволені лише `image/jpeg`, `image/png`, `image/heic`, `image/heif` і `application/pdf`; єдиний ліміт `MAX_MEDIA_SIZE_BYTES` — 5 MiB (`5 * 1024 * 1024`).
- Не довіряти filename extension, заявленому Meta MIME або HTTP `Content-Type` без перевірки фактичного вмісту. Drive filename повинен отримувати canonical extension із результату validation.
- Не використовувати необмежений `response.arrayBuffer()` для media downloads: зберігати bounded streaming, перевірки Meta `file_size`, HTTP `Content-Length` і фактичного розміру.
- Не дозволяти legacy/unvalidated documents проходити confirmation, finalization або saved-document reuse. Зберігати fail-closed інваріанти `requestDocumentsHaveValidation()`, `assertRequestDocumentsHaveValidation()` і `restartRequestWithUnvalidatedDocuments()` для single, multi та military flows.
- Не змінювати validation metadata schema (`version`, MIME, extension, size, SHA-256 і dimensions там, де підтримуються) без regression tests для intake, Redis restore, saved documents і confirmation.
- При зміні document prompts перевіряти всі п'ять первинних і повторних підказок, включно з `repeatCurrentPrompt()` після `/menu`; текст має зберігати ліміт 5 МБ.
- Відхилений файл не повинен потрапляти в Drive або `request.documents`; поточний document stage має залишатися доступним для повторного завантаження. Не послаблювати повторну fail-closed перевірку безпосередньо перед confirmation side effects.

### Confirmation flow

Confirmation серіалізується Redis claim `wa:confirmation:<phone>` з owner token, TTL, heartbeat, ownership fences і owner-only release. Лише owner надсилає повідомлення «Реєструємо вашу заявку…» та виконує зовнішні side effects. `busy` callback має завершуватися без додаткових WhatsApp-повідомлень або retry-menu. Handler, що втратив claim, не надсилає success/failure; recovery prompt допустимий лише після атомарного захоплення нового claim, перевірки актуального state та відсутності заявки в Sheets.

WhatsApp delivery не має exactly-once гарантії: HTTP timeout може настати після фактичного прийняття повідомлення Meta. Не створювати суперечливі success/failure/retry повідомлення й не додавати глобальну message-ID дедуплікацію без окремого дизайну crash recovery.

Single individual і military paths не рефакторити через multi. Single зберігає `request.documents`/`request.documentIndex`, один Sheets row і current Drive/profile behavior. Multi використовує `request.beneficiaries[]`; applicant (`request.data`), beneficiary і recipient — різні ролі. Beneficiary існує лише всередині request: його phone не є persistent identity, не використовується для profile lookup/save, а його documents не стають saved applicant documents.

Порядок успішного підтвердження single/ВЧ критичний:

1. Стабілізувати `applicationId` і `confirmedAt` у Redis.
2. Записати заявку в Google Sheets.
3. Позначити `sheetsRecorded: true` і зберегти state.
4. Для фізособи зберегти `wa:profile:<phone>`.
5. Для ВЧ перемістити й перейменувати existing Drive files у `ВЧ/<номер ВЧ>/<фінальне ПІБ>/`, оновити document metadata у state та rich-text links у Sheets H.
6. Для ВЧ лише після Drive/Sheets finalize зберегти незалежний persistent profile `wa:military-contact:<phone>`; номер ВЧ у нього не входить.
7. Зробити одну best-effort спробу відправити WhatsApp success.
8. Після завершення реєстрації викликати `resetUserState()`; помилка фінальної доставки логується й не запускає повторну реєстрацію.

При Sheets, military Drive finalize або military Sheets H update failure state не очищати й success не надсилати. Retry не повинен дублювати Sheets row або Drive file: `applicationId` і `driveFileId` залишаються стабільними. Не генерувати `applicationId` приховано в `sendText` або `sendMessage`.

Для individual multi порядок окремий і критичний: стабілізувати `applicationId`/`confirmedAt` → зберегти state → finalizувати existing Drive files за `driveFileId` у `ФІЗ/<фінальний applicant>/<фінальний beneficiary>/` → зберегти beneficiary metadata → завершити Sheets master/detail block, rich-text, clickable master ID і grouping → лише тоді `sheetsRecorded: true` → safe applicant profile handling → best-effort WhatsApp success → reset. До повного Drive/Sheets success state не очищати. `applicationId` не є Drive folder level; він входить у final multi filenames, а `driveFileId` не змінюється.

Multi Sheets: один master row із real/clickable `applicationId` у B і N grouped detail rows із labels `Особа 1`, `Особа 2`, … у B. Detail labels не є application IDs і не отримують request-card links. Не ламати matrix-write/retry recovery або не включати master у row group.

Запис single і multi в Sheets серіалізується окремим Redis lease `sheets:writer:<spreadsheetId>:<sheetId>` з heartbeat та ownership checks. Writer використовує `values.update()` з explicit range, не `values.append(... INSERT_ROWS)`. Multi master і details пишуться однією matrix operation; retry може відновити лише перевірений порожній suffix. Не перезаписувати непорожні сусідні rows, не створювати overlapping/nested groups і не виправляти неоднозначну production-структуру автоматично.

Drive hierarchy не змішувати: ВЧ — `ВЧ/<номер ВЧ>/<ПІБ>/`; individual single — `ФІЗ/<ПІБ>/`; individual multi collection/finalization — `ФІЗ/<applicant>/<beneficiary>/`. Нові root-level `<beneficiary> — Особа N` folders створювати не можна. Military та single paths мають залишатися без змін.

Military та individual profiles мають окремі Redis keys і не перезаписують один одного. Returning military contact автоматично використовує canonical ПІБ і все одно щоразу вводить номер ВЧ; фінальний підтверджений `edit_name` оновлює canonical profile.

У Sheets visible значення колонки B залишається exact `applicationId`, але production writer автоматично додає clickable signed request-card link для кожної нової заявки. Не дублювати signing logic поза `buildRequestCardUrl()`.

`applicationId` має формат `YYYY-MM-NNNN`, де `YYYY-MM` фіксується один раз за `Europe/Kyiv` перед первинною генерацією, а `NNNN` — місячна послідовність `0001`–`9999`. Redis key: `requests:counter:YYYY-MM`. Перед атомарним виділенням номера враховується максимальний уже записаний sequence у всіх однойменних місячних spreadsheets; retry завжди використовує стабільний ID зі state. Sheets lookup перевіряє лише місяць, закодований в ID, обидві request-вкладки та всі однойменні spreadsheet-файли.

`api/meta/oauth-callback.js` потрібен для Meta-hosted Embedded Signup. Не додавати до нього token exchange, збереження OAuth code або зміну WhatsApp/webhook flow без окремо погодженої задачі.

### Редагування і відновлення flow

На `CONFIRMATION` кнопка `edit_request` переводить state у `EDIT_MENU` до надсилання меню; дані заявки не очищаються. `sendEditMenu()` — interactive list, а не набір із понад трьох reply buttons. Вибір поля використовує чинні IDs і повертає заявку до `CONFIRMATION` після редагування. `/menu` не скидає активний request: `resume_request` викликає `repeatCurrentPrompt()`, зокрема відновлює `EDIT_MENU`, document prompt і confirmation. Stale interactive buttons не повинні змінювати stage або втрачати дані.

## Secrets та environment variables

Не виводити й не записувати значення secrets у код, логи, документацію, commit або prompt.

- WhatsApp: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WEBHOOK_VERIFY_TOKEN`.
- Redis: `REDIS_URL`.
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
- Request card: `REQUEST_CARD_SIGNING_SECRET`.
- `VERCEL_PROJECT_PRODUCTION_URL` — Vercel system environment variable для canonical production URL; це не secret і його не потрібно вручну зберігати в репозиторії.

Не змінювати Vercel configuration, secrets або environment variables без явного запиту користувача.

Не читати, змінювати, видаляти або «виправляти» production Redis/Sheets/Drive data без прямого дозволу, навіть якщо локальний код містить maintenance helper. Інтеграційні тести з реальними зовнішніми даними також потребують окремого погодження.

## Git і джерела істини

Ніколи не створювати commit, push або deployment після звичайного завдання без окремої явної вказівки користувача. Ніколи не force-push. Перед commit перевірити `git status`, `git diff --check`, релевантний diff і тести; додавати лише погоджені файли. Перед push перевірити branch/HEAD. Звичайний production шлях — перевірений commit → push `main` → автоматичний Vercel deployment; ручний deployment не запускати без окремого дозволу.

Код — authoritative source фактично реалізованої поведінки. `docs/PROJECT_CONTEXT.md` — detailed business/project context. Якщо вони різняться, зафіксувати discrepancy і не виправляти поведінку автоматично. User-facing WhatsApp-тексти та комунікація проєкту — українською, якщо користувач не попросив інакше.
