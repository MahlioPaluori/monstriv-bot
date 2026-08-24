# Monstriv Bot — project context

## Статус і джерела істини

Monstriv Bot — WhatsApp-бот для структурованого збору, документування й первинної реєстрації запитів від фізичних осіб і військових частин.

- **IMPLEMENTED** — підтверджено поточним кодом у `main`.
- **PLANNED** — погоджений наступний крок, ще не реалізований.
- **KNOWN RISK** — відома технічна або процесна межа поточної реалізації.

Код — authoritative source фактичної поведінки. Цей документ — business/project context. Production workflow: local VS Code → checks → commit → push `main` → Vercel deployment. GitHub `main` є source of truth для production deployment, але фактичний live deployment слід підтверджувати окремо.

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

Для returning applicant за WhatsApp phone існує Redis profile. Бот пропонує «Збережені дані» або «Ввести заново». При single використовується current saved-document/delivery behavior; якщо documents старші за 365 днів, доступне рішення оновити їх. При multi reuse-иться лише applicant identity: saved applicant documents, delivery, recipient fields і applicant documents як beneficiary #1 не використовуються. Multi uploads не стають applicant saved documents і не оновлюють applicant document timestamp. Existing applicant profile documents/timestamp зберігаються; якщо profile не існує, multi не створює misleading saved-document profile з beneficiary documents.

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

Успішний порядок для фізособи:

1. Стабілізувати `applicationId`, `confirmedAt` і початковий `sheetsRecorded` у Redis state.
2. Записати заявку в Google Sheets.
3. Зберегти `sheetsRecorded: true`.
4. Для фізособи зберегти Redis profile.
5. Надіслати WhatsApp success із тим самим ID.
6. Викликати `resetUserState()`.

Для individual multi використовується окремий порядок:

1. Стабілізувати `applicationId`, `confirmedAt` і початковий `sheetsRecorded` у Redis state.
2. Finalizувати Drive files за `driveFileId` у hierarchy з фінальними applicant/beneficiary names і application-specific filenames.
3. Оновити `request.beneficiaries[*].documents` metadata та зберегти state.
4. Записати/відновити Sheets master + detail matrix block.
5. Застосувати detail document rich-text links, clickable master ID і detail row grouping.
6. Лише після повного multi persistence встановити `sheetsRecorded: true` і зберегти state.
7. Безпечно обробити profile тільки actual applicant: existing documents/timestamp зберегти; beneficiary profiles не створювати.
8. Надіслати WhatsApp success із тим самим ID.
9. Викликати `resetUserState()`.

До повного Drive + Sheets success state не очищається і success не надсилається. Retry повторно перевіряє idempotent Drive/Sheets operations.

Успішний порядок для ВЧ:

1. Стабілізувати `applicationId`, `confirmedAt` і початковий `sheetsRecorded` у Redis state.
2. Виконати Sheets append або existing-ID detection.
3. Встановити `sheetsRecorded: true` і зберегти state.
4. Перемістити/перейменувати official-request Drive files за фінальним `request.data.name`.
5. Оновити `request.documents.official_request` і зберегти state.
6. Оновити military document rich-text links у Sheets H.
7. Зберегти military contact profile з фінальним ПІБ.
8. Надіслати WhatsApp success із тим самим ID.
9. Викликати `resetUserState()`.

При помилці Sheets, Drive finalize або military Sheets H update state не очищається і success не надсилається. `applicationId` не генерується в `sendText`/`sendMessage` і лишається стабільним між retry.

## IMPLEMENTED: Redis та application ID

Redis (`REDIS_URL`) зберігає:

- `wa:user:<phone>` — розмовний state, TTL 7 днів;
- `wa:profile:<phone>` — persistent profile фізособи без TTL;
- `wa:military-contact:<phone>` — незалежний persistent profile відповідальної особи ВЧ без TTL (`phone`, canonical `name`, `createdAt`, `updatedAt`); номер ВЧ не зберігається;
- `requests:counter:<UTC-рік>` — лічильник заявок;
- `wa:media:<phone>:<mediaId>` — media upload claim на 10 хвилин;
- `wa:doc-ack:<phone>:<documentLabel>` — single claim кнопки «Готово»; multi semantic scope — `multi:<beneficiaryIndex>:<documentKey>` під тим самим reset-compatible prefix;
- `wa:doc-seq:<phone>:<documentKey>` — single атомарна нумерація; multi scope — `multi:<beneficiaryIndex>:<documentKey>`.

`applicationId` має формат `YYYY-NNNNNN`, наприклад `2026-000001`. Рік береться за UTC, а порядкова частина має щонайменше шість цифр.

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

Наприклад `2026-000123_person1_passport1.jpg` або `2026-000123_person2_rnokpp1.pdf`. `applicationId` є в кожному final filename, а `driveFileId` не змінюється. Actual old parent після move може бути прибраний лише якщо він порожній і не є `ФІЗ`/final applicant/final beneficiary folder; cleanup best-effort і не блокує успішну заявку. Global cleanup legacy folders не виконується.

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

