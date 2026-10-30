# Monstriv Bot — project context

## Статус і джерела істини

Monstriv Bot — WhatsApp-бот для структурованого збору, документування й первинної реєстрації запитів від фізичних осіб і військових частин.

- **IMPLEMENTED** — підтверджено поточним checked-out кодом; production status завжди звіряється окремо.
- **PLANNED** — погоджений наступний крок, ще не реалізований.
- **KNOWN RISK** — відома технічна або процесна межа поточної реалізації.

Код — authoritative source фактичної поведінки. Цей документ — business/project context. Production workflow: local VS Code → checks → commit → push `main` → Vercel deployment. GitHub `main` є source of truth для production deployment, але фактичний live deployment слід підтверджувати окремо.

Стан pre-release handoff на 30.10.2026:

- production branch `main`: `c3216ff731d16233133eb461dba4ad772592d89d`;
- підготовлений release branch `feature/message-optimization`: `1d33656c535c796b5d59ec9c10315a6c3d13bc50` (`feat: optimize WhatsApp request flow and document uploads`);
- release містить 19 файлів, опублікований на GitHub і пройшов 207/207 локальних тестів;
- release **ще не злито в `main` і не розгорнуто у production**; deployment заплановано окремо на нічний час.

## Архітектура

Проєкт — Node.js ESM (`"type": "module"`, Node.js `>=20`) для Vercel serverless. Процес не має надійної локальної пам'яті між invocations, тому conversation state, profiles, counters і distributed leases зберігаються в Redis.

- `api/webhook.js` — GET verification і POST webhook Meta WhatsApp, state machine, navigation, document intake та confirmation lifecycle.
- `lib/whatsapp.js` — WhatsApp Cloud API `v26.0`, text, reply-button і list messages.
- `lib/state.js` — Redis state/profile helpers, monthly counters, media/document claims, confirmation та Sheets writer leases.
- `lib/meta-media.js` — bounded streaming download WhatsApp media з перевірками Meta/HTTP metadata та контролем розміру.
- `lib/media-validation.js` — централізована MIME/structure/size validation, canonical extension і validation metadata.
- `lib/delivery-address.js` — combined-address marker/helpers і fallback classification для даних із Sheets.
- `lib/google-drive.js` — OAuth2 Drive client, папки, uploads, move/rename та idempotent copies.
- `lib/google-sheets.js` — monthly spreadsheets, single/multi writer, rich-text links, grouping і read-only request lookup.
- `api/request-card.js` — HMAC-захищена printable HTML-картка, дані для якої читаються з Sheets.
- `api/meta/oauth-callback.js` — обмежений callback Embedded Signup без token exchange.
- `test/*.test.js` — локальні production-function tests із mocks; реальні Google/Redis/WhatsApp ресурси не використовуються.

Основні зовнішні системи: WhatsApp Cloud API, Redis, Google Drive API, Google Sheets API, Vercel і GitHub. `package.json` має runtime dependencies `googleapis` та `redis`; окремого test framework немає, використовується `node:test`.

## IMPLEMENTED: WhatsApp flows

### Перший контакт

Для нового WhatsApp phone перша обрана дія не губиться під час створення Redis state:

