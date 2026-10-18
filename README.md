# MRX Desktop

Офлайн‑приложение для Windows x64, которое разделяет аудио и звуковые дорожки видео на речь, музыку и эффекты. MRX запускается отдельным небольшим окном: браузер, Python, установленный Node.js и интернет для обработки не нужны.

## Запуск готовой папки

Распакуйте `MRX.zip` в папку с любыми пробелами или кириллицей и дважды нажмите `MRX.exe`. Откроется окно MRX; перетащите туда один или несколько аудио/видео файлов. Обработка выполняется последовательно на CPU. Для готовой задачи доступны три WAV, ZIP и кнопка «Открыть папку».

Результаты автоматически сохраняются рядом с `MRX.exe` в `data\outputs\<идентификатор-задачи>`. После завершения очереди кнопка «Сохранить всё» скачивает один ZIP с отдельной папкой для каждого готового файла; ошибки и отменённые задачи в архив не попадают. Входные временные файлы удаляются после завершения или отмены. Нажатие X или «Закрыть приложение» корректно останавливает только процессы MRX; если задача активна, приложение попросит подтверждение отмены.

Папка portable уже содержит Node.js runtime, ONNX Runtime CPU, pinned‑модель MRX, локальную LGPL‑сборку FFmpeg и Microsoft Visual C++ x64 runtime. Устанавливать что‑либо отдельно не требуется. Повторный запуск второй копии переводит фокус на уже открытое окно.

## Производительность и ограничения

Звук из видео декодируется встроенным FFmpeg в PCM 44,1 kHz, затем обрабатывается моделью MRX. WAV сохраняются как 16‑bit PCM и сохраняют длительность входного звука. Модель CPU использует заметную память: для длинных видео может потребоваться 16–32 ГБ RAM. Максимальный размер декодированного PCM ограничен 1,5 GB (`MRX_MAX_DECODE_BYTES` можно изменить при ручном запуске сервера).

## Сборка из исходников

Требуется Windows x64, PowerShell 5+ и доступ к npm/Hugging Face только на этапе сборки. Закреплённые версии находятся в `package-lock.json`; официальный Electron x64 архив и Node.js проверяются по SHA‑256.

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 `
  -FfmpegSourceArchive vendor-sources\FFmpeg-eceaa54a3880dad139edb4e3bfe9c548246558cb.tar.gz
```

Скрипт создаёт `dist\MRX` и `dist\MRX.zip`, включая `MRX.exe`, `resources\app`, runtime, модель, FFmpeg, данные и тексты лицензий. Исходники приложения и скрипты сборки сохраняются в `source\` внутри portable‑папки. Передача `-FfmpegSourceArchive` добавляет точный исходный архив FFmpeg в `LICENSES\FFmpeg-SOURCE-ARCHIVE.tar.gz`; provenance и checksum BtbN сохраняются рядом. Путь к локальному комплекту FFmpeg можно передать через `-FfmpegSource <каталог-с-ffmpeg.exe>`. Для копирования легитимных файлов Microsoft VC++ можно явно указать `-VCRedistDir <Microsoft.VC143.CRT\x64>`.

Для проверки серверного слоя без окна:

```powershell
$env:MRX_NO_BROWSER='1'
$env:MRX_FFMPEG="$pwd\tools\ffmpeg-staging\ffmpeg-master-latest-win64-lgpl\bin\ffmpeg.exe"
node app\server.mjs
```

Сервер выбирает порт начиная с `17863`, печатает строку `MRX_READY ...` и привязан к loopback. В desktop‑сборке Electron передаёт ему `MRX_NO_BROWSER=1` и абсолютные пути к `data`, `weights` и `tools`.

## Лицензии и исходники компонентов

Тексты лицензий и атрибуция находятся в `LICENSES\` готовой папки. Состав npm‑зависимостей зафиксирован в `package-lock.json`; `@audio/neural-separate` содержит собственный `NOTICE`.

* MRX ONNX: MIT, Copyright (c) 2023 Mitsubishi Electric Research Laboratories (MERL). Модель `audiojs/mrx` закреплена на revision `dedc823a0bea2ed085d19e8b7f32589d35169ee8`; SHA‑256 указан в `LICENSES\MRX-MODEL-CARD.txt`. Полная атрибуция и model card находятся там же.
* `@audio/neural-separate` 0.6.0 и `@audio/neural-runtime` 0.1.1: MIT; исходники в [audiojs/neural](https://github.com/audiojs/neural).
* `onnxruntime-node` 1.29.0: MIT; полный текст ONNX Runtime находится в `LICENSES\ONNX-RUNTIME-MIT.txt`, исходники и версия перечислены в `LICENSES\THIRD-PARTY.txt`.
* `ffmpeg`: LGPL‑3.0-or-later, конкретная win64-lgpl сборка и SHA‑256 указаны в `LICENSES\THIRD-PARTY.txt`; полный текст LGPL находится в `LICENSES\FFmpeg-LGPL-3.0.txt`.
* Electron и Chromium: лицензии находятся в `LICENSES\Electron.txt` и `LICENSES\Electron-Chromium.html`.
* Node.js: MIT; официальный архив и SHA‑256 указаны в `LICENSES\THIRD-PARTY.txt`.
