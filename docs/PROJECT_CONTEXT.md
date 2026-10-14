# Monstriv Bot — project context

## Статус і джерела істини

Monstriv Bot — WhatsApp-бот для структурованого збору, документування й первинної реєстрації запитів від фізичних осіб і військових частин.

- **IMPLEMENTED** — підтверджено поточним кодом у `main`.
- **PLANNED** — погоджений наступний крок, ще не реалізований.
- **KNOWN RISK** — відома технічна або процесна межа поточної реалізації.

Код — authoritative source фактичної поведінки. Цей документ — business/project context. Production workflow: local VS Code → checks → commit → push `main` → Vercel deployment. GitHub `main` є source of truth для production deployment, але фактичний live deployment слід підтверджувати окремо.

## Архітектура

Проєкт — Node.js ESM (`"type": "module"`, Node.js `>=20`) для Vercel serverless. Процес не має надійної локальної пам'яті між invocations, тому conversation state, profiles, counters і distributed leases зберігаються в Redis.

- `api/webhook.js` — GET verification і POST webhook Meta WhatsApp, state machine, navigation, document intake та confirmation lifecycle.
- `lib/whatsapp.js` — WhatsApp Cloud API `v26.0`, text, reply-button і list messages.
- `lib/state.js` — Redis state/profile helpers, monthly counters, media/document claims, confirmation та Sheets writer leases.
- `lib/meta-media.js` — отримання WhatsApp media як `Buffer`.
- `lib/google-drive.js` — OAuth2 Drive client, папки, uploads, move/rename та idempotent copies.
- `lib/google-sheets.js` — monthly spreadsheets, single/multi writer, rich-text links, grouping і read-only request lookup.
- `api/request-card.js` — HMAC-захищена printable HTML-картка, дані для якої читаються з Sheets.
- `api/request-card-links-test.js` — тимчасовий захищений maintenance endpoint для відновлення clickable IDs у current monthly spreadsheet.
- `api/meta/oauth-callback.js` — обмежений callback Embedded Signup без token exchange.
- `test/*.test.js` — локальні production-function tests із mocks; реальні Google/Redis/WhatsApp ресурси не використовуються.

Основні зовнішні системи: WhatsApp Cloud API, Redis, Google Drive API, Google Sheets API, Vercel і GitHub. `package.json` має runtime dependencies `googleapis` та `redis`; окремого test framework немає, використовується `node:test`.

## IMPLEMENTED: WhatsApp flows

### Перший контакт

Для нового WhatsApp phone перша обрана дія не губиться під час створення Redis state:

```text
send_request → state initialization → короткий welcome → APPLICANT_TYPE
operator → state initialization → OPERATOR
довільний текст/інша допустима подія → welcome → MAIN_MENU
```

Повторно натискати «Відправити запит» після першого `send_request` не потрібно; перед `operator` проміжне main menu не показується.

### Фізична особа

Після «Відправити запит» користувач обирає «Фізична особа».

Новий користувач проходить:

```text
APPLICANT_TYPE
→ IDENTIFICATION (ПІБ)
→ REQUEST_TYPE (потреба)
→ PACKAGE_MODE
```

`PACKAGE_MODE` розділяє сценарії «Документи однієї особи» та «Документи кількох осіб»; current button titles — «Одна особа» / «Кілька осіб».

Single branch зберігає попередній flow і schema:

```text
PACKAGE_MODE → DOCUMENTS
→ CITY
→ NOVA_POSHTA_BRANCH
→ RECIPIENT_CHOICE
→ RECIPIENT_NAME → RECIPIENT_PHONE  (лише якщо інший отримувач)
→ CONFIRMATION
```

Single documents лишаються в `request.documents` із `request.documentIndex`; один package записується одним Sheets row, використовує current `ФІЗ/<ПІБ>/` Drive hierarchy та current saved-profile behavior.

Multi branch:

