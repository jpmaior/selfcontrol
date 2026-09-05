# TODO

Android findings from the first on-device test are tracked separately in
[TODO-ANDROID.md](./TODO-ANDROID.md) and are still open.

## Fixed: hands-off playback under-counted (2026-09-05)

**Symptom:** watching a video without touching the computer registered less time than was
spent. A 7-minute video showed as exactly 5:00 in the popup. Interacting with the computer
while the video played made the problem go away.

**Cause:** a stop (pause, ending, tab closed, or a quiet stretch dropping `audible`) that landed
on an unloaded event page was settled by `store.reconcile()`, which credited the leftover
interval only up to the last flush. The last flush was the 5-minute checkpoint, which had also
restarted the interval, so the 2 minutes after it were credited as zero. The reasoning was that
the stop time was unknown; it is not, because the stop is the event that wakes the page. Videos
with silent gaps stopped many times and compounded the loss.

**Fix:** `reconcile` settles up to `now`. The existing sleep clamp (`MAX_CHUNK_MS`, 7.5 min)
bounds a suspended machine. `meta:lastFlush` had no other reader and was removed along with its
write in `flush()`; installs that already hold the key keep a harmless orphan in
`storage.local`. Tests, PLAN.md Checkpoint 4 item 3 and DESIGN.md §5 updated.

**Still to check by hand** (the pure tests cover the arithmetic, not Firefox):

1. Start a video, close the console, let it run past one checkpoint, wait ~2 more minutes and
   pause. Reopen the console. Expect `reconciled youtube: credited 2:00 …` (roughly) and
   `dumpUsage()` matching the clock.
2. Play, unload the page, suspend the laptop for >10 min, resume, pause. The `reconciled` line
   must credit no more than 7:30.

**Known and accepted:** the observers still *drop* the waking event itself because they run with
an empty rule set until `setRules()` lands. That is harmless — reconcile covers stops and
`prime()` re-derives starts — but it is why `reported` cannot be trusted across a restart.
