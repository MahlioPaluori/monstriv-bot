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
→ DOCUMENTS
→ CITY
→ NOVA_POSHTA_BRANCH
→ RECIPIENT_CHOICE
→ RECIPIENT_NAME → RECIPIENT_PHONE  (лише якщо інший отримувач)
→ CONFIRMATION
```

Документи фізособи збираються послідовно: `passport`, `rnokpp`, `military_id`, необов'язковий `ubd`. Для кожного типу підтримано один або кілька WhatsApp `image`/`document`. Кнопка «Готово» переходить далі лише після щонайменше одного файла; УБД можна пропустити до або після завантаження.

Для returning applicant за WhatsApp phone існує Redis profile. Бот пропонує «Збережені дані» або «Ввести заново». При використанні profile користувач вводить нову потребу; якщо документи старші за 365 днів, доступне рішення оновити їх. Edit flow дозволяє змінити ПІБ, потребу, місто, Нову пошту та дані отримувача; документи через edit menu не редагуються.

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

У summary показуються тип, ПІБ, телефон, номер ВЧ (за потреби), доставка, кількість документів і потреба. Користувач підтверджує або переходить до edit flow.

Успішний порядок для фізособи:

1. Стабілізувати `applicationId`, `confirmedAt` і початковий `sheetsRecorded` у Redis state.
2. Записати заявку в Google Sheets.
3. Зберегти `sheetsRecorded: true`.
4. Для фізособи зберегти Redis profile.
5. Надіслати WhatsApp success із тим самим ID.
6. Викликати `resetUserState()`.

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
- `wa:doc-ack:<phone>:<documentLabel>` — claim кнопки «Готово»;
- `wa:doc-seq:<phone>:<documentKey>` — атомарна нумерація файлів.

`applicationId` має формат `YYYY-NNNNNN`, наприклад `2026-000001`. Рік береться за UTC, а порядкова частина має щонайменше шість цифр.

Під час confirmation request state містить `applicationId`, `confirmedAt` (повний ISO timestamp) і `sheetsRecorded`. У Sheets `confirmedAt` відображається як `DD.MM.YYYY` у timezone `Europe/Kyiv`.

## IMPLEMENTED: Google Drive

Google Drive використовує OAuth2 через `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` і `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

До confirmation документи завантажуються за структурою:

```text
root/
├── ФІЗ/<ПІБ>/
└── ВЧ/<номер ВЧ>/
```

Приклади тимчасових upload-назв: `passport1.jpg`, `rnokpp1.pdf`, `military_id1.jpg`, `ubd1.jpg`, `official_request1.pdf`. Для `document` розширення береться з filename; інакше визначається з MIME type або є `.bin`. Імена папок і файлів санітизуються.

У `request.documents.<documentKey>[]` зберігаються `mediaId`, WhatsApp type, `receivedAt`, `driveFileId`, `driveUrl` і `fileName`.

Після confirmation official-request documents ВЧ фіналізуються:

```text
ВЧ/
└── <номер ВЧ>/
    └── <фінальне ПІБ відповідальної особи>/
        ├── <applicationId>_official_request1.<ext>
        └── <applicationId>_official_request2.<ext>
```

Нумерація визначається порядком файлів у `request.documents.official_request`. Existing Drive resource переміщується й перейменовується без copy/re-upload, тому `driveFileId` залишається стабільним. Після finalize Redis metadata отримує фінальні `fileName`/актуальний `driveUrl`, а Sheets H показує ті самі filenames як окремі clickable links на відповідні Drive resources.

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

## TEMPORARY / CURRENTLY RETAINED FOR TESTING

`GET /api/request-card-test-url?id=<APPLICATION_ID>&token=<TEST_SECRET>` існує у `main`.

- перевіряє `REQUEST_CARD_TEST_SECRET` через `timingSafeEqual`;
- генерує signed request-card URL;
- не читає Sheets і не перевіряє існування заявки;
- не змінює дані.

`GET /api/request-card-links-test?token=<TEST_SECRET>`:

- захищений тим самим `REQUEST_CARD_TEST_SECRET` через `timingSafeEqual`;
- явно накладає clickable request-card links на valid IDs у колонці B обох листів current monthly spreadsheet;
- пропускає вже правильні links і не змінює заявки чи інші колонки;
- повертає лише лічильники `updated`, `alreadyCorrect`, `skipped`, без IDs, персональних даних або signed URLs.

Обидва endpoints наразі свідомо залишаються для ширшого періоду тестування. Cleanup буде окремим пізнішим рішенням; `REQUEST_CARD_TEST_SECRET` залишається актуальним environment variable.

## PLANNED

### Інші майбутні задачі

- BAS reporting/export pipeline;
- inventory marker logic;
- реальна operator message queue / handoff.

## KNOWN RISKS

1. Два паралельні confirms теоретично можуть обидва пройти lookup-before-append і створити duplicate row.
2. Якщо базовий append фізособи успішний, а первинне rich-text document formatting впаде, retry знайде ID і може не повторити formatting; ВЧ document cell окремо оновлюється після Drive finalize.
3. Permanent signed request-card URLs — bearer links.
4. UTC-рік application ID і `Europe/Kyiv` month spreadsheet мають новорічну межу; request-card lookup шукає рік ID і наступний рік.
5. ФІЗ Drive folders групуються за ПІБ: різні люди з однаковим ПІБ потенційно можуть потрапити в одну папку.
6. Temporary testing endpoints є захищеними bearer-token routes і мають бути переглянуті окремо після завершення ширшого тестування.
7. Окремого загального deduplication key для кожного WhatsApp message ID немає; є media upload і document acknowledgement claims.

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
a29690f Finalize military request documents after confirmation
```

Ключові milestones після попереднього documentation sync `cab1cda`: npm lockfile/gitignore (`453300d`), military contact profile (`33d809e`), clickable request-card IDs і migration endpoint (`4d0797d`), first-contact UX (`75ac3e9`) та post-confirm military Drive/Sheets finalization (`a29690f`).