```text
PACKAGE_MODE
→ PACKAGE_COUNT (ціле число 2–5)
→ BENEFICIARY_NAME
→ BENEFICIARY_PHONE
→ DOCUMENTS поточної особи
→ повторити для всіх beneficiaries
→ CITY
→ NOVA_POSHTA_BRANCH
→ RECIPIENT_CHOICE
→ RECIPIENT_NAME → RECIPIENT_PHONE  (лише якщо інший отримувач)
→ CONFIRMATION
```

Для кожного beneficiary обов'язкові ПІБ, контактний phone, `passport`, `rnokpp`, `military_id`; `ubd` optional. `DOCUMENTS` reuse-иться через active document store. Multi state:

```js
request.multiPackage
request.beneficiaryCount
request.currentBeneficiaryIndex
request.beneficiaries = [{ name, phone, documents, documentIndex }]
```

Multi edit stages: `EDIT_BENEFICIARY_SELECT`, `EDIT_BENEFICIARY_FIELD`, `EDIT_BENEFICIARY_TEXT`; підтримано зміну beneficiary name/phone. Зміна count, додавання/видалення beneficiaries і заміна documents через edit menu не реалізовані.

Документи фізособи збираються послідовно: `passport`, `rnokpp`, `military_id`, необов'язковий `ubd`. Для кожного типу підтримано один або кілька WhatsApp `image`/`document`. Кнопка «Готово» переходить далі лише після щонайменше одного файла; УБД можна пропустити до або після завантаження. Single використовує generic `document_done`/`document_skip`; multi — context-aware `document_done_<beneficiaryIndex>_<docKey>` і `document_skip_<beneficiaryIndex>_<docKey>`. Multi ack/sequence scope містить beneficiary index + document key; stale/malformed buttons не просувають flow, а beneficiary name/phone не є Redis identity.

Ролі строго розділені:

- applicant — `request.data.name`/`request.data.phone`, actual WhatsApp sender, для якого може існувати persistent profile;
- beneficiary — `request.beneficiaries[i]`, тимчасова сутність лише конкретної multi-заявки;
- recipient — `request.data.recipientName`/`request.data.recipientPhone`, delivery-only role.

Beneficiary phone required і validated, але не використовується для profile lookup/save та не створює beneficiary profile. Якщо колишній beneficiary пізніше звернеться зі свого WhatsApp `from` без existing applicant profile, він проходить new applicant flow і завантажує documents заново.

Для returning applicant за WhatsApp phone існує persistent Redis profile. Бот пропонує «Збережені дані» або «Ввести заново». При single повторно використовуються profile data і documents; якщо documents старші за 365 днів, користувач може залишити їх або завантажити актуальні.

У multi-flow після вибору «Збережені дані», кількості осіб і наявності повного saved package бот питає, чи входить applicant до числа beneficiaries. Якщо ні — всі packages збираються заново. Якщо так — applicant стає beneficiary №1 (`isApplicant: true`): актуальні saved documents копіюються після confirmation в application-specific files, а оригінальні canonical profile files не переміщуються й не перейменовуються. Для documents старших за 365 днів окремий multi-stage пропонує `multi_saved_use` або `multi_saved_replace`. У replace-path новий package applicant після успішного confirmation копіюється в стабільні canonical files і оновлює лише applicant profile; documents інших beneficiaries ніколи не стають profile documents. Якщо попереднього profile немає, звичайний multi не створює misleading saved-document profile з beneficiary documents.

### Військова частина

Для нового contact поточний flow:

```text
APPLICANT_TYPE
→ IDENTIFICATION (ПІБ відповідальної особи)
→ MILITARY_UNIT_NUMBER
→ REQUEST_TYPE
→ DOCUMENTS (official_request)
→ CITY
→ NOVA_POSHTA_BRANCH
→ RECIPIENT_CHOICE
→ RECIPIENT_NAME → RECIPIENT_PHONE  (лише якщо інший отримувач)
→ CONFIRMATION
```

