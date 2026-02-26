# BeatForge — Flow działania aplikacji

## Architektura ogólna

```
Frontend (React + Vite)          Backend (Node.js + Express)
  web/src/                          backend/src/
  ├── pages/                        ├── routes/
  │   ├── Studio.tsx                │   ├── upload.ts
  │   ├── Clips.tsx                 │   ├── transcribe.ts
  │   ├── TextHooks.tsx             │   └── generate.ts
  │   └── Library.tsx               ├── services/
  ├── context/AppContext.tsx         │   ├── beatDetection.ts
  └── lib/api.ts                    │   ├── captions.ts
                                    │   ├── videoAssembler.ts
                                    │   └── platformProfiles.ts
                                    └── utils/
                                        ├── db.ts
                                        ├── jobs.ts
                                        └── helpers.ts
```

---

## KROK 1 — Upload MP3 (audio track)

### Co robi użytkownik
- Otwiera zakładkę **Studio**
- Wybiera plik audio z biblioteki (już wcześniej wgrane tracki) **LUB** klika "Wgraj plik audio z PC" i wybiera `.mp3 / .wav / .aac / .flac / .m4a`

### Co dzieje się w kodzie

**Frontend — `Studio.tsx` → `handleAudioFile(file)`**
1. Wywołuje `uploadMusic(file)` z `lib/api.ts`
2. `POST /api/upload-music` — multipart FormData z polem `file`

**Backend — `routes/upload.ts` → `POST /api/upload-music`**
1. Multer generuje unikalny `music_id` (nanoid)
2. Zapisuje plik na dysku: `storage/music/{music_id}/{originalname}`
3. Wywołuje `saveTrack()` — zapisuje metadane do lokalnej bazy SQLite (`db.ts`)
4. Zwraca: `{ music_id, filename, size }`

**Frontend — po odpowiedzi**
1. Tworzy obiekt `Track` i dodaje do globalnego stanu (`AppContext`)
2. Ustawia `studioTrackId = music_id`
3. **Auto-trigger**: wykrywa że track nie ma transcription → wywołuje `handleTranscribe()`

---

## KROK 2 — Transkrypcja (Whisper AI)

### Co robi użytkownik
- Dzieje się **automatycznie** po wybraniu tracka
- Użytkownik widzi spinner "Whisper transkrybuje…"
- Może potem edytować tekst w panelu "Transcribe Lyrics"

### Co dzieje się w kodzie

**Frontend — `Studio.tsx` → `handleTranscribe(force?)`**
1. Wywołuje `transcribeTrack(music_id, force)` z `lib/api.ts`
2. `POST /api/transcribe` z body `{ music_id, force: false }`

**Backend — `routes/transcribe.ts` → `POST /api/transcribe`**
1. Sprawdza czy jest cache w SQLite (`getTranscription(music_id)`)
2. Jeśli cache HIT → zwraca od razu z flagą `cached: true`
3. Jeśli cache MISS:
   - Wywołuje `transcribeAudio(filePath)` — **Whisper** (model `whisper-base` przez `@xenova/transformers`, ONNX quantized)
   - Równolegle `getVideoDuration(filePath)` — ffprobe
   - Zwraca segmenty z timestampami `{ start, end, text, word? }`
4. Zapisuje wynik do SQLite (`saveTranscription`)
5. Aktualizuje czas trwania tracka w DB (`saveTrack`)
6. Zwraca: `{ music_id, segments[], full_text, duration, cached }`

**Frontend — po odpowiedzi**
1. `setTranscription(musicId, segments)` → cache w AppContext
2. `setEditedText(full_text)` → wyświetla edytowalny tekst
3. Jeśli segmenty mają flagę `word: true` → ładuje `WordTimestampEditor` z edycją per-słowo

### Dane segmentu transkrypcji
```ts
interface TranscriptionSegment {
  start: number;   // np. 0.0
  end:   number;   // np. 1.4
  text:  string;   // np. "never"
  word?: boolean;  // true = word-level timestamps
}
```

---

## KROK 3 — Upload klipów MP4 (Clips page)

### Co robi użytkownik
- Otwiera zakładkę **Clips**
- Klika "⬆ Upload klipów"
- Opcjonalnie nadaje nazwę kolekcji
- Wybiera **Mood Folder** (High Energy / Hype / Dark / Sad / Chill / Aggressive / Aesthetic / Motivational lub własny)
- Przeciąga pliki MP4/MOV/AVI/MKV/WEBM do drop zone lub klika

### Co dzieje się w kodzie

**Frontend — `Clips.tsx` → `handleFiles(files)`**
1. Waliduje rozszerzenia plików
2. Wywołuje `uploadClips(files)` z `lib/api.ts`
3. `POST /api/upload-clips` — multipart FormData z polem `files` (multi)

