# Сборка, тесты и provenance

Этот документ описывает сборку из исходников и проверки MRX. Команды ниже выполняются из корня репозитория. Пользовательскую установку готовой portable‑сборки см. в [README.md](../README.md).

## Требования и зависимости

Для сборки нужен Windows x64, PowerShell 5+, Node.js с npm и Visual Studio с компонентом Microsoft Visual C++ redistributable. Доступ к сети нужен только на этапе сборки. Версии npm‑пакетов закреплены в [`package-lock.json`](../package-lock.json), а остальные загружаемые компоненты и их SHA‑256 перечислены в [`scripts/deps.json`](../scripts/deps.json).

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1
```

Скрипт сборки сначала вызывает [`scripts/fetch-deps.mjs`](../scripts/fetch-deps.mjs). Он скачивает недостающие архивы и бинарные файлы в `.cache\`, `weights\` и `tools\ffmpeg\`, сверяет каждый файл с хэшем из [`scripts/deps.json`](../scripts/deps.json), а уже проверенные файлы повторно не скачивает. Если исходная ссылка больше недоступна, файл с правильным SHA‑256 можно положить в ожидаемое место вручную.

FFmpeg берётся из релизной ветки 9.0 (сборка BtbN на конец месяца), закреплённой в зависимостях. Источник, точный commit, рецепт и контрольные суммы описаны в [`third_party/FFmpeg-BUILD-PROVENANCE.txt`](../third_party/FFmpeg-BUILD-PROVENANCE.txt). Production‑зависимости приложения устанавливаются чистым `npm ci --omit=dev` из lockfile. [`scripts/finalize-exe.mjs`](../scripts/finalize-exe.mjs) записывает метаданные MRX и выключает ненужные Electron fuses (`RunAsNode`, `NODE_OPTIONS`); для этого шага нужны devDependencies из корневого `npm ci`.

## Portable‑сборка

По умолчанию команда создаёт `dist\MRX` и `dist\MRX.zip`. В комплект входят `MRX.exe`, `resources\app`, встроенный Node.js runtime, модель MRX, FFmpeg, данные и тексты лицензий. Исходники приложения и скрипты сборки сохраняются в `source\` внутри portable‑папки.

В комплект `LICENSES\` попадают точный архив исходников FFmpeg, рецепт сборки BtbN, контрольные суммы и provenance. Собственный комплект FFmpeg можно передать так:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 `
  -FfmpegSource <каталог-с-ffmpeg.exe> -FfmpegSha <sha256>
```

Для копирования легитимных файлов Microsoft VC++ можно явно указать каталог `Microsoft.VC143.CRT\x64`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 -VCRedistDir <Microsoft.VC143.CRT\x64>
```

Другую папку результата задаёт `-OutDir dist\<имя>`. Указать `-SkipZip` можно, если нужен только каталог.

## Иконка и подпись

Иконка `MRX.exe` берётся из [`desktop/assets/mrx.ico`](../desktop/assets/mrx.ico). Сейчас это временная иконка из логотипа приложения; её генерирует `node scripts\make-icon.mjs` (нужен Playwright из `tests\e2e`). Чтобы поставить свою, замените этот файл.

Подпись кода необязательна. С сертификатом из хранилища Windows передайте `-SignThumbprint <отпечаток>`, с файлом — `-SignPfx <путь.pfx>`, а пароль задайте в `$env:MRX_SIGN_PFX_PASSWORD`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 -SignThumbprint <отпечаток>
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 -SignPfx <путь.pfx>
```

Подписывается только `MRX.exe`, после записи метаданных и переключения fuses. URL метки времени задаёт `-SignTimestampUrl` (по умолчанию DigiCert). Нужен `signtool.exe` из Windows SDK. Без подписи Windows SmartScreen показывает «Неизвестный издатель».

## Сервер и сессия

Проверка серверного слоя без окна:

```powershell
node scripts\fetch-deps.mjs model ffmpeg
$env:MRX_NO_BROWSER='1'
node app\server.mjs
```

Сервер выбирает порт начиная с `17863`, печатает `MRX_READY ...` и слушает только loopback. Все запросы к `/api` требуют cookie сессии. При ручном запуске сервер печатает одноразовую ссылку `MRX_OPEN http://127.0.0.1:<порт>/signin/...`; браузер, открывший её, получает cookie.