Отже після `official_request` ВЧ **не** переходить напряму до confirmation. Delivery fields для ВЧ використовують ті самі states, що й фізособа, і доступні в edit flow.

Після першої успішно підтвердженої ВЧ-заявки persistent profile `wa:military-contact:<phone>` зберігає canonical ПІБ відповідальної особи. Номер ВЧ у profile не входить. При наступному виборі ВЧ з того самого phone бот автоматично встановлює збережене ПІБ і переходить прямо до `MILITARY_UNIT_NUMBER`. Якщо у confirmation через `edit_name` введено інше ПІБ, після успішного підтвердження саме воно стає новим canonical name.

### Confirmation

Single/ВЧ summary показує тип, ПІБ, телефон, номер ВЧ (за потреби), delivery, кількість documents і need. Multi summary надсилається частинами: applicant/need, окремий блок кожного beneficiary зі статусом/кількістю documents, потім спільний delivery block; confirmation buttons з'являються після останньої частини. Користувач підтверджує або переходить до edit flow.

Перед зовнішніми confirmation operations handler атомарно захоплює Redis claim `wa:confirmation:<phone>` з унікальним owner token. TTL поновлюється heartbeat; ownership перевіряється навколо зовнішніх side effects, а release виконується лише owner. Після першого успішного claim користувач один раз отримує «⏳ Реєструємо вашу заявку. Будь ласка, зачекайте на підтвердження.». Конкурентний/повторний callback із `busy` не запускає другу обробку й не надсилає retry або failure messages.

При втраті claim старий handler не має права надсилати success/failure. Recovery prompt можливий лише якщо handler атомарно отримав новий claim, актуальний state усе ще `CONFIRMATION`, а exact application ID ще не знайдено у Sheets. При recoverable failure до запису в Sheets зберігаються stage, request data та стабільний application ID і повторно показуються `confirm_request`/`edit_request`. Якщо Sheets уже містить заявку, повторну реєстрацію не пропонують. Фінальна доставка WhatsApp не має exactly-once гарантії: Meta може прийняти повідомлення навіть при HTTP timeout, тому система уникає суперечливих success/failure/retry повідомлень, але не може довести фактичну доставку без окремого outbox/status reconciliation.

### Редагування і навігація

На confirmation «Ні» (`edit_request`) зберігає `stage = EDIT_MENU` і відкриває WhatsApp interactive list. List має один section і 5 полів для individual single, 6 для individual multi (`edit_beneficiary`) або military (`edit_unit_number`); row IDs не змінені. Webhook нормалізує `interactive.list_reply.id`, `interactive.button_reply.id` і legacy `button.payload`. Після зміни поля `showConfirmation()` знову зберігає `CONFIRMATION` і показує актуальне зведення; зміна applicant name синхронізує beneficiary №1, якщо `isApplicant === true`.

Команди `/menu`, `start`/`/start` і `старт` не скидають активну заявку: користувач отримує navigation menu з `resume_request` і `cancel_request`. `resume_request` відновлює prompt поточного stage, включно з `EDIT_MENU`, документами, recipient choice та confirmation. Відмова від cancel повертає exact попередній stage; підтверджений cancel очищає request state і тимчасові document/media sequence keys, а persistent applicant і military-contact profiles залишаються.

Успішний порядок для фізособи:

1. Стабілізувати `applicationId`, `confirmedAt` і початковий `sheetsRecorded` у Redis state.
2. Записати заявку в Google Sheets.
3. Зберегти `sheetsRecorded: true`.
4. Для фізособи зберегти Redis profile.
5. Зробити best-effort спробу надіслати WhatsApp success із тим самим ID.
6. Після завершеної реєстрації викликати `resetUserState()`; помилка фінальної доставки логується і не запускає повторну реєстрацію.

Для individual multi використовується окремий порядок:

