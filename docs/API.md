# HTTP API

Все действия используют /api/studio?action=... . Самостоятельный сервер защищает API тем же HTTP Basic паролем, что интерфейс. Имя пользователя произвольное. Не путайте пароль приложения и API-ключ xAI.

## Сессия

Первый GET state создаёт cookie afisha_session (HttpOnly, SameSite=Strict, Secure для HTTPS). Во всех последующих запросах сохраняйте её. POST требует Origin, точно совпадающий с APP_ORIGIN. Без cookie POST возвращает 401. Ответы с данными имеют Cache-Control: no-store.

Пример для локального сервера (пароль вводится curl интерактивно):

```bash
curl -u admin -c cookies.txt 'http://localhost:3000/api/studio?action=state'
curl -u admin -b cookies.txt -H 'Origin: http://localhost:3000' -F 'kind=photo' -F 'file=@photo.jpg' 'http://localhost:3000/api/studio?action=upload'
```

Файл cookies.txt даёт доступ к серии вместе с паролем. Не добавляйте его в Git, удалите после теста. Не передавайте ключи через историю shell.

## Действия

| Метод / action | Вход | Результат |
|---|---|---|
| GET state | Cookie, необязательна при первом запросе | assets[], jobs[], config или null |
| POST upload | multipart: kind=photo/poster, file | Объект Asset |
| POST plan | JSON: mode, model, instruction | {ok:true}, создание очереди |
| POST extend | Та же форма | Новые фото добавляются с сохранёнными настройками |
| POST edit | JSON: id, key (ключ xAI) | Job со статусом done или ошибка |
| POST retry | JSON: id | {ok:true}, возврат ошибки/зависшего в pending |
| POST remove | JSON: id | Удаление исходного файла, не используемого в очереди |
| POST reset | JSON: {} | Удаление всей текущей серии; запрещено при running |
| GET file | Дополнительно kind=asset/result&id=UUID | Бинарное изображение |
| GET export | Нет | application/zip: done-изображения и report.json |

Отдельно GET /healthz возвращает текст ok и не требует авторизации.

## Типы

Asset: id, name, kind, url, created (Unix ms), size (байты; для старых записей восстанавливается при state).

Job: id, photo (Asset), poster (Asset), status (pending/running/done/error), created, updated, необязательные result и error. result — относительный URL с cookie-доступом, не публичная ссылка.

Config: model, mode, instruction. Допустимые model: grok-imagine-image-2.0, grok-imagine-image. mode: balanced, random, sequential. instruction: непустая строка до 3000 символов.

## Пример plan

```json
{
  "model": "grok-imagine-image-2.0",
  "mode": "balanced",
  "instruction": "Заменить центральную афишу, сохранить окружение и тени."
}
```

## Ошибки

Обычно JSON {"error":"Сообщение"}. 400 — неверные параметры/недопустимое состояние; 401 — сессия или ключ; 403 — Origin; 404 — файл/задание; 409 — конфликт etag; 413 — размер; 429 — общий лимит Node-сервера; 502 — ошибка/таймаут xAI; 500 — внутренний сбой. HTTP Basic 401 возвращает WWW-Authenticate и текст Authentication required, а не JSON.

Текущая реализация преобразует ошибки xAI, включая его 429, в 502 с понятным сообщением. Самостоятельный серверный лимит возвращает 429 до запуска модели. Автоматических повторов нет.

Дублирование edit для done не вызывает xAI. Дублирование edit для running даёт конфликт. Это не позволяет автоматически повторять запрос при сетевой неопределённости: внешняя генерация могла быть оплачена.

## Лимиты

500 фото, 50 макетов на серию, 10 МБ на исходник, 18 МБ на результат. JSON-тело до 16000 байт. Multipart ограничен 10 МБ + 100000 байт служебной части. Архив стандартный ZIP без ZIP64 (до 4 ГБ). Интерфейс держит до 4 edit; общий серверный лимит настраивается отдельно.
