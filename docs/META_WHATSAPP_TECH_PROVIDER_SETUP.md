# Meta WhatsApp Tech Provider Setup

> Актуально для проєкту WhatsApp-бота БФ «Корпорація Монстрів».
>
> Останнє оновлення: 20.08.2026
>
> Мета документа — зафіксувати робочу схему підключення WhatsApp Business до нашого застосунку та не повторювати весь процес дослідження у випадку повторного налаштування або міграції.

## 1. Архітектура

Використовуються два окремі Meta Business Portfolio.

### Business Portfolio 1 — власник WhatsApp

Організація: **Благодійний Фонд "Корпорація Монстрів"**.

Цей Business Portfolio повинен володіти:

- WhatsApp Business Account (WABA);
- робочим номером WhatsApp;
- бізнес-активами самого фонду.

Робочий номер: `+380 93 723 1211`

Phone Number ID, отриманий під час діагностики: `1244260758772775`

WABA ID, який використовувався під час перевірки: `3327165554110686`

### Business Portfolio 2 — технічний провайдер

Назва: **Monstriv Tech Dept**.

Призначення:

- володіє Meta App;
- використовується як Tech Provider;
- надає технічний сервіс для Business Portfolio фонду;
- після необхідних перевірок має отримати доступ до WhatsApp-активів фонду.

**Не потрібно переносити робочий номер WhatsApp у Monstriv Tech Dept.** Власником номера та WABA залишається Business Portfolio фонду.

Схема:

```text
Business Portfolio фонду
        |
        | owns
        v
 WABA + phone number
        |
        | access granted to
        v
 Monstriv Tech Dept
        |
        | owns
        v
     Meta App
        |
        v
  WhatsApp Bot
```

> Конкретний фінальний механізм надання Tech Provider доступу до WABA буде дописаний після проходження Business Verification / Access Verification. Не вважати цей крок уже завершеним.

## 2. Чому пішли шляхом Tech Provider

Попередня конфігурація мала ситуацію, коли номер існував у WhatsApp Manager, webhook отримував події, але API не міг нормально відправляти відповіді.

Помилка:

```text
(#133010) Account not registered
```

Спроба ручної реєстрації через:

```text
POST /PHONE_NUMBER_ID/register
```

дала:

```text
Register endpoint is not available for SMB businesses.
```

При перевірці номера через Graph API було отримано:

```json
{
  "id": "1244260758772775",
  "display_phone_number": "+380 93 723 1211",
  "verified_name": "Запити Монстрів",
  "code_verification_status": "NOT_VERIFIED",
  "platform_type": "ON_PREMISE"
}
```

Висновок: простий виклик `/register` не є способом виправлення цієї конфігурації. Було вирішено створити окремий технічний Business Portfolio та пройти офіційний Tech Provider flow.

## 3. Створення Meta App

Meta App створюється під **Monstriv Tech Dept**.

Use case:

```text
Connect with customers through WhatsApp
```

Після створення застосунку не потрібно одразу переносити або додавати номер фонду в технічний Business Portfolio.

## 4. Перетворення застосунку на Tech Provider

У Developer Dashboard:

```text
App Dashboard
  → Become a Tech Provider
```

Meta показує запитання:

```text
Are you building this app to provide services for a client or another business?
```

Обрати:

```text
Yes, I'm a Tech Provider
```

Meta попереджає, що визначення App як Tech Provider незворотне для цього застосунку. Якщо режим вибрано помилково, простіше створити новий App.

## 5. Що з'являється після ввімкнення Tech Provider

У Dashboard додаються етапи:

1. Customize the Connect with customers through WhatsApp use case
2. Facebook Login for Business
3. Review and complete testing requirements
4. Business and access verification
5. App Review
6. Check that all requirements are met, then publish your app

Це очікувана поведінка.

## 6. Facebook Login for Business

Після ввімкнення Tech Provider Meta додає Facebook Login for Business.

У Settings доступні, зокрема:

- Client OAuth Login;
- Web OAuth Login;
- Valid OAuth Redirect URIs;
- Deauthorize callback URL;
- Data Deletion Request URL.

