# MRX Desktop

Офлайн‑приложение для Windows x64, которое разделяет аудио и звуковые дорожки видео на речь, музыку и эффекты. MRX запускается отдельным небольшим окном: браузер, Python, установленный Node.js и интернет для обработки не нужны.

## Запуск готовой папки

Распакуйте `MRX.zip` в папку с любыми пробелами или кириллицей и дважды нажмите `MRX.exe`. Откроется окно MRX; перетащите туда один или несколько аудио/видео файлов. Обработка выполняется последовательно на CPU. Файлы обрабатываются прямо с диска, без копирования. Для готовой задачи доступны три WAV, ZIP и кнопка «Открыть папку».

Результаты автоматически сохраняются рядом с `MRX.exe` в `data\outputs\<идентификатор-задачи>`. В этой папке лежат только три WAV; ZIP задачи собирается в момент скачивания. После завершения очереди кнопка «Сохранить всё» скачивает один ZIP с отдельной папкой для каждого готового файла; ошибки и отменённые задачи в архив не попадают. Хранится только последний такой архив. Временные файлы загрузок и архивы «Сохранить всё» удаляются после завершения, после отмены и при следующем запуске. Исходные файлы пользователя MRX не изменяет и не удаляет. Кнопка «Удалить» в карточке готового файла после второго нажатия удаляет его папку результатов; для ошибок и отменённых задач кнопка «Убрать» просто убирает их из списка. Нажатие X или «Закрыть приложение» корректно останавливает только процессы MRX; если задача активна, приложение попросит подтверждение отмены.

Папка portable уже содержит Node.js runtime, ONNX Runtime CPU, pinned‑модель MRX, локальную LGPL‑сборку FFmpeg и Microsoft Visual C++ x64 runtime. Устанавливать что‑либо отдельно не требуется. Повторный запуск второй копии переводит фокус на уже открытое окно.

## Производительность и ограничения

Звук из видео декодируется встроенным FFmpeg в PCM 44,1 kHz, затем обрабатывается моделью MRX. WAV сохраняются как 16‑bit PCM и сохраняют длительность входного звука. Модель CPU использует заметную память: для длинных видео может потребоваться 16–32 ГБ RAM. Максимальный размер декодированного PCM ограничен 1,5 GB, это около 70 минут звука (`MRX_MAX_DECODE_BYTES` можно изменить при ручном запуске сервера). Если контейнер файла сообщает длительность, слишком длинный файл отклоняется сразу, ещё до декодирования.

## Сборка из исходников