**Backend — `routes/upload.ts` → `POST /api/upload-clips`**
1. Multer generuje jeden `clips_id` dla całej paczki
2. Zapisuje wszystkie pliki: `storage/clips/{clips_id}/{filename}`
3. Zwraca: `{ clips_id, count, files[] }`

**Frontend — po odpowiedzi**
1. Tworzy obiekty `Clip[]` z przypisanym `clips_id`
2. Wywołuje `addClips(newClips)` → globalny stan
3. Tworzy `Collection` z nazwą, `clips_id`, przypisanym `folderId` (Mood)
4. Wywołuje `addCollection(collection)` → globalny stan
5. Użytkownik może kliknąć "→ Studio" na karcie kolekcji → `setStudioCollection(colId)` + nawigacja do Studio

### Struktura Collection
```ts
interface Collection {
  id:        string;   // == clips_id z backendu
  name:      string;   // np. "⚡ High Energy 1"
  clips:     Clip[];
  folderId?: string;   // MoodFolder.id
}
```

---

## KROK 4 — Text Hooks (TextHooks page)

### Co robi użytkownik
- Otwiera zakładkę **Text Hooks**
- Wpisuje tekst hooka (np. "Nikt ci o tym nie powie, ale…")
- Wybiera Mood Folder (ten sam system co kolekcje klipów!)
- Klika "Dodaj hook" lub używa przykładów gotowych
- Opcjonalnie klika "→ Studio" na karcie hooka

### Co dzieje się w kodzie

**Frontend — `TextHooks.tsx` → `handleAdd()`**
1. Tworzy obiekt `TextHook` z `{ id, text, category: moodId, createdAt }`
2. Wywołuje `addHook(hook)` → globalny stan `AppContext`
3. Brak zapytania do backendu — **TextHooks są state-only (in-memory)**

**"→ Studio" na hooku**
1. `setStudioHook(hook.id)` → zapisuje w globalnym stanie
2. W Studio `studioHookId` jest dostępne ale **aktualnie nie jest przekazywane do backendu** (przygotowane jako przyszły feature)

### Dostępne Mood Folders (shared z Clips)
```
⚡ High Energy | 🔥 Hype | 🖤 Dark | 💔 Sad
🌊 Chill | 👊 Aggressive | 🌸 Aesthetic | 🚀 Motivational
+ własne niestandardowe
```

---

## KROK 5 — Studio: konfiguracja wideo

### Co robi użytkownik w Studio

1. **Audio** — wybiera track z biblioteki lub wgrywa nowy
2. **Transcribe Lyrics** — opcjonalnie edytuje tekst lub timestamp per-słowo
3. **Choose Video Style** — wybiera kolekcję klipów z siatki (filtrowanej po Mood)
4. **Customize Lyrics** — wybiera styl tekstu + kolor
5. Klika **"▶ Preview 5s"** lub **"✦ Generate video"**

### Lyric Styles (front → backend mapping)

| UI Label   | CSS preview                        | FFmpeg style  |
|------------|------------------------------------|---------------|
| BRAT       | font-weight:900, uppercase         | bold_center   |
| CAPS       | uppercase, letter-spacing          | bold_center   |
| Statement  | font-size:1.1rem, italic           | bold_center   |
| Classic    | font-size:0.85rem, regular         | minimal_clean |
| Simple     | font-size:0.82rem, light           | minimal_clean |
| Bold       | font-size:0.95rem, font-weight:800 | bold_center   |

---

## KROK 6 — Generate Preview (5 sekund)

**Frontend — `Studio.tsx` → `handlePreview()`**
1. `POST /api/generate-preview` z body:
```json
{
  "music_id": "abc123",
  "clips_id": "def456",
  "caption_style": "bold_center",
  "preview_duration": 5
}
```

**Backend — `routes/generate.ts`**
1. `analyseBeats(mPath)` — wykrywa BPM i punkty cięcia
2. `assemblePreview(cPaths, mPath, beats, 5s, outPath)` — FFmpeg montuje preview
3. Zwraca: `{ preview_url, bpm }`

**Frontend — po odpowiedzi**
1. Wyświetla wideo w Phone Preview (9:16, 196px szerokości)
2. Pokazuje badge "🥁 {bpm} BPM"

---

## KROK 7 — Generate Batch (pełne wideo)

**Frontend — `Studio.tsx` → `handleGenerate()`**

Zbiera dane:
- `music_id` z wybranego tracka
- `clips_id` z wybranej kolekcji
- `caption_styles` = zmapowany styl FFmpeg
- `video_duration` = 20s (hardcoded)
- `segments` = edytowane segmenty z WordTimestampEditor (jeśli dostępne) → pomija Whisper na backendzie

