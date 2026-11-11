# TeamBridge Interview

A Windows desktop assistant for interviews. It opens **Windows Live Captions** to show what is being said, sends the interviewer's questions from the captions to ChatGPT, and keeps a chat open with the support team watching the round on TeamBridge Web.

> **Status:** early alpha. The app does no audio capture or speech recognition of its own — listening is done entirely by Windows Live Captions.

---

## How it works

1. Pick an interview from the list (read from your TeamBridge server).
2. Press **Start Listening**. The app opens a TeamBridge session for the round and launches Windows Live Captions.
   Press **Open ChatGPT** (next to Start Listening, and in the header while listening) to open the ChatGPT desktop app with a briefing — the candidate, the job description, and the resume — pasted into the message box. It is not sent: review it and press Enter yourself. The briefing also stays on the clipboard, so if ChatGPT cannot be brought to the front it is one paste away.
3. While listening, the window splits 60/40: the chat with the support team on the left, Live Captions on the right, refreshed every second. The complete sentences since the last send are strongly highlighted; the sentence still being spoken is lightly highlighted and held back until it ends.
4. When the interviewer finishes a question, use the buttons under the captions: **Send to assistant** posts the highlighted sentences into the support chat, and **Ask GPT** pastes them into ChatGPT and sends them. Each send starts the next collection just after the last completed sentence. If one button has just sent, the other sends that same question when nothing new has been said, so both can see it — but neither gets it twice. The capture hotkey (default **Ctrl+Alt+Q**, set in **Settings → Hotkeys**) does the same as Ask GPT.
5. Press **Stop** to finish the run on TeamBridge. Live Captions stays open until you close it.

The chat is a conversation with the support team watching the round on TeamBridge Web: their notes and suggested answers arrive in it, and the box under it sends your messages to them. It is open whenever an interview is, listening or not.

**Recruitment Details** opens the candidate, job, and resume beside the interview.

The global hotkey (default **Ctrl+Shift+Space**) and the tray menu open Live Captions at any time.

---

## Architecture

Electron, with hard boundaries between processes.

```
┌───────────────────────────────────────────────────────────────┐
│ Renderer (React + TypeScript)                                  │
│  · interview list · chat · captions · overlay · settings     │
│  no filesystem, no network, no API keys — contextIsolation on  │
└──────────────────────────┬────────────────────────────────────┘
                           │ typed IPC (preload contextBridge)
┌──────────────────────────┴────────────────────────────────────┐
│ Main (Node)                                                    │
│  · window/tray/global shortcut  · TeamBridge REST + realtime   │
│  · Live Captions launcher       · secret storage (safeStorage) │
└───────────────────────────────────────────────────────────────┘
```

- **Every credential lives in main**, encrypted with Electron's `safeStorage` (DPAPI-backed on Windows). The renderer can ask for an answer; it can never see the API token.
- **Live Captions is launched and read.** The capture hotkey reads the caption text through UI Automation (the `CaptionsTextBlock` element), called directly from the main process with koffi — no helper process. The app starts `%SystemRoot%\System32\LiveCaptions.exe` detached, so it outlives the app and is the user's to close. If it is missing (Windows older than 11 22H2), Start Listening reports that instead of starting.

---

## Stack

| Layer | Choice |
|---|---|
| Shell | Electron 33 |
| Language | TypeScript, strict |
| UI | React |
| Build | electron-vite, electron-builder (NSIS installer) |
| Captions | Windows Live Captions |
| Logging | Pino |
| Secrets | `safeStorage` |

---

## Getting started

**Requirements:** Windows 11 22H2 or later (for Live Captions), Node 20+.

```bash
npm install     # also draws the icons
npm run dev     # Electron + Vite with HMR
```

Set the TeamBridge server URL and API token in **Settings**, then open an interview.

Other commands:

```bash
npm run typecheck    # both tsconfig projects
npm run build        # production bundles into out/
npm run dist         # NSIS installer into release/
```

---

## Privacy

- **The app never touches audio.** Captioning is done by Windows Live Captions, on the device.
- **Only what you type, or choose to send from the captions, reaches TeamBridge**, as chat messages on the round.
- **You are responsible for consent.** Captioning a conversation without the other participants' knowledge may be unlawful where you are.

---

## License

TBD.