1. Стабілізувати `applicationId`, `confirmedAt` і початковий `sheetsRecorded` у Redis state.
2. Finalizувати Drive files за `driveFileId` у hierarchy з фінальними applicant/beneficiary names і application-specific filenames.
3. Оновити `request.beneficiaries[*].documents` metadata та зберегти state.
4. Записати/відновити Sheets master + detail matrix block.
5. Застосувати detail document rich-text links, clickable master ID і detail row grouping.
6. Лише після повного multi persistence встановити `sheetsRecorded: true` і зберегти state.
7. Безпечно обробити profile тільки actual applicant: existing documents/timestamp зберегти; beneficiary profiles не створювати.
8. Зробити best-effort спробу надіслати WhatsApp success із тим самим ID.
9. Після завершеної реєстрації викликати `resetUserState()`.

До повного Drive + Sheets success state не очищається і success не надсилається. Retry повторно перевіряє idempotent Drive/Sheets operations.

Успішний порядок для ВЧ:

1. Стабілізувати `applicationId`, `confirmedAt` і початковий `sheetsRecorded` у Redis state.
2. Виконати explicit-range Sheets write або existing-ID detection усередині writer lease.
3. Встановити `sheetsRecorded: true` і зберегти state.
4. Перемістити/перейменувати official-request Drive files за фінальним `request.data.name`.
5. Оновити `request.documents.official_request` і зберегти state.
6. Оновити military document rich-text links у Sheets H.
7. Зберегти military contact profile з фінальним ПІБ.
8. Зробити best-effort спробу надіслати WhatsApp success із тим самим ID.
9. Після завершеної реєстрації викликати `resetUserState()`.

При помилці Sheets, Drive finalize або military Sheets H update state не очищається і success не надсилається. `applicationId` не генерується в `sendText`/`sendMessage` і лишається стабільним між retry.

## IMPLEMENTED: Redis та application ID

Redis (`REDIS_URL`) зберігає:

- `wa:user:<phone>` — розмовний state, TTL 7 днів;
- `wa:profile:<phone>` — persistent profile фізособи без TTL;
- `wa:military-contact:<phone>` — незалежний persistent profile відповідальної особи ВЧ без TTL (`phone`, canonical `name`, `createdAt`, `updatedAt`); номер ВЧ не зберігається;
- `requests:counter:<YYYY-MM>` — місячний лічильник заявок за `Europe/Kyiv`;
- `wa:media:<phone>:<mediaId>` — media upload claim на 10 хвилин;
- `wa:doc-ack:<phone>:<documentLabel>` — single claim кнопки «Готово»; multi semantic scope — `multi:<beneficiaryIndex>:<documentKey>` під тим самим reset-compatible prefix;
- `wa:doc-seq:<phone>:<documentKey>` — single атомарна нумерація; multi scope — `multi:<beneficiaryIndex>:<documentKey>`.
- `wa:confirmation:<phone>` — confirmation lease з owner token, TTL 2 хвилини та heartbeat;
- `sheets:writer:<spreadsheetId>:<sheetId>` — міжпроцесний Sheets writer lease з owner token, TTL 2 хвилини та heartbeat.

`applicationId` має формат `YYYY-MM-NNNN`, наприклад `2026-10-0001`. Період `YYYY-MM` фіксується один раз за часовим поясом `Europe/Kyiv` при первинній генерації, а послідовність `0001`–`9999` починається заново кожного місяця. Redis атомарно виділяє номер у `requests:counter:YYYY-MM`, враховуючи максимальний sequence, уже записаний у всіх однойменних місячних Google Sheets. Тому після втрати counter наступний номер продовжується після Sheets maximum; retry використовує стабільний `applicationId` зі state.

Під час confirmation request state містить `applicationId`, `confirmedAt` (повний ISO timestamp) і `sheetsRecorded`. У Sheets `confirmedAt` відображається як `DD.MM.YYYY` у timezone `Europe/Kyiv`.

## IMPLEMENTED: Google Drive