```json
POST /api/generate-batch
{
  "music_id": "abc123",
  "clips_id": "def456",
  "caption_styles": ["bold_center"],
  "video_duration": 20,
  "batch_count": 1,
  "segments": [
    { "start": 0.0, "end": 0.5, "text": "never" },
    { "start": 0.5, "end": 1.2, "text": "gonna" }
  ]
}
```

**Backend — `routes/generate.ts` (async background job)**

1. Tworzy Job w pamięci: `{ id, status: "queued" }`
2. Zwraca od razu `{ job_id, status: "queued" }` (nie blokuje!)
3. W tle (`setImmediate`):
   - `analyseBeats(mPath)` → BPM + cut_points
   - Używa `segments` od klienta LUB uruchamia `transcribeAudio()` (Whisper fallback)
   - Dla każdego stylu/platformy:
     - Generuje plik `.ass` (napisy) przez `buildAssSimple()` lub `buildAssKaraoke()`
     - `assembleVideo()` — FFmpeg składa wideo: klipy + muzyka + napisy
     - `extractThumbnail()` — miniaturka z FFmpeg
     - `addOutput(job.id, { variant, platform, video_url, caption_url })`
   - `updateJob(job.id, { status: "done" })`

**Frontend — polling co 3 sekundy**
1. `GET /api/jobs/{job_id}` co 3000ms
2. Wyświetla `BatchStatus` z progress barem
3. Gdy `status === "done"` — pokazuje przyciski do pobrania `⬇ MP4` i `SRT`

---

## Schemat danych (AppContext — globalny stan)

```
AppContext
├── tracks[]           ← wgrane audio tracki
├── clips[]            ← wszystkie klipy (z clips_id)
├── collections[]      ← zgrupowane klipy w kolekcje
├── hooks[]            ← text hooks (in-memory only)
├── moods[]            ← Mood Folders (shared)
├── transcriptions{}   ← cache: music_id → segments[]
│
├── studioTrackId      ← wybrany track do generowania
├── studioCollectionId ← wybrana kolekcja klipów
├── studioHookId       ← wybrany text hook (future feature)
├── studioLyricStyle   ← styl napisów
└── studioLyricColor   ← kolor napisów
```

---

## Endpointy API (podsumowanie)

| Method | Endpoint                | Opis                               |
|--------|-------------------------|------------------------------------|
| POST   | `/api/upload-music`     | Upload MP3/WAV → zwraca `music_id` |
| POST   | `/api/upload-clips`     | Upload MP4s → zwraca `clips_id`    |
| GET    | `/api/tracks`           | Lista wszystkich tracków z DB      |
| DELETE | `/api/tracks/:id`       | Usuń track z DB i dysku            |
| POST   | `/api/transcribe`       | Whisper transcription (z cache)    |
| POST   | `/api/generate-preview` | 5s preview MP4 → zwraca URL        |
| POST   | `/api/generate-batch`   | Full video job → zwraca `job_id`   |
| GET    | `/api/jobs`             | Lista wszystkich jobów             |
| GET    | `/api/jobs/:id`         | Status konkretnego joba            |

---

## Co dzieje się NA DYSKU

```
storage/
├── music/
│   └── {music_id}/
│       └── track.mp3
├── clips/
│   └── {clips_id}/
│       ├── clip1.mp4
│       └── clip2.mp4
├── previews/
│   └── {job_id}.mp4
└── exports/
    └── {job_id}/
        ├── v1_tiktok.mp4
        ├── v1.ass
        └── v1.jpg
```

---

## Przepływ danych (uproszczony)

```
User uploads MP3
      ↓
Backend saves to disk, returns music_id
      ↓
Frontend auto-triggers Whisper transcription
      ↓
Whisper returns word-level segments (cached in SQLite)
      ↓
User edits segments in WordTimestampEditor (optional)
      ↓
User uploads MP4 clips → clips_id
      ↓
User assigns clips to Mood Folder (Collection)
      ↓
User adds Text Hooks with same Mood system (in-memory)
      ↓
Studio: select track + collection + lyric style
      ↓
POST /api/generate-batch
  → analyseBeats (BPM detection)
  → build .ass captions from edited segments
  → FFmpeg assembles: clips + music + subtitles
      ↓
Poll job status every 3s
      ↓
Download MP4 + SRT
```

---

## Znane luki / punkty do poprawy

1. **Text Hooks nie trafiają do wideo** — `studioHookId` jest ustawiane ale `generate-batch` go nie przyjmuje
2. **`studioLyricColor` nie jest wysyłany do backendu** — hardcoded `#FFFFFF` w route
3. **Kolekcje i hooki nie są persystowane** — reset po odświeżeniu strony (tylko tracki + transkrypcje są w SQLite)
4. `video_duration` hardcoded na 20s w frontendzie
5. Tylko platforma `tiktok` jest używana (brak wyboru w UI)
