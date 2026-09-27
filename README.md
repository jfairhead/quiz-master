# Clarrie's Quiz Machine

Pub quiz practice in rounds of 10, with a scorecard after each round. Installable as a phone app (PWA) and works offline.

## Publish on GitHub Pages
1. Create a new public repo, e.g. `quiz-master`, on the jfairhead account.
2. Upload every file in this folder (all files sit in one folder).
3. Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
4. After a minute it's live at `https://jfairhead.github.io/quiz-master/`.

## Install on a phone
- iPhone: open the link in Safari → Share → Add to Home Screen.
- Android: open in Chrome → tap "Install on this device" on the home screen (or menu → Install app).

## Questions
- `questions.js` holds 161 built-in questions across 9 categories. These always work, even offline.
- With "Mix in fresh questions" ticked, each round also pulls up to 6 questions from
  The Trivia API (UK-made) and Open Trivia DB. If they're unreachable, the round is all built-in.
- The app remembers which questions have been seen and avoids repeats until a category runs out.
- To add questions, copy a line in `questions.js` and edit it.

## Updating
After changing any file, bump `CACHE = 'cqm-v1'` in `sw.js` (to `cqm-v2`, etc.) so installed copies refresh.
