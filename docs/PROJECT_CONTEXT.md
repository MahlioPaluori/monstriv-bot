# Monstriv Bot — project context

## Статус і джерела істини

Monstriv Bot — WhatsApp-бот для структурованого збору, документування й первинної реєстрації запитів від фізичних осіб і військових частин.

- **IMPLEMENTED** — підтверджено поточним кодом у `main`.
- **PLANNED** — погоджений наступний крок, ще не реалізований.
- **KNOWN RISK** — відома технічна або процесна межа поточної реалізації.

Код — authoritative source фактичної поведінки. Цей документ — business/project context. Production workflow: local VS Code → checks → commit → push `main` → Vercel deployment. GitHub `main` є source of truth для production deployment, але фактичний live deployment слід підтверджувати окремо.

## IMPLEMENTED: WhatsApp flows

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

Поточний flow:

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

Отже після `official_request` ВЧ **не** переходить напряму до confirmation. Delivery fields для ВЧ використовують ті самі states, що й фізособа, і доступні в edit flow. ВЧ profile повторного користувача поки не зберігається.

### Confirmation

У summary показуються тип, ПІБ, телефон, номер ВЧ (за потреби), доставка, кількість документів і потреба. Користувач підтверджує або переходить до edit flow.

Успішний порядок операцій:

1. Стабілізувати `applicationId`, `confirmedAt` і початковий `sheetsRecorded` у Redis state.
2. Записати заявку в Google Sheets.
3. Зберегти `sheetsRecorded: true`.
4. Для фізособи зберегти Redis profile.
5. Надіслати WhatsApp success із тим самим ID.
6. Викликати `resetUserState()`.

При помилці Sheets state не очищається, а користувач може повторити confirm. `applicationId` не генерується в `sendText`/`sendMessage` і лишається стабільним між retry.

## IMPLEMENTED: Redis та application ID

Redis (`REDIS_URL`) зберігає:

- `wa:user:<phone>` — розмовний state, TTL 7 днів;
- `wa:profile:<phone>` — profile фізособи;
- `requests:counter:<UTC-рік>` — лічильник заявок;
- `wa:media:<phone>:<mediaId>` — media upload claim на 10 хвилин;
- `wa:doc-ack:<phone>:<documentLabel>` — claim кнопки «Готово»;
- `wa:doc-seq:<phone>:<documentKey>` — атомарна нумерація файлів.

`applicationId` має формат `YYYY-NNNNNN`, наприклад `2026-000001`. Рік береться за UTC, а порядкова частина має щонайменше шість цифр.

Під час confirmation request state містить `applicationId`, `confirmedAt` (повний ISO timestamp) і `sheetsRecorded`. У Sheets `confirmedAt` відображається як `DD.MM.YYYY` у timezone `Europe/Kyiv`.

## IMPLEMENTED: Google Drive

Google Drive використовує OAuth2 через `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` і `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

Фактична структура зараз:

```text
root/
├── ФІЗ/<ПІБ>/
└── ВЧ/<номер ВЧ>/
```

Документи завантажуються безпосередньо в ці папки. Приклади назв: `passport1.jpg`, `rnokpp1.pdf`, `military_id1.jpg`, `ubd1.jpg`, `official_request1.pdf`. Для `document` розширення береться з filename; інакше визначається з MIME type або є `.bin`. Імена папок і файлів санітизуються.

У `request.documents.<documentKey>[]` зберігаються `mediaId`, WhatsApp type, `receivedAt`, `driveFileId`, `driveUrl` і `fileName`.

### PLANNED: Drive hierarchy для ВЧ

```text
ВЧ/
└── <номер ВЧ>/
    └── <canonical ПІБ відповідальної особи>/
```

Ця підпапка **ще не реалізована**. Вона залежить від стабільної canonical-ідентифікації відповідальної особи, щоб варіанти написання ПІБ не створювали різні папки.

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

## TEMPORARY: Request card test URL endpoint

`GET /api/request-card-test-url?id=<APPLICATION_ID>&token=<TEST_SECRET>` існує у `main`.

- перевіряє `REQUEST_CARD_TEST_SECRET` через `timingSafeEqual`;
- генерує signed request-card URL;
- не читає Sheets і не перевіряє існування заявки;
- не змінює дані.

**TODO:** видалити або додатково обмежити endpoint після запуску clickable IDs у Sheets.

## PLANNED

### Clickable request ID у Sheets

Окрема колонка «Картка» не планується. Visible value у колонці `ID запиту` має стати clickable hyperlink на signed HTML request card. Visible text лишається exact application ID, наприклад `2026-000001`, без префіксів.

### Military contact profile

Після першої успішної ВЧ заявки потрібно зберігати profile:

```text
WhatsApp phone → canonical/stable ПІБ відповідальної особи
```

При наступній ВЧ заявці з того самого WhatsApp phone бот не питає і не пропонує повторно ввести ПІБ: автоматично використовує profile і переходить до наступного потрібного кроку. Номер ВЧ не прив'язується назавжди до цього profile, бо одна людина може подавати заявки для різних ВЧ.

Ця задача передує planned Drive hierarchy `ВЧ/<номер ВЧ>/<canonical ПІБ відповідальної особи>/`.

### Інші майбутні задачі

- BAS reporting/export pipeline;
- inventory marker logic;
- реальна operator message queue / handoff.

## KNOWN RISKS

1. Два паралельні confirms теоретично можуть обидва пройти lookup-before-append і створити duplicate row.
2. Якщо базовий append успішний, а rich-text document formatting впаде, retry знайде ID і може не повторити formatting.
3. Permanent signed request-card URLs — bearer links.
4. UTC-рік application ID і `Europe/Kyiv` month spreadsheet мають новорічну межу; request-card lookup шукає рік ID і наступний рік.
5. ФІЗ Drive folders групуються за ПІБ: різні люди з однаковим ПІБ потенційно можуть потрапити в одну папку.
6. Temporary `request-card-test-url` потрібно прибрати або обмежити після завершення інтеграції clickable ID.
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
948dc42 Improve request card shipping copy format
```

Ключові недавні milestones: delivery flow для ВЧ (`37370fd`), Google Sheets monthly integration (`a7c4e12`), operator sheet structure (`480e61a`), Sheets append confirmed requests (`d816fd6`), printable request card (`5b60a60`) і подальші card UX improvements (`595a222`, `948dc42`).