При confirmation заявка записується у відповідний лист. Перед повторним append виконується lookup exact `applicationId` у `B2:B`; звичайний retry не має створювати другий рядок.

У document cells raw Drive URLs не показуються. Показуються filenames в одній клітинці, наприклад:

```text
passport1.jpg
passport2.jpg
```

Кожне filename є окремим clickable rich-text hyperlink на відповідний Drive file. Це працює і для одного, і для кількох файлів.

Visible text у колонці B залишається exact `applicationId`, наприклад `2026-000001`, і автоматично стає clickable hyperlink на signed HTML request card. URL будується існуючим `buildRequestCardUrl()` із canonical production URL; raw URL та окрема колонка «Картка» не показуються.

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

Master + details первинно записуються одним matrix append. Retry шукає exact master `applicationId` у B, не створює duplicate master, може дозаповнити відсутній suffix detail block, повторно застосовує rich-text/master link і перевіряє grouping без збільшення depth. Неконсистентний detail block дає safe error без перезапису сусідньої заявки. `sheetsRecorded: true` встановлюється лише після rows, formatting, clickable master ID і grouping.

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

Lookup read-only, не викликає `getOrCreateCurrentMonthSpreadsheet()`, шукає ID у column B листів `Фізособи` та `Військові частини`, враховує UTC/Kyiv year boundary і не вибирає duplicate ID автоматично.

Картка містить exact application ID без префіксів, ПІБ, дату, номер ВЧ (лише для ВЧ), потребу, порожній блок «Комплектація / примітки», фактичного отримувача, телефон, місто та Нову пошту. Вона не містить статус, документи або Drive links.

Картка printable A4 portrait, має screen-only кнопку «Друкувати» та покращений office-friendly дизайн. Shipping block оптимізований для copy/paste:

```text
Отримувач: ...
Телефон: ...
Місто: ...
Нова пошта: ...
```

Поточний дизайн функціональний; подальше UI polishing можливе, але не є пріоритетом.

Для multi request-card lookup знаходить exact master `applicationId`, ігнорує `Особа N` labels і читає applicant/need/delivery з master row, тому current HTML не падає та не показує detail beneficiary як applicant.

**NEXT / PLANNED limitation:** beneficiaries multi-заявки поки не відображаються в HTML request card.

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

## PLANNED

### Інші майбутні задачі

- inventory marker logic;
- multi beneficiaries у request-card HTML;
- production WhatsApp Coexistence onboarding від правильної business entity;
- реальна operator message queue / handoff після onboarding;
- cleanup temporary request-card test endpoints пізніше;
- conservative cleanup legacy root-level multi Drive folders лише за потреби та після dry-run.

## KNOWN RISKS

1. Два паралельні confirms теоретично можуть обидва пройти lookup-before-append і створити duplicate row.
2. Якщо базовий append фізособи успішний, а первинне rich-text document formatting впаде, retry знайде ID і може не повторити formatting; ВЧ document cell окремо оновлюється після Drive finalize.
3. Permanent signed request-card URLs — bearer links.
4. UTC-рік application ID і `Europe/Kyiv` month spreadsheet мають новорічну межу; request-card lookup шукає рік ID і наступний рік.
5. ФІЗ Drive folders групуються за ПІБ: різні люди з однаковим ПІБ потенційно можуть потрапити в одну папку.
6. Temporary testing endpoints є захищеними bearer-token routes і мають бути переглянуті окремо після завершення ширшого тестування.
7. Окремого загального deduplication key для кожного WhatsApp message ID немає; є media upload і document acknowledgement claims.
8. Legacy root-level `ФІЗ/<beneficiary> — Особа N/` folders, створені до `5434e56`, не мігруються глобально автоматично; нові uploads їх не створюють.
9. Multi beneficiaries поки не відображаються у printable request-card HTML.

## Environment variables

- WhatsApp: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WEBHOOK_VERIFY_TOKEN`.
- Redis: `REDIS_URL`.
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
- Request card: `REQUEST_CARD_SIGNING_SECRET`, `REQUEST_CARD_TEST_SECRET`.
- Vercel system variable: `VERCEL_PROJECT_PRODUCTION_URL` для canonical production URL.

Не записувати значення secrets у код, Git або документацію.

## Development history

Актуальний HEAD на момент оновлення документації:

```text
a52d18c Remove obsolete Vercel test endpoints
```

Ключові milestones після попереднього documentation sync `3ef4f46`: повний individual multi-package WhatsApp/state flow, Drive finalization і Sheets master/detail persistence (`8988c99`), nested multi collection routing із conservative empty-parent cleanup (`5434e56`), printable multi request card (`7618c88`), Meta Embedded Signup OAuth callback (`b2c7299`) та cleanup obsolete Drive test endpoints для Vercel Hobby function limit (`a52d18c`). Earlier milestones: military contact profile (`33d809e`), clickable request-card IDs (`4d0797d`), first-contact UX (`75ac3e9`) і military Drive/Sheets finalization (`a29690f`).