Google Drive використовує OAuth2 через `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` і `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

Collection hierarchy залежить від request type:

```text
root/
├── ФІЗ/<ПІБ>/                                      (individual single)
├── ФІЗ/<applicant>/<beneficiary>/                  (individual multi)
└── ВЧ/<номер ВЧ>/                                  (military)
```

Після fix `5434e56` нові multi uploads одразу потрапляють у nested applicant/beneficiary folders. Попередня collection поведінка створювала зайві root-level `ФІЗ/<beneficiary> — Особа N/`; нові такі folders більше не створюються. Legacy folders глобально автоматично не скануються й не мігруються.

Приклади тимчасових upload-назв: `passport1.jpg`, `rnokpp1.pdf`, `military_id1.jpg`, `ubd1.jpg`, `official_request1.pdf`. Для `document` розширення береться з filename; інакше визначається з MIME type або є `.bin`. Імена папок і файлів санітизуються.

У `request.documents.<documentKey>[]` зберігаються `mediaId`, WhatsApp type, `receivedAt`, `driveFileId`, `driveUrl` і `fileName`.

Для multi ті самі metadata зберігаються у `request.beneficiaries[i].documents.<documentKey>[]`.

Після confirmation official-request documents ВЧ фіналізуються:

```text
ВЧ/
└── <номер ВЧ>/
    └── <фінальне ПІБ відповідальної особи>/
        ├── <applicationId>_official_request1.<ext>
        └── <applicationId>_official_request2.<ext>
```

Нумерація визначається порядком файлів у `request.documents.official_request`. Existing Drive resource переміщується й перейменовується без copy/re-upload, тому `driveFileId` залишається стабільним. Після finalize Redis metadata отримує фінальні `fileName`/актуальний `driveUrl`, а Sheets H показує ті самі filenames як окремі clickable links на відповідні Drive resources.

Individual multi final hierarchy:

```text
ФІЗ/
└── <фінальне ПІБ applicant>/
    ├── <фінальне ПІБ beneficiary #1>/
    ├── <фінальне ПІБ beneficiary #2>/
    └── ...
