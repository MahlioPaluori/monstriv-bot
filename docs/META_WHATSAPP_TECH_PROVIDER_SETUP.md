# Meta WhatsApp Tech Provider Setup

> Технічна історія й поточний статус Meta-інтеграції WhatsApp-бота БФ «Корпорація Монстрів».
>
> Останнє оновлення: 14.10.2026
>
> Детальна архітектура, бізнес-сценарії та стан тестування бота описані в [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md).

## 1. Статуси, які не можна змішувати

1. **Працює зараз:** production-бот приймає webhook-події та відповідає через WhatsApp Cloud API.
2. **Підтверджено для Tech Provider:** Meta App `Monstriv Request` створений, Tech Provider path активований.
3. **Не завершено або не перевірено:** Business Verification, Access Verification, App Review, остаточний доступ до WABA, Embedded Signup і Coexistence onboarding.
4. **Призупинено:** запланована інтеграція Chatwoot не реалізована.

Наявність сторінки Meta, кнопки або callback endpoint не доводить завершення всього onboarding.

## 2. Поточна робоча інтеграція Cloud API

Production-бот працює як Node.js ESM застосунок у Vercel:

```text
WhatsApp user
    ↓
Meta WhatsApp Cloud API
    ↓ webhook
GET/POST /api/webhook
    ↓
Redis + Google Drive + Google Sheets
    ↓
WhatsApp Cloud API v26.0
```

- `api/webhook.js` — Meta verification і POST webhook/state machine;
- `lib/whatsapp.js` — вихідні виклики Cloud API `v26.0`;
- `api/meta/oauth-callback.js` — обмежений callback майбутнього Embedded Signup;
- Redis — state, leases та idempotency;
- Google Drive і Google Sheets — документи та заявки.

Основний flow підтверджений ручними production-тестами заявок. Це **не є доказом завершення Tech Provider, Embedded Signup або Coexistence**.

Production webhook:

```text
https://monstriv-bot.vercel.app/api/webhook
```

Критична webhook-підписка — `messages`. HTTP `200` від endpoint підтверджує лише приймання webhook; успішність вихідного повідомлення перевіряється окремо за відповіддю Cloud API та безпечними логами.

## 3. Цільова модель Meta assets

```text
Business Portfolio БФ «Корпорація Монстрів»
        | owns
        v
 WABA + production phone number
        | grants approved access
        v
 Technical Business Portfolio / Tech Provider
        | operates
        v
 Meta App «Monstriv Request» → WhatsApp Bot
```

WABA і номер мають залишатися активами фонду. Доступ Tech Provider повинен надаватися через підтримуваний Meta flow, а не через необґрунтоване перенесення ownership.

Історичні нотатки називали цільовий технічний portfolio `Monstriv Tech Dept`. Старий portfolio `BikePride Extreme` не має підтверджених Business Verification та App Review і не планується як production owner. Правильна юридична сутність — БФ «Корпорація Монстрів»; admin/business access до її Meta/Facebook assets залишається передумовою подальшого onboarding.

Перед міграцією потрібно повторно перевірити фактичний ownership App, WABA, номера та portfolios у Meta Business Manager.

## 4. Підтверджені кроки Tech Provider

Підтверджено:

- створено Meta App `Monstriv Request` із WhatsApp use case;
- активовано **Become a Tech Provider**;
- у Dashboard з'явилися етапи Facebook Login for Business, verification, testing, App Review і publication;
- у репозиторії є `api/meta/oauth-callback.js`.

Tech Provider mode не надає автоматично доступ до WABA фонду й не означає проходження перевірок. Назви та порядок екранів Meta можуть змінюватися; орієнтиром є актуальний Dashboard.

## 5. Незавершені або неперевірені етапи

Станом на 14.10.2026 немає задокументованого підтвердження завершення:

- Business Verification правильної юридичної сутності та portfolio;
- Access Verification як Tech Provider;
- потрібних permissions і App Review;
- publication App для запланованого onboarding;
- надання App/Tech Provider доступу до production WABA;
- аудиту актуального `/{WABA_ID}/subscribed_apps`;
- Embedded Signup end-to-end;
- WhatsApp Business App + Cloud API Coexistence onboarding.

Історичний статус від 20.08.2026 «триває перевірка» відображав лише UI на ту дату і не підтверджує успішну verification зараз. Business Verification та Access Verification — різні етапи; жоден не позначається завершеним без актуального доказу.

## 6. Embedded Signup callback

Endpoint:

```text
GET /api/meta/oauth-callback
```

Він приймає `code` або OAuth error, повертає HTML-результат і може зафіксувати лише факт наявності code. Endpoint:

- не обмінює authorization code на access token;
- не зберігає code або token;
- не змінює WhatsApp, Redis чи bot state;
- не завершує WABA/phone onboarding.

Тому успішний callback не означає завершення Embedded Signup. Redirect URI має відповідати реальному flow; не використовувати випадкові URL.

## 7. Coexistence і production-номер

Ціль — офіційний WhatsApp Business App + Cloud API Coexistence: бот працює через Cloud API, оператор — через підтримуваний Meta client або inbox.

Поточний стан:

- production Cloud API bot працює;
- Coexistence onboarding **не завершено**;
- production-номер не можна deregister, видаляти або переносити навмання;
- зміна ownership, WABA, Phone Number ID або credentials потребує окремого плану та end-to-end перевірки.

Не використовувати ручний `POST /PHONE_NUMBER_ID/register` як універсальне виправлення ownership/onboarding проблем.

## 8. Chatwoot — заплановано, але призупинено

Chatwoot не інтегровано:

- немає Chatwoot API client або webhook endpoint;
- немає підтверджених Chatwoot environment variables;
- немає синхронізації діалогів, контактів чи статусів;
- немає production operator queue/inbox через Chatwoot.

Поточний `OPERATOR` stage лише фіксує стан і показує повідомлення; він не передає діалог оператору чи в Chatwoot. Подальша робота призупинена до окремого рішення і потребуватиме дизайну, перевірки privacy/data retention та явного погодження.

## 9. Історія діагностики

У попередній конфігурації webhook отримував події, але вихідні API-виклики повертали:

```text
(#133010) Account not registered
```

Ручний виклик `POST /PHONE_NUMBER_ID/register` повідомляв, що endpoint недоступний для SMB. Історичний Graph metadata також показував непідтверджений номер і `platform_type: ON_PREMISE`. Це стало причиною початку Tech Provider flow, але не описує автоматично актуальний production стан.

Історично `/{WABA_ID}/subscribed_apps` показував старий і новий App. Перед завершенням міграції аудит потрібно повторити; старі subscriptions/App не видаляти до повного тесту нового setup.

Конкретні phone, WABA та app identifiers тут навмисно не зберігаються. Їх звіряють у Meta Dashboard або контрольованому config/secret storage.

## 10. Webhook verification та environment variables

GET verification у коді використовує:

```text
WEBHOOK_VERIFY_TOKEN=<secret>
```

Verify Token — створений нами секретний рядок, однаковий у Vercel і Meta Dashboard. Це не Access Token.

Cloud API flow очікує:

```text
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_ACCESS_TOKEN
WEBHOOK_VERIFY_TOKEN
```

Значення не зберігаються в Git чи документації. Після зміни App, WABA або номера не можна припускати валідність старих credentials; відповідність assets перевіряється без виведення значень у логи.

## 11. Безпечний порядок продовження onboarding

1. Отримати підтверджений admin/business access до assets фонду.
2. Уточнити ownership App, WABA і production-номера.
3. Перевірити Business Verification правильної юридичної сутності.
4. Завершити потрібні Business/Access Verification та App Review.
5. Налаштувати Facebook Login for Business і Embedded Signup за актуальними вимогами Meta.
6. Реалізувати server-side token exchange лише окремим погодженим завданням.
7. Пройти official Coexistence onboarding без ручного перенесення номера.
8. Перевірити `messages` і `/{WABA_ID}/subscribed_apps`.
9. Провести двосторонній end-to-end тест: inbound webhook і outbound message.
10. Лише після цього планувати очищення старих subscriptions/App.

Під час цих робіт не змінювати business flow бота; його описано в [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md).

## 12. Checklists

### Поточний production Cloud API bot

- [x] Реалізований GET/POST `/api/webhook`.
- [x] Вихідні повідомлення використовують Cloud API `v26.0`.
- [x] Production flow заявок пройшов ручні end-to-end тести.
- [x] Секрети надходять через environment variables, а не Git.
- [ ] Актуальний зв'язок App/WABA/portfolio повторно задокументовано після Meta-аудиту.

### Tech Provider / Embedded Signup / Coexistence

- [x] Meta App `Monstriv Request` існує.
- [x] Tech Provider path активований.
- [x] OAuth callback endpoint існує.
- [ ] Business Verification підтверджено для правильної сутності.
- [ ] Access Verification підтверджено.
- [ ] Необхідний App Review підтверджено.
- [ ] Server-side code exchange і secure token handling реалізовано.
- [ ] Потрібний доступ до WABA підтверджено.
- [ ] `subscribed_apps` перевірено для актуального production setup.
- [ ] Embedded Signup завершено end-to-end.
- [ ] Coexistence завершено й перевірено.

### Chatwoot

- [ ] Архітектуру та privacy boundaries погоджено.
- [ ] Інтеграцію реалізовано.
- [ ] Production operator handoff перевірено.

## 13. Що не робити

- не deregister і не переносити production-номер без погодженого плану;
- не створювати WABA або portfolios як випадкову спробу виправлення;
- не видаляти старий App/subscription до end-to-end тесту нового setup;
- не змішувати Verify Token з Access Token;
- не вважати `POST 200` доказом успішної відповіді користувачеві;
- не позначати verification, App Review, Embedded Signup чи Coexistence завершеними через саму наявність UI або endpoint;
- не підключати Chatwoot без окремого завдання;
- не логувати webhook payload, tokens, OAuth codes, телефони чи персональні дані.

## 14. Security

Ніколи не комітити App Secret, Access/Verify/System User tokens, OAuth codes, Google/Redis credentials або повні production webhook payloads.

У документації використовувати лише назви змінних і placeholders:

```text
VARIABLE_NAME=<secret>
```

Phone Number ID, WABA ID та інші production identifiers не є токенами, але є чутливими інфраструктурними metadata. Їх не потрібно зберігати в публічній документації без операційної потреби.