```text
send_request → state initialization → один combined introduction/APPLICANT_TYPE interactive message
operator → state initialization → OPERATOR
довільний текст/інша допустима подія → один combined welcome/MAIN_MENU interactive message
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
→ CITY (combined address, `deliveryAddressFormat: "combined_v1"`)
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
→ CITY (combined address, `deliveryAddressFormat: "combined_v1"`)
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

Документи фізособи збираються послідовно: `passport`, `rnokpp`, `military_id`, необов'язковий `ubd`. Для кожного типу підтримано один або кілька WhatsApp `image`/`document`, але вміст допускається лише згідно з політикою Secure Media Upload нижче. Успішне збереження кожного файла не створює окремого WhatsApp-повідомлення. Кнопка «Готово» переходить далі лише після щонайменше одного успішно зареєстрованого файла; УБД можна пропустити до або після завантаження.

Поточні `document_done`/`document_skip` IDs містять атомарно збережений 12-hex `documentActionToken`; multi IDs додатково містять beneficiary index і document key. Token стабільний при повторному показі того самого prompt і змінюється при переході до наступного document step або нової заявки. Legacy callback дозволяється лише для state, де token ще відсутній. Stale/malformed кнопки не просувають flow, а beneficiary name/phone не є Redis identity.

Ролі строго розділені:

- applicant — `request.data.name`/`request.data.phone`, actual WhatsApp sender, для якого може існувати persistent profile;
- beneficiary — `request.beneficiaries[i]`, тимчасова сутність лише конкретної multi-заявки;
- recipient — `request.data.recipientName`/`request.data.recipientPhone`, delivery-only role.

Beneficiary phone required і validated, але не використовується для profile lookup/save та не створює beneficiary profile. Якщо колишній beneficiary пізніше звернеться зі свого WhatsApp `from` без existing applicant profile, він проходить new applicant flow і завантажує documents заново.

Для returning applicant за WhatsApp phone існує persistent Redis profile. Бот пропонує «Збережені дані» або «Ввести заново». При single повторно використовуються profile data і лише валідовані documents; якщо documents старші за 365 днів, користувач може залишити їх або завантажити актуальні. Legacy saved documents без актуальної validation metadata не використовуються: бот просить завантажити пакет повторно.

У multi-flow після вибору «Збережені дані», кількості осіб і наявності повного saved package бот питає, чи входить applicant до числа beneficiaries. Якщо ні — всі packages збираються заново. Якщо так — applicant стає beneficiary №1 (`isApplicant: true`): актуальні saved documents копіюються після confirmation в application-specific files, а оригінальні canonical profile files не переміщуються й не перейменовуються. Для documents старших за 365 днів окремий multi-stage пропонує `multi_saved_use` або `multi_saved_replace`. У replace-path новий package applicant після успішного confirmation копіюється в стабільні canonical files і оновлює лише applicant profile; documents інших beneficiaries ніколи не стають profile documents. Якщо попереднього profile немає, звичайний multi не створює misleading saved-document profile з beneficiary documents.

### Secure Media Upload

Secure Media Upload завершено, опубліковано й успішно перевірено в production. Єдина allowlist-політика в `lib/media-validation.js`:

- JPEG — `image/jpeg`;
- PNG — `image/png`;
- HEIC — `image/heic`;
- HEIF — `image/heif`;
- PDF — `application/pdf`;
- максимальний розмір кожного файла — 5 MiB (`5 * 1024 * 1024` байтів).

`downloadWhatsAppMedia()` у `lib/meta-media.js` перевіряє MIME і `file_size` з Meta media metadata, HTTP `Content-Type`/`Content-Length`, завантажує response bounded stream та контролює фактичний розмір. Не використовується необмежений `response.arrayBuffer()`. Після download `validateMediaBuffer()` перевіряє заявлений MIME і фактичну структуру JPEG, PNG, ISO BMFF HEIC/HEIF або PDF. Filename extension не є джерелом довіри: validation повертає canonical extension для Drive filename.

У document metadata зберігається validation object: `version`, canonical MIME, extension, size, SHA-256 і dimensions для форматів, де їх підтримано. Некоректний або завеликий файл відхиляється до Google Drive upload, не додається до Redis documents і надалі не потрапляє в Sheets. Поточний document stage зберігається, тому користувач може надіслати коректний файл повторно.

Fail-closed захист діє у двох точках: `restartRequestWithUnvalidatedDocuments()` централізовано перевіряє документи одразу після читання Redis state, а `assertRequestDocumentsHaveValidation()` повторює перевірку безпосередньо перед confirmation/finalization side effects. Це охоплює individual single, individual multi та military flows, retries і saved-document reuse. Legacy Redis states або saved documents без нової validation metadata не мігруються і не копіюються: поточна тестова заявка безпечно перезапускається на збір даних/документів, а користувачу пояснюється потреба повторного завантаження.

Усі п'ять document prompts — паспорт, РНОКПП, військово-обліковий документ, посвідчення УБД та офіційний лист ВЧ — повідомляють про ліміт 5 МБ. Ті самі prompts використовуються при повторному показі кроку, зокрема після `/menu` → `resume_request`.

Release `1d33656` додає upload idempotency/fencing поверх validation pipeline:

- SHA-256 від внутрішнього scope та WhatsApp message ID зберігається у Drive `appProperties` як `monstrivIncomingUpload` без персональних даних;
- перед Drive create виконується marker lookup; після неоднозначного create lookup повторюється, і знайдений file ID використовується для Redis completion;
- Redis upload owner token, heartbeat і ownership checks огороджують side effects перед create, після create та перед completion;
- pending upload marker живе до 15 хвилин (`DOCUMENT_UPLOAD_PENDING_TTL_SECONDS`) і не дозволяє «Готово» просунути stage, поки зовнішній create може бути незавершеним;
- подвійний callback «Готово», повторна webhook delivery і паралельний upload не повинні вдруге змінити document context;
- legacy state без `documentActionToken` після першого успішного upload отримує один актуальний interactive prompt; token створюється атомарно, повторна доставка не дублює prompt;
- при однозначній Drive-помилці користувач отримує один interactive retry prompt, stage і попередні файли зберігаються; при неоднозначному результаті повідомлення не стверджує, що файл втрачено.

Помилка неправильного типу повідомлення тепер об'єднується з актуальною document instruction в одному interactive prompt. Військово-обліковий prompt просить фото військового квитка, посвідчення офіцера або службового посвідчення; для військового квитка потрібні перша сторінка та розділ 17, після всіх фото користувач натискає «Готово».

Під час завершення задачі автоматичний suite пройшов 68/68 тестів; Secure Media Upload окремо успішно перевірено в production. Старі тестові заявки не потребують міграції, додаткове очищення Redis або Google Drive не планується.

### Військова частина

Для нового contact поточний flow:

```text
APPLICANT_TYPE
→ IDENTIFICATION (ПІБ відповідальної особи)
→ MILITARY_UNIT_NUMBER
→ REQUEST_TYPE
→ DOCUMENTS (official_request)
→ CITY (combined address, `deliveryAddressFormat: "combined_v1"`)
→ RECIPIENT_CHOICE
→ RECIPIENT_NAME → RECIPIENT_PHONE  (лише якщо інший отримувач)
→ CONFIRMATION
```

Отже після `official_request` ВЧ **не** переходить напряму до confirmation. Delivery fields для ВЧ використовують ті самі states, що й фізособа, і доступні в edit flow.

Після першої успішно підтвердженої ВЧ-заявки persistent profile `wa:military-contact:<phone>` зберігає canonical ПІБ відповідальної особи. Номер ВЧ у profile не входить. При наступному виборі ВЧ з того самого phone бот автоматично встановлює збережене ПІБ і переходить прямо до `MILITARY_UNIT_NUMBER`. Після введення номера ВЧ бот переходить у `REQUEST_TYPE` і показує той самий prompt потреби, що й для фізособи: «Дякуємо. Тепер, напишіть, будь ласка, що Вам потрібно». Якщо у confirmation через `edit_name` введено інше ПІБ, після успішного підтвердження саме воно стає новим canonical name.

### Адреса доставки

Новий workflow однаковий для individual single, individual multi та military: бот показує один prompt «Адреса доставки», а користувач надсилає повну адресу одним повідомленням. Введене значення, включно з переносами рядків, зберігається в `request.data.city`; `request.data.novaPoshtaBranch` лишається порожнім, а `request.data.deliveryAddressFormat` має значення `"combined_v1"`. Marker встановлюється до першого combined prompt. `edit_city` і legacy `edit_np` відкривають те саме combined edit field і повертають заявку до confirmation.

Сумісність із незавершеними заявками збережена: старий `CITY` без marker приймає місто й переходить у `NOVA_POSHTA_BRANCH`; state, який уже очікує `NOVA_POSHTA_BRANCH`, продовжує старий двоетапний flow. Введені дані не очищаються. Повторний webhook обробляється відповідно до актуального stage.

Google Sheets schema не змінена. Для нового workflow повна адреса пишеться в чинну колонку «Місто», а «Нова пошта» лишається порожньою. Request card показує одне поле «Адреса доставки» і зберігає переноси рядків. Для історичних даних із Sheets fallback fail-safe: непорожня «Нова пошта» означає legacy city/branch; якщо «Нова пошта» порожня, а «Місто» заповнене, картка показує combined address. Явний `deliveryAddressFormat: "combined_v1"`, якщо доступний генератору, має пріоритет.

### Оптимізація вихідних повідомлень

Release `1d33656` зменшує кількість API-відправлень без зміни button IDs або state transitions:

- перший контакт: welcome і main menu об'єднані в один interactive message;
- новий `send_request`: introduction і applicant type menu об'єднані в один interactive message; для вже routed state лишається стандартний applicant menu;
- `/menu` і `back_to_menu` з `OPERATOR`: повідомлення про повернення та main menu об'єднані;
- confirmed cancellation: результат скасування та main menu об'єднані після чинного Redis reset/reinitialization;
- неправильний тип document input: помилка та поточна instruction об'єднані;
- успішний file upload є мовчазним до натискання «Готово».

Сценарії оптимізації 5 і 6 — скорочення кількості повідомлень при registration failure без Sheets-запису та при confirmation claim-lost recovery — у release не реалізовані. Чинна fail-safe recovery поведінка не змінювалася.

### Confirmation

Single/ВЧ summary показує тип, ПІБ, телефон, номер ВЧ (за потреби), delivery, кількість documents і need. Multi summary надсилається частинами: applicant/need, окремий блок кожного beneficiary зі статусом/кількістю documents, потім спільний delivery block; confirmation buttons «Так» (`confirm_request`) і «Редагувати» (`edit_request`) з'являються після останньої частини. Користувач підтверджує або переходить до edit flow.

Перед зовнішніми confirmation operations handler атомарно захоплює Redis claim `wa:confirmation:<phone>` з унікальним owner token. TTL поновлюється heartbeat; ownership перевіряється навколо зовнішніх side effects, а release виконується лише owner. Після першого успішного claim користувач один раз отримує «⏳ Реєструємо вашу заявку. Будь ласка, зачекайте на підтвердження.». Конкурентний/повторний callback із `busy` не запускає другу обробку й не надсилає retry або failure messages.

При втраті claim старий handler не має права надсилати success/failure. Recovery prompt можливий лише якщо handler атомарно отримав новий claim, актуальний state усе ще `CONFIRMATION`, а exact application ID ще не знайдено у Sheets. При recoverable failure до запису в Sheets зберігаються stage, request data та стабільний application ID і повторно показуються `confirm_request`/`edit_request`. Якщо Sheets уже містить заявку, повторну реєстрацію не пропонують. Фінальна доставка WhatsApp не має exactly-once гарантії: Meta може прийняти повідомлення навіть при HTTP timeout, тому система уникає суперечливих success/failure/retry повідомлень, але не може довести фактичну доставку без окремого outbox/status reconciliation.

### Редагування і навігація

На confirmation «Редагувати» (`edit_request`) зберігає `stage = EDIT_MENU` і відкриває WhatsApp interactive list. Змінився лише видимий label колишньої кнопки «Ні»: callback ID та business behavior лишилися незмінними. List має один section і 5 полів для individual single, 6 для individual multi (`edit_beneficiary`) або military (`edit_unit_number`); row IDs не змінені. Webhook нормалізує `interactive.list_reply.id`, `interactive.button_reply.id` і legacy `button.payload`. Після зміни поля `showConfirmation()` знову зберігає `CONFIRMATION` і показує актуальне зведення; зміна applicant name синхронізує beneficiary №1, якщо `isApplicant === true`.

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

Приклади тимчасових upload-назв: `passport1.jpg`, `rnokpp1.pdf`, `military_id1.jpg`, `ubd1.jpg`, `official_request1.pdf`. Розширення береться з canonical validation result, а не з недовіреного filename. Імена папок і файлів санітизуються.

У `request.documents.<documentKey>[]` зберігаються `mediaId`, WhatsApp type, `receivedAt`, `driveFileId`, `driveUrl`, `fileName`, canonical `mimeType`, `fileSize` і validation metadata.

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

Detail document cells показують filenames із окремими clickable Drive rich-text links для кожного файла. Тільки master B має real `applicationId` і request-card link. `Особа N` не є application ID, не підписується й не використовується для duplicate lookup.

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

Lookup read-only і не створює monthly spreadsheets. Період береться безпосередньо з `YYYY-MM` у ID; пошук охоплює всі spreadsheets з відповідною місячною назвою, обидва листи та exact значення у column B. `not_found` дає HTTP 404, справжній duplicate — 409, invalid data — 422, інтеграційна помилка — 500.

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

## COMPLETED MAINTENANCE

Тимчасовий endpoint міграції clickable request-card IDs видалено після завершення ручної міграції старих Sheets rows. Для нових single і multi заявок production Sheets writer автоматично додає signed request-card link до exact `applicationId` у master row; окремий repair route для цього не потрібен.

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

## Стан перевірок і pre-release handoff

### Підтверджено ручним тестуванням

- мультиперсональна заявка успішно зареєстрована;
- master/detail rows і group лише для detail rows перевірені в Google Sheets;
- confirmation UX показує спочатку повідомлення про обробку, потім success, без суперечливих busy/retry messages;
- спостережуваний час однієї реєстрації — приблизно 25–30 секунд; це не SLA, не timeout і не гарантія;
- callback `edit_request` на confirmation відкриває list menu редагування; під час цієї ручної перевірки кнопка ще мала label «Ні», поточний UI показує «Редагувати»;
- редагування полів і збереження змін перевірені;
- ВЧ-заявка зі збереженим canonical contact name працює;
- ВЧ-заявка зі збереженим отримувачем працює;
- ВЧ-заявка з іншим отримувачем працює;
- Secure Media Upload успішно перевірено в production для актуального validation pipeline.

### Автоматизовані локальні перевірки

Історичні checkpoints: після Secure Media Upload `node --test` проходив 68/68, а після ранніх document/navigation regressions — 94/94. Актуальний release `1d33656` станом на 30.10.2026 проходить **207/207** локальних тестів. Suite включає media validation і bounded download, legacy Redis-state safeguards, tokenized document prompts, upload lease/pending coordination, Drive-create idempotency mocks, confirmation claims/lifecycle, application ID allocation, Sheets writer/master-detail recovery, combined/legacy delivery address, request-card rendering, edit-menu/list payload, operator silence та navigation recovery.

Це mock/local coverage, а не підтвердження доступності чи exactly-once поведінки зовнішніх сервісів. Для release `1d33656` реальні Redis, Google Drive, Google Sheets і WhatsApp інтеграції ще не перевірялися; попередня production-перевірка Secure Media Upload стосується старішого production baseline.

Інші сценарії не слід вважати ручно перевіреними лише на підставі коду або mock-тестів.

## PLANNED

### Інші майбутні задачі

- inventory marker logic;
- production WhatsApp Coexistence onboarding від правильної business entity;
- реальна operator message queue / handoff після onboarding;
- conservative cleanup legacy root-level multi Drive folders лише за потреби та після dry-run.

## KNOWN RISKS

1. Redis leases серіалізують confirmation і Sheets writer між Vercel invocations, але ownership check не може скасувати HTTP-запит, який уже виконується в момент втрати lease. Це не повна exactly-once семантика зовнішніх API.
2. WhatsApp може прийняти повідомлення, навіть якщо HTTP-запит завершився timeout. Фінальна success-доставка не має transactional outbox/status reconciliation; код уникає суперечливого retry, але користувач у рідкісному випадку може не побачити success.
3. Окремого загального deduplication key для кожного WhatsApp message ID немає. Confirmation claim серіалізує confirm callbacks; media upload і document acknowledgement мають власні claims. Глобальна дедуплікація без crash-recovery дизайну могла б заблокувати законний retry.
4. Permanent signed request-card URLs — bearer links без expiry або revocation per link.
5. ФІЗ Drive folders групуються за ПІБ: різні люди з однаковим ПІБ потенційно можуть потрапити в одну папку.
6. Legacy root-level `ФІЗ/<beneficiary> — Особа N/` folders не мігруються автоматично; нові uploads їх не створюють.
7. В `OPERATOR` немає реальної черги або inbox integration.
8. Структурна перевірка дозволених media formats не замінює антивірусне сканування.
9. Приймання HEIC/HEIF залежить від фактичної підтримки цих media formats у Meta WhatsApp Cloud API; валідатор перевіряє ISO BMFF container/brands, але не декодує зображення повністю.
10. PDF validation перевіряє структуру й відхиляє відомі небезпечні конструкції, але не є повноцінним malware scanner або Content Disarm and Reconstruction (CDR).
11. Ізольованого integration environment не підтверджено. Vercel Preview може отримати production credentials; код не перемикає Redis, Google root folder або WhatsApp number за `VERCEL_ENV`.
12. POST `/api/webhook` наразі не перевіряє Meta `X-Hub-Signature-256`; GET verification token не автентифікує POST delivery.
13. Message-count оптимізації registration failure без Sheets-запису та claim-lost recovery (сценарії 5 і 6) не реалізовані.
14. Pending upload marker має обмежене 15-хвилинне вікно. Ownership fencing не може скасувати Drive HTTP create, який уже почав виконуватися; екстремально довгий зовнішній запит може пережити це вікно.
15. Rollback лише коду до `c3216ff` може бути несумісним із Redis states, уже створеними release `1d33656` (`documentActionToken`, combined delivery marker та нова upload coordination). Перед rollback потрібна оцінка активних заявок; Redis не очищати автоматично.

## Environment variables

- WhatsApp: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WEBHOOK_VERIFY_TOKEN`.
- Redis: `REDIS_URL`.
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
- Request card: `REQUEST_CARD_SIGNING_SECRET`.
- Vercel system variable: `VERCEL_PROJECT_PRODUCTION_URL` для canonical production URL.

