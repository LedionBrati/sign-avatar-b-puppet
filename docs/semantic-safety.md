# SIGNLAYER playback safety boundary

This PR is based on `nikos/app-base` and depends on PR #20 until that branch merges. It does not change the translator, clips, player, or UI. `app/server/lib/semantic-safety.mjs` checks the existing translator plan against the loaded clip manifest immediately before the server returns a playlist. Its statuses are engineering workflow states, **not ASL linguistic certification**. No available clip has been certified by this module for sign meaning or grammar.

## API contract

`POST /api/sign` keeps its current response and adds `safety`:

```json
{
  "text": "I don't want that.",
  "playlist": [],
  "markers": [],
  "safety": {
    "status": "caption_only",
    "caption": "I don't want that.",
    "reasons": [{"code":"unrepresented_negation","tokens":["don't"],"next_action":"Supply a verified negating sign or use the full English caption."}],
    "next_actions": ["Supply a verified negating sign or use the full English caption."]
  }
}
```

`text` and `safety.caption` preserve the exact request string, including whitespace and punctuation. Existing `words` still uses the translator's normalized text for word timing. `fully_supported` means every planned item has a matching loaded clip and no unresolved rule fired. `needs_confirmation` means an ambiguous sense or semantic match needs a human choice. `caption_only` means the message cannot be represented reliably with current assets. Both blocked states have empty `playlist` and `markers`; there is no automatic partial-signing mode. `GET /api/sign.mp4` uses the same gate and returns HTTP 422 with `text`, `playlist: []`, `safety`, and `error.code: "signing_not_supported"` for either blocked state.

Reason objects have a stable `code`, affected `tokens`, and `next_action`; they may include `item_index`, `motion_id`, `missing_letters`, `proposed_gloss`, or `score`. Current codes: `unsupported_token`, `missing_clip`, `missing_fingerspelling`, `unrepresented_negation`, `numerical_meaning`, `dropped_meaning`, `ambiguous_sense`, `semantic_uncertainty`, `semantic_substitution`, `invalid_plan`, `no_signs`. Multiple reasons can be returned; a hard failure takes precedence over a confirmation request.

## Handoff for Nikos's clients

Read `safety.status` before enqueuing any `playlist` items. For `fully_supported`, current playback remains valid. For `needs_confirmation`, show the full `safety.caption` and the reason and request a sense-specific choice; keep playback stopped until a future explicit confirmation route exists. For `caption_only`, show the full caption and reason, with no signing animation. The web, mobile, and extension can use the same `SigningSafety` type from `@signlayer/core`. The field is optional in the TypeScript interface solely so older/mock responses still compile; the real server always returns it. Existing clients already avoid playback for an empty playlist, but they do not yet render the new reason text. They should not infer “signed” from a prior phrase's queued clips when the current phrase is blocked.

If a user confirms a homograph, the translator/clip catalog needs an explicit sense-specific motion mapping before the message can be signed. Repeating the same request does not clear `needs_confirmation`. This PR deliberately does not add a confirmation bypass.

## Reproduced failures and new behavior

| Input | Before | After with synthetic fixtures |
| --- | --- | --- |
| `I don't want that.` | `I WANT THAT` prefix could play while `not` was unsupported | `caption_only`, `unrepresented_negation`, no playlist |
| `Turn right at the bank.` | `TURN RIGHT BANK` could play with unselected senses | `needs_confirmation`, no playlist |
| `You have to pay a fine.` | `FINE` could be used with the wrong sense | `needs_confirmation`, no playlist |
| `My spouse needs help.` | Local semantic similarity could choose `HUSBAND` | `caption_only` for this substitution; unsupported spouse also blocks |
| `My appointment is at 3:30.` | Any supported prefix could play without the time | `caption_only`, numerical and unsupported reasons |
| `Hello, my name is Maria.` | `HELLO MY NAME` could play with no letter clips | `caption_only`, missing fingerspelling letters |
| `Hello, thank you.` | Complete clip sequence played | Complete clip sequence still plays |

The fixtures in `app/server/test/semantic-safety.test.mjs` are synthetic bytes, **not ASL recordings**. The tests establish routing and all-or-nothing behavior only. Other risks remain: exact or curated-synonym gloss matches may still use a sign with the wrong sense, grammatical ASL is not checked, a loaded clip may have poor signing or rights/QA gaps, and the current manifest has no sense metadata. The fixed `Where does it hurt?` rule permits the translator's dropped `it` because `HURT WHERE` carries the location question in this demo; this is an engineering compatibility exception, not signer validation. Number words and digit times are caption-only until exact numeral and time rendering is reviewed.

## Run checks

```sh
cd translate && npm ci --ignore-scripts --no-audit --no-fund && cd ..
node --test translate/test/*.test.mjs
node --test shared/*.test.mjs
node --test app/server/test/*.test.mjs
```

No real or restricted WLASL media is used by the new tests. For the first real asset check, supply a licensed, signer-reviewed clip manifest via `CLIPS_DIR`, run the server, and request both `POST /api/sign` and `GET /api/sign.mp4` for a complete message and a blocked message. The safety gate must not be treated as a replacement for fluent-signer QA.

Local check on 2026-11-15: the combined translator, shared-contract, and server suite reported **106 tests: 59 passed, 0 failed, 47 skipped**. The skipped cases require the optional dictionary manifest or real clip set. Core and web TypeScript checks passed; the web production build passed. The new server safety tests use synthetic fixture clips only.
