# MRX Desktop

Офлайн‑приложение для Windows x64, которое разделяет аудио и звуковые дорожки видео на речь, музыку и эффекты. MRX запускается отдельным небольшим окном: браузер, Python, установленный Node.js и интернет для обработки не нужны.

## Запуск готовой папки

Распакуйте `MRX.zip` в папку с любыми пробелами или кириллицей и дважды нажмите `MRX.exe`. Откроется окно MRX; перетащите туда один или несколько аудио/видео файлов. Обработка выполняется последовательно на CPU. Файлы обрабатываются прямо с диска, без копирования. Для готовой задачи доступны три WAV, ZIP и кнопка «Открыть папку».

Результаты автоматически сохраняются рядом с `MRX.exe` в `data\outputs\<идентификатор-задачи>`. В этой папке лежат только три WAV; ZIP задачи собирается в момент скачивания. После завершения очереди кнопка «Сохранить всё» скачивает один ZIP с отдельной папкой для каждого готового файла; ошибки и отменённые задачи в архив не попадают. Хранится только последний такой архив. Временные файлы загрузок и архивы «Сохранить всё» удаляются после завершения, после отмены и при следующем запуске. Исходные файлы пользователя MRX не изменяет и не удаляет. Нажатие X или «Закрыть приложение» корректно останавливает только процессы MRX; если задача активна, приложение попросит подтверждение отмены.

Папка portable уже содержит Node.js runtime, ONNX Runtime CPU, pinned‑модель MRX, локальную LGPL‑сборку FFmpeg и Microsoft Visual C++ x64 runtime. Устанавливать что‑либо отдельно не требуется. Повторный запуск второй копии переводит фокус на уже открытое окно.

## Производительность и ограничения

Звук из видео декодируется встроенным FFmpeg в PCM 44,1 kHz, затем обрабатывается моделью MRX. WAV сохраняются как 16‑bit PCM и сохраняют длительность входного звука. Модель CPU использует заметную память: для длинных видео может потребоваться 16–32 ГБ RAM. Максимальный размер декодированного PCM ограничен 1,5 GB, это около 70 минут звука (`MRX_MAX_DECODE_BYTES` можно изменить при ручном запуске сервера). Если контейнер файла сообщает длительность, слишком длинный файл отклоняется сразу, ещё до декодирования.

## Сборка из исходников

Требуется Windows x64, PowerShell 5+, Node.js с npm и Visual Studio с компонентом VC++ redistributable. Доступ к npm и Hugging Face нужен только на этапе сборки. Закреплённые версии находятся в `package-lock.json`. Официальные архивы Electron x64 и Node.js, модель и FFmpeg проверяются по SHA‑256.

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 `
  -FfmpegSourceArchive vendor-sources\FFmpeg-eceaa54a3880dad139edb4e3bfe9c548246558cb.tar.gz
```

Перед первой сборкой распакуйте закреплённую сборку FFmpeg BtbN, описанную в `vendor-sources\FFmpeg-BUILD-PROVENANCE.txt`, в `tools\ffmpeg-staging\ffmpeg-master-latest-win64-lgpl\`. Скрипт сверяет её хэш, но сам FFmpeg не скачивает, потому что ссылка BtbN `latest` со временем указывает на другую сборку. Модель скачивается автоматически с закреплённой revision Hugging Face, если её нет в `weights\mrx\`. Зависимости приложения ставятся чистым `npm ci --omit=dev` из `package-lock.json`. `MRX.exe` получает метаданные MRX, а ненужные fuses Electron (`RunAsNode`, `NODE_OPTIONS`) выключаются; для этого нужны devDependencies, которые ставит `npm ci`.

Скрипт создаёт `dist\MRX` и `dist\MRX.zip`, включая `MRX.exe`, `resources\app`, runtime, модель, FFmpeg, данные и тексты лицензий. Исходники приложения и скрипты сборки сохраняются в `source\` внутри portable‑папки. Передача `-FfmpegSourceArchive` добавляет точный исходный архив FFmpeg в `LICENSES\FFmpeg-SOURCE-ARCHIVE.tar.gz`; provenance и checksum BtbN сохраняются рядом. Путь к локальному комплекту FFmpeg можно передать через `-FfmpegSource <каталог-с-ffmpeg.exe>`. Для копирования легитимных файлов Microsoft VC++ можно явно указать `-VCRedistDir <Microsoft.VC143.CRT\x64>`. Другую папку результата задаёт `-OutDir dist\<имя>`. Код скрипт не подписывает: без сертификата Windows SmartScreen показывает «Неизвестный издатель».

Для проверки серверного слоя без окна:

```powershell
$env:MRX_NO_BROWSER='1'
$env:MRX_FFMPEG="$pwd\tools\ffmpeg-staging\ffmpeg-master-latest-win64-lgpl\bin\ffmpeg.exe"
node app\server.mjs
```

Сервер выбирает порт начиная с `17863`, печатает строку `MRX_READY ...` и слушает только loopback. Все запросы к `/api` требуют cookie сессии. При ручном запуске сервер печатает одноразовую ссылку `MRX_OPEN http://127.0.0.1:<порт>/signin/...`; браузер, открывший её, получает cookie. В desktop‑сборке Electron сам создаёт токен и передаёт серверу `MRX_SESSION_TOKEN`, `MRX_DESKTOP=1`, `MRX_NO_BROWSER=1` и абсолютные пути к `data`, `weights` и `tools`. В этом режиме токен никуда не печатается.

## Тесты

```powershell
npm test
```

Команда запускает все серверные наборы и проверку того, как окно реагирует на сбой сервера. Для них нужны `tools\ffmpeg-staging` и модель в `weights\mrx\`. Нативные проверки окна (`tests\native\*.mjs`) используют Playwright из `tests\e2e\node_modules` и собранную portable‑папку; путь к другой папке задаёт `MRX_PORTABLE_DIR`.

## Лицензии и исходники компонентов

Тексты лицензий и атрибуция находятся в `LICENSES\` готовой папки. Состав npm‑зависимостей зафиксирован в `package-lock.json`; `@audio/neural-separate` содержит собственный `NOTICE`.

* MRX ONNX: MIT, Copyright (c) 2023 Mitsubishi Electric Research Laboratories (MERL). Модель обучена на Divide and Remaster v2; у исходных наборов данных собственные лицензии, в том числе с некоммерческими условиями (см. `LICENSES\MRX-MODEL-CARD.txt`). Модель `audiojs/mrx` закреплена на revision `dedc823a0bea2ed085d19e8b7f32589d35169ee8`; SHA‑256 указан в `LICENSES\MRX-MODEL-CARD.txt`. Полная атрибуция и model card находятся там же.
* `@audio/neural-separate` 0.6.0 и `@audio/neural-runtime` 0.1.1: MIT; исходники в [audiojs/neural](https://github.com/audiojs/neural).
* `onnxruntime-node` 1.29.0: MIT; полный текст ONNX Runtime находится в `LICENSES\ONNX-RUNTIME-MIT.txt`, исходники и версия перечислены в `LICENSES\THIRD-PARTY.txt`.
* `ffmpeg`: LGPL‑3.0-or-later, конкретная win64-lgpl сборка и SHA‑256 указаны в `LICENSES\THIRD-PARTY.txt`; полный текст LGPL находится в `LICENSES\FFmpeg-LGPL-3.0.txt`.
* Electron и Chromium: лицензии находятся в `LICENSES\Electron.txt` и `LICENSES\Electron-Chromium.html`.
* Node.js: MIT; официальный архив и SHA‑256 указаны в `LICENSES\THIRD-PARTY.txt`.