Не записувати значення secrets у код, Git або документацію.

## Development history

Production baseline перед deployment release:

```text
c3216ff731d16233133eb461dba4ad772592d89d fix: preserve operator sheet dropdown validation
```

Підготовлений і опублікований feature release, ще не merged/deployed:

```text
1d33656c535c796b5d59ec9c10315a6c3d13bc50 feat: optimize WhatsApp request flow and document uploads
```

Останні milestones: multi saved-applicant document reuse і safe confirmation (`c24a2e9`), Kyiv monthly application IDs (`a96ab97`), Redis-serialized explicit-range Sheets writer (`2f57721`), suppression conflicting confirmation messages (`ff0dffb`), WhatsApp list edit menu (`d264820`), Secure Media Upload із legacy-state fail-closed enforcement (`889f7d4`), уточнений label confirmation-кнопки «Редагувати» (`23b2fbb`) та уніфікований prompt потреби для ВЧ й фізособи (`6c7b3fa`). Раніше реалізовано military contact profile, clickable request-card IDs, first-contact UX, military Drive/Sheets finalization, individual multi flow, printable multi request card і Meta Embedded Signup callback.

## Нічний deployment runbook для release `1d33656`

### Підготовка — production не змінюється

1. На домашньому комп'ютері відкрити наявний clone, перевірити чистий `git status --short`, виконати `git fetch origin --prune` і перейти на `feature/message-optimization`. Якщо локальної гілки немає: `git switch --track -c feature/message-optimization origin/feature/message-optimization`.
2. Виконати `git merge --ff-only origin/feature/message-optimization` і перевірити `git rev-parse HEAD`; очікується `1d33656c535c796b5d59ec9c10315a6c3d13bc50`.
3. Запустити `node --test`, syntax checks змінених JS-файлів і `git diff --check`.
4. Виконати `git fetch origin --prune`, перевірити `git rev-parse origin/main`; до погодженого deployment очікується `c3216ff731d16233133eb461dba4ad772592d89d`. Якщо SHA інший — зупинитися.
5. Перевірити `git diff --stat origin/main...origin/feature/message-optimization`, `git diff --name-status ...` і фактичний diff. Очікується один release commit і 19 файлів; `.gitignore`, env/config/secrets не повинні входити.