Требуется Windows x64, PowerShell 5+, Node.js с npm и Visual Studio с компонентом VC++ redistributable. Доступ к сети нужен только на этапе сборки. Закреплённые версии npm‑пакетов находятся в `package-lock.json`, а все остальные загрузки (Node.js, Electron, модель, FFmpeg и его исходники) с SHA‑256 перечислены в `scripts\deps.json`.

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1
```

Сборка сначала вызывает `node scripts\fetch-deps.mjs`. Он скачивает недостающее в `.cache\`, `weights\` и `tools\ffmpeg\`, сверяет каждый файл с хэшем из `scripts\deps.json`, а уже проверенные файлы не скачивает повторно. Если исходная ссылка пропала, файл с правильным хэшем можно положить на нужное место вручную. FFmpeg берётся из релизной ветки 9.0 (сборка BtbN на конец месяца); откуда он и какой исходный код ему соответствует, описано в `third_party\FFmpeg-BUILD-PROVENANCE.txt`. Зависимости приложения ставятся чистым `npm ci --omit=dev` из `package-lock.json`. `MRX.exe` получает метаданные MRX, а ненужные fuses Electron (`RunAsNode`, `NODE_OPTIONS`) выключаются; для этого нужны devDependencies, которые ставит `npm ci`.

Скрипт создаёт `dist\MRX` и `dist\MRX.zip`, включая `MRX.exe`, `resources\app`, runtime, модель, FFmpeg, данные и тексты лицензий. Исходники приложения и скрипты сборки сохраняются в `source\` внутри portable‑папки. В `LICENSES\` кладутся точный архив исходников FFmpeg, рецепт сборки BtbN, его контрольные суммы и provenance. Свой комплект FFmpeg можно передать через `-FfmpegSource <каталог-с-ffmpeg.exe> -FfmpegSha <sha256>`. Для копирования легитимных файлов Microsoft VC++ можно явно указать `-VCRedistDir <Microsoft.VC143.CRT\x64>`. Другую папку результата задаёт `-OutDir dist\<имя>`.

Иконка `MRX.exe` берётся из `desktop\assets\mrx.ico`. Сейчас это временная иконка из логотипа приложения, её генерирует `node scripts\make-icon.mjs` (нужен Playwright из `tests\e2e`). Чтобы поставить свою, замените файл.

Подпись кода необязательна. С сертификатом из хранилища Windows передайте `-SignThumbprint <отпечаток>`, с файлом — `-SignPfx <путь.pfx>`, а пароль задайте в `$env:MRX_SIGN_PFX_PASSWORD`. Подписывается только `MRX.exe`, после метаданных и fuses; метку времени ставит `-SignTimestampUrl` (по умолчанию DigiCert). Нужен `signtool.exe` из Windows SDK. Без подписи Windows SmartScreen показывает «Неизвестный издатель».

Для проверки серверного слоя без окна:

```powershell
node scripts\fetch-deps.mjs model ffmpeg
$env:MRX_NO_BROWSER='1'
node app\server.mjs
```

Сервер выбирает порт начиная с `17863`, печатает строку `MRX_READY ...` и слушает только loopback. Все запросы к `/api` требуют cookie сессии. При ручном запуске сервер печатает одноразовую ссылку `MRX_OPEN http://127.0.0.1:<порт>/signin/...`; браузер, открывший её, получает cookie. В desktop‑сборке Electron сам создаёт токен и передаёт серверу `MRX_SESSION_TOKEN`, `MRX_DESKTOP=1`, `MRX_NO_BROWSER=1` и абсолютные пути к `data`, `weights` и `tools`. В этом режиме токен никуда не печатается.

## Тесты

```powershell
npm test
```

Команда запускает все серверные наборы и проверку того, как окно реагирует на сбой сервера. FFmpeg и модель для них ставит `node scripts\fetch-deps.mjs model ffmpeg`. Те же шаги выполняет CI на GitHub Actions (`.github\workflows\test.yml`). Нативные проверки окна (`tests\native\*.mjs`) используют Playwright из `tests\e2e\node_modules` и собранную portable‑папку; путь к другой папке задаёт `MRX_PORTABLE_DIR`.

## Лицензии и исходники компонентов

Тексты лицензий и атрибуция находятся в `LICENSES\` готовой папки. Состав npm‑зависимостей зафиксирован в `package-lock.json`; `@audio/neural-separate` содержит собственный `NOTICE`.

* MRX ONNX: MIT, Copyright (c) 2023 Mitsubishi Electric Research Laboratories (MERL). Модель обучена на Divide and Remaster v2; у исходных наборов данных собственные лицензии, в том числе с некоммерческими условиями (см. `LICENSES\MRX-MODEL-CARD.txt`). Модель `audiojs/mrx` закреплена на revision `dedc823a0bea2ed085d19e8b7f32589d35169ee8`; SHA‑256 указан в `LICENSES\MRX-MODEL-CARD.txt`. Полная атрибуция и model card находятся там же.
* `@audio/neural-separate` 0.6.0 и `@audio/neural-runtime` 0.1.1: MIT; исходники в [audiojs/neural](https://github.com/audiojs/neural).
* `onnxruntime-node` 1.29.0: MIT; полный текст ONNX Runtime находится в `LICENSES\ONNX-RUNTIME-MIT.txt`, исходники и версия перечислены в `LICENSES\THIRD-PARTY.txt`.
* `ffmpeg`: LGPL‑3.0-or-later, сборка BtbN win64-lgpl ветки 9.0 (`n9.0.2-17-g2a571b6068`). Её SHA‑256 и исходники описаны в `LICENSES\FFmpeg-BUILD-PROVENANCE.txt` и `LICENSES\THIRD-PARTY.txt`; полный текст LGPL находится в `LICENSES\FFmpeg-LGPL-3.0.txt`.
* Electron и Chromium: лицензии находятся в `LICENSES\Electron.txt` и `LICENSES\Electron-Chromium.html`.
* Node.js: MIT; официальный архив и SHA‑256 указаны в `LICENSES\THIRD-PARTY.txt`.