**Не заповнювати ці поля навмання.** Redirect URI повинен відповідати реальному onboarding/login flow. Спочатку завершуємо необхідні verification steps.

## 7. Business Verification

Developer Dashboard:

```text
Business and access verification
  → Business verification
  → Start verification
```

Для Monstriv Tech Dept було вибрано сценарій:

```text
Додатку потрібен доступ до дозволів у Meta for Developers
```

Тип організації:

```text
Установа
```

Meta прямо відносить до цього типу, зокрема, неприбуткові організації.

Юридична назва, подана на перевірку:

```text
Благодійний Фонд "Корпорація Монстрів"
```

Вводити юридичну назву точно так, як вона зазначена в офіційних документах. Не використовувати `Monstriv Tech Dept` як юридичну назву БФ.

Meta може запросити юридичну назву, адресу, телефон, email, сайт, підтвердження зв'язку з організацією та/або офіційні документи.

### Поточний статус — 20.08.2026

```text
Триває перевірка
```

Meta показала орієнтовний строк — приблизно **2 робочі дні**.

## 8. Access Verification

Це окремий етап від Business Verification.

Meta описує його як перевірку того, що бізнес є Tech Provider. Він потрібен для доступу до Meta business assets та інформації інших businesses.

Перед запуском Access Verification інтерфейс вимагав:

1. Remove the restrictions on your Business Account.
2. Complete business verification.

Очікуваний порядок:

```text
Business Verification
        ↓
Access Verification
        ↓
App Review / інші вимоги Meta
        ↓
Production setup
```

Не плутати Business Verification та Access Verification.

## 9. Тимчасові обмеження нового Business Portfolio

Під час створення Monstriv Tech Dept Meta тимчасово обмежила Business Account після швидкого створення нового профілю/активів.

Симптом при спробі створити App:

```text
Business is not allowed to claim App
Your business is prohibited from advertising, including claiming apps.
```

Це не означає автоматично, що архітектура Tech Provider неправильна.

Якщо виникає таке обмеження:

- не створювати багато нових Business Portfolio;
- не переносити номер навмання;
- перевірити Business Support Home;
- дочекатися завершення перевірки Meta.

## 10. Webhook

Production webhook бота:

```text
https://monstriv-bot.vercel.app/api/webhook
```

Webhook verification використовує Callback URL та Verify Token.

Verify Token — це **наш секретний рядок**, а не токен, який видає Meta. Він повинен збігатися між Vercel Environment Variables та значенням, введеним у Meta Developer Dashboard.

Приклад:

```text
WHATSAPP_VERIFY_TOKEN=<secret>
```

Не зберігати реальний Verify Token у Git.

## 11. Webhook subscriptions

Для роботи чат-бота критична підписка:

```text
messages
```

У попередній конфігурації також були активні, зокрема:

```text
message_template_quality_update
message_template_status_update
```

Для приймання звичайних вхідних повідомлень головною є `messages`.

## 12. Перевірка subscribed_apps

Прив'язані до WABA застосунки можна перевірити Graph API запитом:

```text
GET /{WABA_ID}/subscribed_apps
```

Під час діагностики старої конфігурації відповідь показувала два застосунки:

```text
ZapytMonstriv
Monstriv Request
```

Після остаточної міграції потрібно перевірити, що WABA підписаний на актуальний production App, і не залишати старі subscriptions без потреби.

## 13. Vercel

Production endpoint:

```text
/api/webhook
```

У Vercel Logs нормальне отримання webhook виглядало як:

```text
POST 200 /api/webhook
```

**HTTP 200 означає лише те, що endpoint прийняв webhook.** Це не гарантує, що бот зміг відправити відповідь через WhatsApp API.

У нашому випадку webhook отримувався успішно, але відправлення відповіді падало з:

```text
(#133010) Account not registered
```

Тому завжди перевіряти обидва напрямки:

```text
WhatsApp → webhook
bot → WhatsApp Graph API
```

## 14. Environment Variables

Production deployment повинен мати актуальні:

```text
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_ACCESS_TOKEN
WHATSAPP_VERIFY_TOKEN
```