В desktop‑сборке Electron сам создаёт токен и передаёт серверу `MRX_SESSION_TOKEN`, `MRX_DESKTOP=1`, `MRX_NO_BROWSER=1` и абсолютные пути к `data`, `weights` и `tools`. В этом режиме токен не печатается. Сервер и worker используют только loopback и локальные файлы; worker получает `MRX_OFFLINE=1`.

Portable‑данные лежат рядом с `MRX.exe`: `data\uploads`, `data\outputs`, `data\cache` и `data\logs`. Завершённые результаты в `data\outputs` сохраняются до удаления через интерфейс. Входные копии web‑загрузок удаляются после обработки, а незавершённые загрузки и кэш общего архива очищаются при старте и штатном завершении.

## Производительность и лимиты

Worker запускает модель с `device: 'node'` и встроенным CPU‑runtime. Он декодирует первый аудиопоток в стерео PCM 44,1 kHz, а готовые дорожки записывает как 16‑bit PCM WAV.

Для multipart HTTP‑загрузок сервер ограничивает размер одного файла переменной `MRX_MAX_FILE_BYTES` (по умолчанию 1 500 000 000 байт) и количество файлов переменной `MRX_MAX_FILES` (по умолчанию 20). Desktop‑маршрут `/api/jobs/local` принимает до 20 абсолютных путей и обрабатывает их с диска без этой HTTP‑копии и без ограничения размера файла загрузчиком.

Жёсткий предел декодированного PCM задаёт `MRX_MAX_DECODE_BYTES` (по умолчанию 1 500 000 000 байт). При текущем формате это около 70 минут стерео‑звука; если длительность контейнера известна и превышает предел, worker отклоняет файл до основного декодирования.

Фиксированное требование по RAM код не задаёт. В старом описании проекта встречался ориентир 16–32 GB для длинных видео, но это приблизительная оценка, а не измеренное требование или гарантия.

## Тесты

```powershell
npm test
```

Команда запускает серверные наборы и проверяет, как окно реагирует на сбой сервера. FFmpeg и модель для них ставит `node scripts\fetch-deps.mjs model ffmpeg`. Те же шаги выполняет CI в [`.github/workflows/test.yml`](../.github/workflows/test.yml). Нативные проверки окна в [`tests/native`](../tests/native) используют Playwright из `tests\e2e\node_modules` и собранную portable‑папку; путь к другой папке задаёт переменная `MRX_PORTABLE_DIR`.

## Лицензии и provenance

Тексты лицензий и атрибуция копируются в `LICENSES\` внутри готовой portable‑папки. Состав npm‑зависимостей зафиксирован в [`package-lock.json`](../package-lock.json); `@audio/neural-separate` содержит собственный `NOTICE`.

- MRX ONNX: MIT, Copyright (c) 2023 Mitsubishi Electric Research Laboratories (MERL). Модель обучена на Divide and Remaster v2; у исходных наборов данных собственные лицензии, в том числе с некоммерческими условиями. Модель `audiojs/mrx` закреплена на revision `dedc823a0bea2ed085d19e8b7f32589d35169ee8`; SHA‑256 и полная атрибуция находятся в `LICENSES\MRX-MODEL-CARD.txt`.
- `@audio/neural-separate` 0.6.0 и `@audio/neural-runtime` 0.1.1: MIT; исходники — [audiojs/neural](https://github.com/audiojs/neural).
- `onnxruntime-node` 1.29.0: MIT; полный текст находится в `LICENSES\ONNX-RUNTIME-MIT.txt`, исходники и версия перечислены в `LICENSES\THIRD-PARTY.txt`.
- `ffmpeg`: LGPL‑3.0-or-later, сборка BtbN win64-lgpl ветки 9.0 (`n9.0.2-17-g2a571b6068`). SHA‑256 и соответствующие исходники описаны в `LICENSES\FFmpeg-BUILD-PROVENANCE.txt` и `LICENSES\THIRD-PARTY.txt`; полный текст LGPL находится в `LICENSES\FFmpeg-LGPL-3.0.txt`.
- Electron и Chromium: тексты лицензий находятся в `LICENSES\Electron.txt` и `LICENSES\Electron-Chromium.html`.
- Node.js: MIT; официальный архив и SHA‑256 указаны в `LICENSES\THIRD-PARTY.txt`.

Отдельная лицензия самого проекта в репозитории не заявлена.