### Production-changing дії — лише після окремого підтвердження

6. У чистому worktree перейти на `main`, виконати `git merge --ff-only origin/main`, потім `git merge --ff-only origin/feature/message-optimization`. Переконатися, що HEAD дорівнює `1d33656c535c796b5d59ec9c10315a6c3d13bc50`.
7. Ще раз запустити тести й `git diff origin/main...HEAD --check`. Лише після окремого дозволу виконати `git push origin main`; force-push заборонений.
8. У Vercel перевірити production deployment: source branch `main`, commit `1d33656`, status `Ready`, відсутність build/runtime errors. Не вважати push доказом успішного deployment.
9. Виконати одну контрольну синтетичну заявку без персональних production-даних: перевірити welcome/navigation, upload одного й кількох файлів, «Готово», combined address, Sheets row/links, Drive files і signed request card. Врахувати, що окремого isolated integration environment немає.
10. При блокувальній помилці не очищати Redis/Drive/Sheets. Погоджений code rollback робити новим revert commit від `1d33656` у `main`, повторити тести й push лише з окремого дозволу. Простий redeploy старого commit або `git revert 1d33656` не гарантує сумісність активних Redis states, створених новою версією; спочатку оцінити `stage`, `documentActionToken`, pending uploads і `deliveryAddressFormat` без масового сканування чи запису.