У коді на момент написання використовується Graph API `v26.0`.

Після створення нового App потрібно замінити credentials у Vercel. Старий Access Token від старого Meta App не слід автоматично вважати придатним для нового App.

Також перевірити, що `WHATSAPP_PHONE_NUMBER_ID` належить потрібному production номеру/WABA.

## 15. Що НЕ робити

- не викликати `/register` для SMB навмання;
- не переносити номер між Business Portfolio лише через статус Offline;
- не створювати новий WABA, поки не зрозуміло, навіщо він потрібен;
- не видаляти старий WABA до завершення міграції;
- не видаляти старий App до повної перевірки нового;
- не міняти Phone Number ID навмання;
- не використовувати старий Access Token із новим App без перевірки;
- не плутати Verify Token з Access Token;
- не робити App Tech Provider, якщо він має працювати лише з власними активами того самого Business Portfolio;
- не заповнювати OAuth Redirect URI випадковими URL;
- не робити висновок про працездатність бота лише з `POST 200` webhook.

## 16. Майбутня процедура відновлення / міграції

1. Створити окремий технічний Business Portfolio.
2. Створити Meta App у технічному Business Portfolio.
3. Додати use case `Connect with customers through WhatsApp`.
4. Перевести App у Tech Provider.
5. Пройти Business Verification.
6. Пройти Access Verification.
7. Виконати необхідні вимоги App Review.
8. Налаштувати Facebook Login for Business / onboarding flow згідно з актуальними вимогами Meta.
9. Надати Tech Provider доступ до WABA фонду — точну процедуру дописати після фактичного проходження цього етапу.
10. Перевірити `/{WABA_ID}/subscribed_apps`.
11. Налаштувати webhook.
12. Підписати webhook на `messages`.
13. Отримати production credentials.
14. Оновити Vercel Environment Variables.
15. Redeploy production.
16. Надіслати тестове повідомлення на номер бота.
17. Перевірити в Vercel отримання POST webhook.
18. Перевірити відправлення відповіді через Graph API.
19. Лише після повного end-to-end тесту прибирати старий App/інтеграцію.

## 17. End-to-end checklist

Інтеграція вважається робочою лише якщо виконуються всі потрібні для поточної конфігурації пункти:

- [ ] Meta App належить Monstriv Tech Dept
- [x] App позначений як Tech Provider
- [ ] Business Verification completed
- [ ] Access Verification completed
- [ ] необхідні вимоги App Review completed
- [ ] WABA фонду доступний Tech Provider
- [ ] перевірений правильний Phone Number ID
- [ ] перевірений правильний WABA ID
- [ ] правильний production Access Token
- [ ] webhook verification успішна
- [ ] subscription `messages` активна
- [ ] `/{WABA_ID}/subscribed_apps` показує актуальний App
- [ ] Vercel отримує POST `/api/webhook`
- [ ] Graph API дозволяє відправляти повідомлення
- [ ] користувач пише боту і отримує відповідь
- [ ] production bot більше не залежить від старого App

## 18. Security

Ніколи не комітити в Git:

- App Secret;
- Access Token;
- Verify Token;
- System User Token;
- OAuth credentials;
- Google credentials;
- Redis credentials.

У документації зберігати тільки placeholders на кшталт:

```text
VARIABLE_NAME=<secret>
```

Самі секрети повинні знаходитися у Vercel Environment Variables або іншому secret storage.

## 19. Головний принцип

Завжди розділяти три сутності:

```text
Благодійний Фонд "Корпорація Монстрів"
    = юридична організація / власник WhatsApp assets

Monstriv Tech Dept
    = Tech Provider / технічний Business Portfolio

Meta App
    = програмний застосунок, через який працює бот
```

Якщо Meta запитує **«Чий це WhatsApp/WABA?»** — БФ «Корпорація Монстрів».

Якщо Meta запитує **«Хто надає технічний сервіс?»** — Monstriv Tech Dept.

Якщо йдеться про програмну інтеграцію — Meta App, створений у Monstriv Tech Dept.

Не ламати це розділення спробами вручну переносити номер між Business Portfolio без чіткої причини.
