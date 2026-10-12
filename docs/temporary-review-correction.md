# Temporary reviews retain normal ratings · 12 October 2026

Prepared for the owner-requested web correction and Android 1.7.1 APK. Deployment is pending approval and the exact release checks.

A word with a temporary reminder and a future regular due date previously exposed only Continue and Revisit. Continue cleared the reminder while ignoring the distinction between ordinary recall grades. The corrected shared scheduler always exposes Again, Hard, Good and Easy. Eligible mature words also expose Revisit; phrases retain four ordinary ratings.

Each ordinary rating applies the existing adaptive engine, using early-review elapsed-day rules when the regular date is still in the future, and clears the temporary reminder. Revisit still sets tomorrow's reminder with its existing eligibility protection. The phrase preset and word formula are unchanged. Ratings preserve original occurrence times and command IDs; previously committed review receipts remain idempotent. Existing future dates are untouched until an explicit rating is saved. Undo restores the full previous snapshot, including the reminder.

No fields, collections, indexes, request parameters or data migration are added. The canonical database diagram records the derived options and the resulting writes. Native and web schedulers are regenerated from this authoritative implementation.

## Verification

- The native regression reproduced the unwanted Continue mode before the fix, then passed with all five eligible word controls and distinct ordinary interval labels.
- `npm run test:study-scheduling` checks ordinary grades, shared early-review predictions, DST, earlier-due protection and learning states.
- `MONGODB_URI=mongodb://127.0.0.1:27019/temporary_review_fixture npm run test:temporary-review-ratings` passed 16 actual transaction cases (word/phrase × future/due regular date × four grades): exact preview/persisted date and phase, original time, one receipt, lost acknowledgement replay, stale-version rejection, unchanged mistakes and Undo restoration.
- All existing CI checks are retained. The transaction regression is added to CI on a separate loopback replica set; its script rejects a non-loopback database URI.
- The database diagram opened standalone without application/API requests or JavaScript errors.
