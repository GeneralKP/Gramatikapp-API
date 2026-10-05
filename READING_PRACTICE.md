# Reading and Spanish translation practice

After a word study session, the next app visit automatically prepares a
C1 reading exercise. The words come from the authenticated account's saved app
review events. A break of 30 minutes closes a session; phrase reviews also count
as activity when determining that break. The most recent completed session is
used, even if another session is currently active. Returning to the browser tab
or navigating to the dashboard/reading screen refreshes session availability.

Both card directions share one vocabulary entry. Distinct meanings remain
separate. Undo does not remove a word from the session: the learner still
practiced it. Cards merely displayed without a saved rating are not included.
The original Anki archive is not treated as new app activity.

## Text and feedback

Each page targets 450–600 German words, with a hard acceptance range of 350–650,
and uses up to 30 vocabulary entries. Large sessions become connected pages;
no word is silently truncated. A generation request returns German and Spanish
together, plus an audit of the actual word forms and example sentences. The
server checks complete vocabulary IDs, literal usage, word boundaries, and
text lengths before storing a page. If an audit copies a dictionary article
instead of the case used in its exact example, the server finds the actual
article within the same definite/indefinite/negative article family. The noun,
example, and German/Spanish prose stay unchanged. Negation changes, invented
examples, different nouns and missing words are still rejected.
These checks catch structural omissions;
linguistic correctness and faithful meaning remain model quality requirements.

The prompt asks for coherent adult C1 prose, contextual use of every target
meaning, correct inflection and separable verbs, and a faithful idiomatic
Spanish reference. Source notes are explicitly treated as untrusted data.

The dashboard offers the exercise and the menu has a permanent reading link.
Each saved exercise has its own `/reading/:lessonId` URL, so a newly completed
study session cannot replace a text while the learner is translating it.
The learner sees the German original and writes the entire Spanish translation
in a textarea. Drafts are saved in account/lesson/page-scoped browser storage.
The submitted translation and feedback are also stored on the server.

Assessment accepts valid paraphrases and regional Spanish. It returns a score,
Spanish explanations, a corrected version preserving valid learner choices,
specific meaning/grammar/vocabulary/style corrections, omissions, and feedback
on each studied word. The score is exercise feedback, not CEFR certification.
Corrections can insert missing text or delete added text; the UI labels an
empty replacement as a removal. A correction with both excerpts empty is
rejected, and every nonempty original must match the learner's submission.
Spanish reference text is withheld by the GraphQL service until that page has
a successful assessment. React renders all prose as text, not HTML.

Reading and translation assessment do not change card schedules or failure
counters. The correction history is retained separately.

## OpenAI setup

Keep the existing MongoDB and authentication configuration. Add this server
environment variable locally or in the deployment's secret store:

```dotenv
OPENAI_API_KEY=your_key_here
```

Restart the API after changing its environment. Never put this key in a Vite
variable or browser code. Both operations use the Responses API with
`model: "gpt-6-luna"`, `reasoning: { effort: "high" }`, strict JSON schemas,
and `store: false`. The model is deliberately fixed to the user's request.
The normal URL is `https://api.openai.com/v1/responses`.

Without a key, session vocabulary and already generated exercises remain
available; new generation and checking explicitly report configuration missing.
There is no fabricated-content fallback. `OPENAI_BASE_URL` exists to point
integration tests at a local Responses fixture, and should normally be unset.
Billing/quota failures show a specific instruction to check credits or the
reported spending/usage limit; they are distinguished from temporary rate
limits. Provider error bodies and credentials are never returned to the client.

## GraphQL operations

Authentication comes from the normal Bearer token. These operations derive the
account from that token, so clients cannot select another user ID.

```graphql
query ReadingPractice {
  readingPractice {
    configured
    session { id endedAt words { id german spanish } }
    lesson { id status pageCount pages { index title german spanish } }
  }
}

mutation Generate($sessionId: ID!) {
  generateReadingLesson(sessionId: $sessionId) {
    id status pageCount pages { index title german }
  }
}

mutation Check($lessonId: ID!, $pageIndex: Int!, $translation: String!, $requestId: String!) {
  checkReadingTranslation(lessonId: $lessonId, pageIndex: $pageIndex,
    translation: $translation, requestId: $requestId) {
    id status error
    feedback { score summary correctedSpanish }
  }
}
```

`readingLesson(id)` fetches a saved exercise owned by the current user. Generation
returns quickly with `GENERATING`; checking returns `CHECKING`. The browser polls
every two seconds while work is pending. Pages are saved incrementally and can
be read while later pages are being prepared. The exercise UI supports English,
Spanish, and German, plus mobile and dark themes.

## Persistence and retries

`readinglessons` has a unique account/session index. Concurrent visits and
repeated generation calls share one lesson. Completed pages are immutable and
reused after a failed later page. Retrying only generates unfinished pages.

`translationattempts` has a unique account/request-ID index. Repeating the same
ID and submission reuses the result. Reusing an ID for another translation,
page, or lesson is rejected. Editing a translation creates a fresh request ID.
Successful feedback never replaces the user's editable draft.

Background work has a five-minute database lease, renewed before each page,
and a four-minute provider request timeout. Expired work is marked failed and
can be resumed explicitly. This implementation runs jobs in the API process;
a restart interrupts in-flight work, then the lease recovery permits retry.
A crash after the provider responds but before saving can require another paid
request. Browser retries with an acknowledged saved result do not cause that.

## Verification

```sh
npm run test:reading-validation
npm run test:reading
# With the web dev server on localhost:5173:
npm run test:reading-browser
# Optional paid test against the running API and real OpenAI account:
npm run test:reading-live
```

These tests exercise the real GraphQL schema and MongoDB with synthetic users
and vocabulary, removing their records afterwards. The browser test runs a
separate API process so it does not alter the development API's environment.
Only the external OpenAI response is a local fixture. Tests cover session
boundaries, Undo inclusion, direction deduplication, page coverage, hidden
references, ownership, duplicate commands, rejected invented corrections,
partial generation recovery, short Spanish references, draft reload, lost
responses, revisions, stable exercise URLs during newer sessions, return visits,
quota error handling, and mobile layout. They do not establish live Luna
linguistic quality or account/model access.

The live test uses a temporary account with 12 meaningful German vocabulary
entries, generates one page, then checks Spanish containing separate deliberate
grammar and meaning errors and a faithful translation control. It authenticates
through the running API, verifies server
validation and reference reveal, saves the actual page/feedback privately to
`../.local/reading-tests/live-luna-reading.json`, and removes all temporary
database records. A failed generation does not submit a translation check.
For debugging, `npm run test:reading-live -- --reuse-generation` can revalidate
the captured real provider response in `live-generation-replay.json` and run
new live corrections without paying to regenerate its unchanged prose.

On 2026-10-05, after API credits were added, real Luna 6/high requests succeeded.
The final reviewed page has 535 German words and all 12 vocabulary entries.
Live feedback caught a meaning error and a separate Spanish agreement error
(87/100); the faithful Spanish reference scored 100/100. An earlier faithful
paraphrase scored 99/100. Draft preservation and reference reveal also passed
through the authenticated API. Temporary database records were removed.

Live testing exposed and fixed a copied nominative article in the vocabulary
audit and rejection of valid deletion corrections. The deterministic validator
tests cover those cases, and the browser test covers the removal label. The
prompt also clarifies Spanish ambiguity, actor continuity, and optional style
feedback. The generated sample is saved privately to
`../.local/reading-tests/live-reading-sample.md`.

Official references: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[reasoning effort](https://developers.openai.com/api/docs/guides/reasoning),
[structured output](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