```

Recipient не впливає на hierarchy; `applicationId` не є folder level. Post-confirm finalizer лишається authoritative після applicant/beneficiary name edit: за stable `driveFileId` він move/rename existing resource без copy/re-upload. Final filenames:

```text
<applicationId>_person<1-based-index>_<docKey><fileIndex>.<ext>
```

Наприклад `2026-10-0123_person1_passport1.jpg` або `2026-10-0123_person2_rnokpp1.pdf`. `applicationId` є в кожному final filename, а `driveFileId` не змінюється. Actual old parent після move може бути прибраний лише якщо він порожній і не є `ФІЗ`/final applicant/final beneficiary folder; cleanup best-effort і не блокує успішну заявку. Global cleanup legacy folders не виконується.

## IMPLEMENTED: Google Sheets

### Monthly spreadsheet і листи

Поточний spreadsheet автоматично знаходиться або створюється у Drive root з назвою:

```text
Запити-<місяць>-<рік>
```

Timezone: `Europe/Kyiv`. Листи:

- `Фізособи`;
- `Військові частини`.

Row 1 і column A закріплені. Якщо spreadsheet/листи існують, структура перевіряється без перезапису існуючих даних.

### Headers

`Фізособи`:

```text
Статус | ID запиту | Дата | Потреба | ПІБ | Телефон | Паспорт | РНОКПП |
Військовий документ | УБД | Місто | Нова пошта | Інший отримувач |
ПІБ отримувача | Телефон отримувача
```

`Військові частини`:

```text
Статус | ID запиту | Дата | Потреба | ПІБ відповідальної особи | Телефон |
Номер ВЧ | Офіційний запит | Місто | Нова пошта | Інший отримувач |
ПІБ отримувача | Телефон отримувача
```

### Статуси

Для `A2:A` обох листів встановлено strict dropdown:

- `Нова` — світло-блакитний;
- `В роботі` — світло-жовтий;
- `Зібрано` — світло-зелений;
- `Відхилено` — світло-червоний.

Default для нової заявки: `Нова`. Conditional formatting rules не дублюються при повторному ensure structure.

### Запис заявок і документи

При confirmation заявка записується у відповідний лист. Усередині writer lease повторно перевіряється exact `applicationId` у `B2:B`; retry не має створювати другий master row.

У document cells raw Drive URLs не показуються. Показуються filenames в одній клітинці, наприклад:

```text
passport1.jpg
passport2.jpg
```

Кожне filename є окремим clickable rich-text hyperlink на відповідний Drive file. Це працює і для одного, і для кількох файлів.

Visible text у колонці B залишається exact `applicationId`, наприклад `2026-10-0001`, і автоматично стає clickable hyperlink на signed HTML request card. URL будується існуючим `buildRequestCardUrl()` із canonical production URL; raw URL та окрема колонка «Картка» не показуються.

### Individual multi master/detail

Single фізособа лишається одним current A:O row. Multi записується як один master row і N detail rows одразу під ним; detail rows grouped/collapsible, master у group не входить. Колонки A:O не змінені.

Master mapping:

```text
A status | B real/clickable applicationId | C date | D need |
E applicant name | F applicant phone | G:J blank |
K city | L Nova Poshta | M:O current recipient semantics
```

Detail mapping:

```text
A blank | B "Особа 1", "Особа 2", ... | C:D blank |
E beneficiary name | F beneficiary phone |
G passport | H rnokpp | I military_id | J ubd або blank | K:O blank
```

Detail document cells показують filenames із окремими clickable Drive rich-text links для кожного файла. Тільки master B має real `applicationId` і request-card link. `Особа N` не є application ID, не підписується, не використовується для duplicate lookup і maintenance endpoint пропускає такі labels.

Master + details первинно записуються одним explicit matrix write. Retry шукає exact master `applicationId` у B, не створює duplicate master, може дозаповнити відсутній suffix detail block, повторно застосовує rich-text/master link і перевіряє grouping без збільшення depth. Неконсистентний detail block дає safe error без перезапису сусідньої заявки. `sheetsRecorded: true` встановлюється лише після rows, formatting, clickable master ID і grouping.

Актуальний Sheets writer не використовує `values.append(... INSERT_ROWS)`: single і multi writes серіалізуються Redis lease за `spreadsheetId + sheetId`, визначають наступний explicit вільний range і записують його через `values.update()`. Multi master + details записуються одним matrix write. Перед записом target rows мають бути порожні й поза існуючими groups; після запису master/detail labels верифікуються. Group створюється лише для exact detail range, а overlapping/nested або неоднозначна структура дає safe error без автоматичного виправлення даних. Retry дописує лише перевірений порожній suffix detail rows.

## IMPLEMENTED: Printable request card

Endpoint:

```text
GET /api/request-card?id=<APPLICATION_ID>&sig=<HMAC>
```

Security:

- `REQUEST_CARD_SIGNING_SECRET`;
- HMAC-SHA256 від exact `applicationId`;
- `timingSafeEqual`;
- signature перевіряється до Google lookup;
- `Cache-Control: private, no-store` і `Referrer-Policy: no-referrer`;
- standalone HTML/CSS, без external CSS/JS/CDN.

Signed URL є permanent bearer link: той, хто отримав URL, може відкрити картку.

Lookup read-only, не викликає `getOrCreateCurrentMonthSpreadsheet()`. Період береться безпосередньо з `YYYY-MM` у ID; пошук охоплює всі spreadsheets з відповідною місячною назвою, обидва листи та exact значення у column B. `not_found` дає HTTP 404, справжній duplicate — 409, invalid data — 422, інтеграційна помилка — 500.

Картка містить exact application ID, ПІБ, дату, номер ВЧ (лише для ВЧ), потребу, порожній блок «Комплектація / примітки», фактичного отримувача, телефон, місто та Нову пошту. Вона не показує Sheets status або Drive URLs.

Картка printable A4 portrait, має screen-only кнопку «Друкувати» та покращений office-friendly дизайн. Shipping block оптимізований для copy/paste:

```text
Отримувач: ...
Телефон: ...
Місто: ...
Нова пошта: ...
```

Поточний дизайн функціональний; подальше UI polishing можливе, але не є пріоритетом.

Для multi request-card lookup знаходить exact master `applicationId`, читає безпосередньо наступні `Особа 1`, `Особа 2`, … detail rows і відображає кожного beneficiary: index, ПІБ, phone та позначки наявності `passport`, `rnokpp`, `military_id`, `ubd`. Картка не показує самі filenames або Drive links.

## TEMPORARY / CURRENTLY RETAINED FOR TESTING

`GET /api/request-card-links-test?token=<TEST_SECRET>`:

- захищений тим самим `REQUEST_CARD_TEST_SECRET` через `timingSafeEqual`;
- явно накладає clickable request-card links на valid IDs у колонці B обох листів current monthly spreadsheet;
- пропускає вже правильні links і не змінює заявки чи інші колонки;
- повертає лише лічильники `updated`, `alreadyCorrect`, `skipped`, без IDs, персональних даних або signed URLs.

Цей endpoint наразі свідомо залишається як repair route для ширшого періоду тестування. Його cleanup буде окремим пізнішим рішенням; `REQUEST_CARD_TEST_SECRET` залишається актуальним environment variable.

## CURRENT INFRASTRUCTURE: production WhatsApp / Coexistence

Onboarding production number ще **не завершений**. Цільова модель — WhatsApp Business App + Cloud API Coexistence через official Embedded Signup / WhatsApp Business App onboarding, щоб бот працював через Cloud API, оператор — через WhatsApp Business або supported linked client, а messaging history mirror-илась.

### Meta Embedded Signup callback

**IMPLEMENTED:** `GET /api/meta/oauth-callback` — окремий Vercel endpoint для Meta-hosted Embedded Signup OAuth callback. Він отримує query-параметри `code`, `error` і `error_description`:

- за наявності `error` повертає HTML-відповідь 400 і пише діагностичний запис без code;
- без `code` повертає HTML-відповідь 400;
- з `code` підтверджує успішне отримання HTML-відповіддю 200 і логує лише `hasCode: true`.

Endpoint наразі **не** обмінює authorization code на token, не зберігає code, не читає Google/Redis та не змінює WhatsApp webhook/state machine. Подальше використання code потребує окремої погодженої задачі.

### Vercel Hobby serverless limit

Vercel Hobby має ліміт 12 Serverless Functions на deployment. Застарілі одноразові production-test routes `api/drive-test.js`, `api/drive-upload-test.js`, `api/sheets-test.js` і `api/request-card-test-url.js` видалені. Production helpers винесені з `api/lib/` у кореневий `lib/`, тому під `api/` залишаються лише HTTP endpoint-файли. Видалені Drive routes перевіряли Drive root та створювали `_TEST_MONSTRIV_BOT/drive-test.txt`; production Drive upload уже підтверджений реальними WhatsApp-документами. Не відновлювати ці endpoints без окремої потреби й перевірки function budget.

Meta app: `Monstriv Request`. Tech Provider path активований.

Поточний blocker: старий Business Portfolio `BikePride Extreme` не має завершених Business Verification та App Review і не планується як production owner. Правильна business entity — БФ «Корпорація Монстрів». Очікується admin/business access до Meta/Facebook assets фонду.

Точка продовження:

```text
отримати доступ до Business Portfolio БФ
→ аудит current Meta structure
→ визначити ownership/access для Monstriv Request/WABA
→ пройти verification/review від правильної організації
→ продовжити Coexistence onboarding
```

Production number зараз залишається у WhatsApp Business App. Його не можна deregister/delete або мігрувати звичайним Cloud API flow без окремого погодженого плану.

Operator handoff залишається high priority, але залежить від завершення production WhatsApp/Coexistence onboarding. Current `OPERATOR` state лише фіксує стан і повідомляє користувача; реальної operator queue/inbox integration ще немає.

## Стан перевірок на 14.10.2026

### Підтверджено ручним тестуванням

- мультиперсональна заявка успішно зареєстрована;
- master/detail rows і group лише для detail rows перевірені в Google Sheets;
- confirmation UX показує спочатку повідомлення про обробку, потім success, без суперечливих busy/retry messages;
- спостережуваний час однієї реєстрації — приблизно 25–30 секунд; це не SLA, не timeout і не гарантія;
- «Ні» на confirmation відкриває list menu редагування;
- редагування полів і збереження змін перевірені;
- ВЧ-заявка зі збереженим canonical contact name працює;
- ВЧ-заявка зі збереженим отримувачем працює;
- ВЧ-заявка з іншим отримувачем працює.

### Автоматизовані локальні перевірки

На актуальному HEAD перед цим documentation update `node --test` проходив 49/49 тестів. Suite включає confirmation claims/lifecycle, application ID allocation, Drive-copy idempotency mocks, Sheets writer/master-detail recovery, edit-menu list payload і navigation recovery. Це mock/local coverage, а не підтвердження доступності чи exactly-once поведінки зовнішніх сервісів.

Інші сценарії не слід вважати ручно перевіреними лише на підставі коду або mock-тестів.

## PLANNED

### Інші майбутні задачі

- inventory marker logic;
- production WhatsApp Coexistence onboarding від правильної business entity;
- реальна operator message queue / handoff після onboarding;
- cleanup temporary request-card test endpoints пізніше;
- conservative cleanup legacy root-level multi Drive folders лише за потреби та після dry-run.

## KNOWN RISKS

1. Redis leases серіалізують confirmation і Sheets writer між Vercel invocations, але ownership check не може скасувати HTTP-запит, який уже виконується в момент втрати lease. Це не повна exactly-once семантика зовнішніх API.
2. WhatsApp може прийняти повідомлення, навіть якщо HTTP-запит завершився timeout. Фінальна success-доставка не має transactional outbox/status reconciliation; код уникає суперечливого retry, але користувач у рідкісному випадку може не побачити success.
3. Окремого загального deduplication key для кожного WhatsApp message ID немає. Confirmation claim серіалізує confirm callbacks; media upload і document acknowledgement мають власні claims. Глобальна дедуплікація без crash-recovery дизайну могла б заблокувати законний retry.
4. Permanent signed request-card URLs — bearer links без expiry або revocation per link.
5. ФІЗ Drive folders групуються за ПІБ: різні люди з однаковим ПІБ потенційно можуть потрапити в одну папку.
6. Temporary `request-card-links-test` endpoint є bearer-token maintenance route і має бути видалений окремим рішенням після завершення тестування.
7. Legacy root-level `ФІЗ/<beneficiary> — Особа N/` folders не мігруються автоматично; нові uploads їх не створюють.
8. В `OPERATOR` немає реальної черги або inbox integration.

## Environment variables

- WhatsApp: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WEBHOOK_VERIFY_TOKEN`.
- Redis: `REDIS_URL`.
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
- Request card: `REQUEST_CARD_SIGNING_SECRET`, `REQUEST_CARD_TEST_SECRET`.
- Vercel system variable: `VERCEL_PROJECT_PRODUCTION_URL` для canonical production URL.

Не записувати значення secrets у код, Git або документацію.

## Development history

Актуальний code HEAD перед локальним documentation update:

```text
d264820 fix: use WhatsApp list for request editing menu
```

Останні milestones: multi saved-applicant document reuse і safe confirmation (`c24a2e9`), Kyiv monthly application IDs (`a96ab97`), Redis-serialized explicit-range Sheets writer (`2f57721`), suppression conflicting confirmation messages (`ff0dffb`) та WhatsApp list edit menu (`d264820`). Раніше реалізовано military contact profile, clickable request-card IDs, first-contact UX, military Drive/Sheets finalization, individual multi flow, printable multi request card і Meta Embedded Signup callback.
