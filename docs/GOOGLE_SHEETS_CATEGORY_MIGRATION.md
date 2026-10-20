# Google Sheets category migration

Цей одноразовий CLI переводить наявні місячні Google Sheets із legacy layout на layout із колонкою B `Категорія запиту`. Він не використовується webhook або confirmation flow.

## Передумови

Потрібні ті самі змінні середовища, що й production Google/Redis інтеграції:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_DRIVE_ROOT_FOLDER_ID`
- `REDIS_URL` — потрібна лише для `--apply`, щоб захопити production-compatible writer leases.

Значення secrets не передавати в командному рядку й не зберігати в репозиторії.

## Dry-run

Dry-run є read-only: він не створює backups, не змінює Sheets/Drive/Redis і не захоплює writer leases.

Усі місячні spreadsheets у робочій папці, включно з однойменними:

```powershell
node scripts/migrate-google-sheets-category.js --dry-run
```

Один файл для першої перевірки:

```powershell
node scripts/migrate-google-sheets-category.js --dry-run --spreadsheet-id "SPREADSHEET_ID"
```

Звіт містить ID/назву файла, layout обох робочих аркушів, master/detail counts, кількість links, formulas, filters, protected ranges і row groups, стан `Довідники` та блокувальні неоднозначності. Exit code `2` означає, що принаймні один файл заблокований для міграції.

## Apply

Apply дозволений лише з двома явними параметрами:

```powershell
node scripts/migrate-google-sheets-category.js --apply --confirm APPLY_CATEGORY_MIGRATION --spreadsheet-id "SPREADSHEET_ID"
```

Після успішної перевірки одного файла можна окремо погодити запуск для всіх місячних таблиць:

```powershell
node scripts/migrate-google-sheets-category.js --apply --confirm APPLY_CATEGORY_MIGRATION
```

Для кожного spreadsheet інструмент послідовно:

1. Захоплює Redis writer leases обох робочих аркушів.
2. Повторно читає заголовки під lease.
3. Створює й перевіряє Google Drive backup.
4. Для кожного legacy sheet вставляє цілу колонку B через `insertDimension` і записує заголовок.
5. Створює або перевіряє `Довідники`; точний старий список із 6 категорій оновлює до точного нового списку із 7, а невідомі ручні зміни блокують apply.
6. Налаштовує `ONE_OF_LIST` із 7 фіксованих категорій для `B2:B`; named range `MonstrivRequestCategories` залишається окремим структурним інваріантом.
7. Повторно перевіряє ID/detail sequence, значення, rich-text links, formulas, filters, protected ranges і row groups.
8. Лише після успішної перевірки переходить до наступного файла.

Повторний apply для повністю мігрованого й перевіреного файла повертає `already_migrated`: не вставляє ще одну колонку та не створює backup.

## Ручна перевірка результату

- у `Фізособи` та `Військові частини`: B має заголовок `Категорія запиту`, а application ID мають бути в C;
- значення, detail rows і групи рядків мають залишитися на місці;
- clickable ID та document links мають відкриватися;
- `Довідники` мають містити точний погоджений список із 7 категорій; невідомі ручні зміни потребують ручного рішення;
- dropdown у B2:B повинен мати `ONE_OF_LIST` із сімома категоріями у погодженому порядку;
- backup ID і назва повинні бути присутні у звіті apply.

Якщо структура невідома або перевірка після запису не проходить, інструмент зупиняється. Він не видаляє та не відновлює дані автоматично; recovery виконується вручну з перевіреного backup.

## Тимчасовий запуск у Vercel production

Коли Google/Redis credentials доступні лише у Vercel, використовується тимчасовий endpoint `api/google-sheets-migration.js`. Він не пов'язаний із WhatsApp webhook і має бути видалений після завершення міграції.

Перед deployment додати у Vercel Production два незалежні випадкові secrets:

- `SHEETS_MIGRATION_ADMIN_SECRET` — авторизація всіх запитів;
- `SHEETS_MIGRATION_APPLY_TOKEN` — додаткова авторизація лише apply.

Secrets передаються тільки HTTP-заголовками. Не додавати їх у URL, документацію, Git або логи.

### Production dry-run

Повний read-only аудит:

```powershell
$headers = @{ "X-Sheets-Migration-Admin-Secret" = $env:SHEETS_MIGRATION_ADMIN_SECRET }
Invoke-RestMethod -Method Get -Uri "https://YOUR_PRODUCTION_DOMAIN/api/google-sheets-migration" -Headers $headers
```

Один spreadsheet:

```powershell
$headers = @{ "X-Sheets-Migration-Admin-Secret" = $env:SHEETS_MIGRATION_ADMIN_SECRET }
Invoke-RestMethod -Method Get -Uri "https://YOUR_PRODUCTION_DOMAIN/api/google-sheets-migration?spreadsheetId=SPREADSHEET_ID" -Headers $headers
```

GET завжди означає `dry-run`; перемкнути його на apply параметром URL неможливо. Якщо повний dry-run перевищує HTTP timeout Vercel, він не продовжується у background: повторити перевірку окремо для кожного spreadsheet ID.

### Production apply одного файла

Endpoint навмисно не підтримує apply усіх spreadsheets за один запит:

```powershell
$headers = @{
  "X-Sheets-Migration-Admin-Secret" = $env:SHEETS_MIGRATION_ADMIN_SECRET
  "X-Sheets-Migration-Apply-Token" = $env:SHEETS_MIGRATION_APPLY_TOKEN
}
$body = @{
  mode = "apply"
  confirmation = "APPLY_CATEGORY_MIGRATION"
  spreadsheetId = "SPREADSHEET_ID"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://YOUR_PRODUCTION_DOMAIN/api/google-sheets-migration" -Headers $headers -ContentType "application/json" -Body $body
```

Apply додатково використовує Redis key `sheets:migration:category:<spreadsheetId>`:

- `BUSY` блокує паралельний повтор;
- persistent `completed` marker блокує повторний apply після успіху;
- при recoverable failure owner-only release дозволяє контрольований retry;
- якщо Vercel invocation обірвався, processing claim має TTL 30 хвилин, після якого ідемпотентний retry знову можливий.

Усі відповіді мають `Cache-Control: no-store`; endpoint не повертає credentials, Redis tokens або OAuth data. Runtime logs містять лише event name та error code.

### Порядок production запуску

1. Опублікувати тимчасовий endpoint та два secrets тільки в Production environment.
2. Виконати повний GET dry-run.
3. Для першого кандидата повторити GET із `spreadsheetId` і зберегти санітизований звіт.
4. Виконати POST apply лише цього файла.
5. Перевірити backup ID, layout, dropdown, ID, links і row groups вручну.
6. Повторити GET для цього файла: очікується `already_migrated`.
7. Лише після перевірки повторювати apply по одному для інших файлів.
8. Після завершення видалити `api/google-sheets-migration.js`, endpoint tests і обидва migration secrets із Vercel; CLI можна залишити як контрольований maintenance tool або видалити окремим рішенням.

Apply не запускається асинхронно після HTTP response. Якщо один spreadsheet не вкладається в доступний Vercel function duration, не використовувати endpoint для нього: виконати погоджений maintenance run в іншому контрольованому середовищі.
