# Sınav Motoru

[Türkçe](README.tr.md)

A small web-based exam system for technical training classes. Participants open a link
or scan a QR code, enter their details and take the exam on their own device. Results go
only to the instructor's private Google Sheet; participants do not see their scores.

The user interface is in Turkish.

**This repository contains no questions, answers or exam content.** It holds only the
engine that displays an exam.

## How it works

| Part | Where | Role |
|---|---|---|
| Exam page | GitHub Pages (`docs/`) | Entry screen, question display, timer, submission. No questions. |
| Back end | Google Apps Script (`google/Code.gs`) | Checks access codes, serves questions, scores, writes results. |
| Question pool and records | The instructor's private Google Drive | Questions as Google Docs; exams, sessions and results in a Google Sheet. |

## Privacy and integrity

- Questions are served only with a valid session code or personal code.
- The answer key never reaches the browser; scoring is done on the server.
- Answer options can be shuffled for each participant.
- Answers are saved as they are marked; after a lost connection the exam resumes where it left off.
- The question pool is checked automatically. A question that cannot be read completely, or
  that changed after approval, is quarantined and is not used until it is fixed.

---

Author: ALP ATA
