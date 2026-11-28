# I.T.S.S.B. — Arrival estimates, AI, and notifications

**Intelligence Transportation System for School Buses**  
**Status:** Proposed baseline, evaluation plan, and notification architecture. No accuracy or delivery result is claimed as measured.

Related guides: [Data contracts](08_DATA_CONTRACTS_AND_API.md), [Swift app](06_IOS_SWIFT_APP.md), [Backend](07_BACKEND_AND_DATABASE.md), and [Testing](13_TESTING_AND_ACCEPTANCE.md).

## 1. The prediction the family actually needs

The useful question is “When is this active run expected at my assigned stop?” A scheduled pickup time, the bus's position, a current arrival prediction, and an alert delivery time are different values. Show them with labels that preserve that distinction.

The backend should calculate the prediction once from authorized trip data and provide consistent results to iPhone and web clients. The Pi can continue displaying local route progress offline, but it cannot supply families with a new remote prediction while its connection is unavailable.

The 2GB Pi does not need a large language model. The first useful prediction can be ordinary code and historical travel-time data. A learned model is a later candidate that must demonstrate a benefit.

## 2. First establish route progress

Before estimating arrival, determine where the bus is along the correct approved route version. Find plausible nearby route segments, then consider direction, previously accepted progress, expected stop order, and position quality. Do not snap every sample to whichever segment is geometrically nearest if that would jump to the return leg of a loop.

Maintain a progress state such as current segment, distance along that segment, next expected stop, and stop outcomes. A stop can be upcoming, arrived, served, skipped by authorized correction, or unknown. Preserve the difference between an inferred proximity event and a staff-confirmed operational action.

Arrival inference should use multiple observations, speed when available, dwell, and ordered-stop context. Use separate arrival and departure conditions so noisy positions near a boundary do not create repeated arrivals. These thresholds are tuning parameters established by controlled tests. Do not label them as guaranteed distances or safety checks.

If route progress becomes ambiguous, lower confidence or suppress the estimate. A bus on a nearby parallel street should not cause a child's stop to be marked served.

## 3. The baseline calculation

For a student's stop, add the expected travel times of the remaining route segments before that stop and the expected dwell at intervening stops:

```text
remaining duration = remaining segment travel + intervening stop dwell
arrivalAtMs = source position capturedAtMs + remaining duration in milliseconds
```

The estimate is anchored to when the position was captured, not when the server evaluated it, so an old position yields an arrival that is already too early and a validity that has already ended instead of a fresh-looking countdown.

**Implemented baseline (`baseline-v1`).** Remaining segment travel is the remaining distance along the approved path at a configured average cruise speed; dwell is a configured time per intervening stop the bus has not left. Both values live in `apps/backend/convex/lib/eta.ts` and are tuned on training runs only (§6). Progress is computed inside telemetry ingest, in the same transaction, so a superseded asynchronous result cannot replace a newer one; predictions are stored for the newest live position of each batch, one per stop ahead. Per-segment historical durations are the next step once representative runs exist.

### Fictional example

Assume an observation is evaluated at 7:10 AM. Three remaining travel portions are estimated at 90, 120, and 60 seconds. Two pickup stops before the student's stop are expected to take 25 and 35 seconds.

| Contribution | Seconds |
| --- | ---: |
| Remaining travel | 270 |
| Intervening stop dwell | 60 |
| Total remaining | 330 |

The baseline arrival is approximately 7:15:30 AM, or about 5½ minutes away. These numbers explain the algorithm; they are not a prediction for an actual purchased device or route.

Start with configured or collected segment durations. As representative runs accumulate, use robust historical summaries for the same direction and time context. Do not divide straight-line distance by instantaneous speed: at a red light the denominator approaches zero, and straight-line distance ignores the prescribed path and pickups.

A generic mapping service's driving estimate is not automatically the bus service's operational prediction. If an external traffic or directions service is added, document its role, data terms, costs, availability, and fallback. No traffic subscription is included in the seven purchased hardware items.

## 4. Prediction records and freshness

Persist a record of predictions when they are made. Include run, stop, source event, generation time, route/model version, predicted arrival, and eventual independently checked arrival outcome. This enables evaluation of what the system actually told users instead of recalculating favorable predictions after the trip.

The live contract supplies:

- `arrivalAtMs`: the point estimate.
- `generatedAtMs`: when the calculation occurred.
- `validUntilMs`: the maximum validity under the configured policy.
- `sourceEventId`: the observation used.
- `algorithmVersion`: the baseline or model version.
- Optional `lowerArrivalAtMs` and `upperArrivalAtMs`: only after uncertainty is evaluated.

The app should suppress an expired prediction even if the server has not emitted another update. An aging number must not continue counting down until it falsely says “arriving now.” The server's alert worker also checks current time and source freshness before sending.

An asynchronous prediction action can finish after newer telemetry or trip completion. Its final mutation must compare the run, route version, and input revision against current state. Discard a superseded result instead of replacing a newer prediction.

## 5. What the machine-learning stage adds

After collecting representative runs, evaluate whether a learned model can improve remaining-time estimates. Candidate features include segment identity, direction, time of day, weekday, recent movement, remaining distance, remaining stop count, recent dwell, and historical segment statistics available at prediction time.

Do not include student identity or private home address. Do not include future actual arrival, future traffic observations, or a summary calculated using the remainder of the same trip. Those values would not exist when a real prediction is made.

A practical first comparison is the baseline versus a simple regression or gradient-boosted model. Perform training on a development computer or an appropriate separate service. Export a versioned model and its preprocessing together. Keep an explicit switch that selects an approved model version; a training job should not silently change production behavior.

Training data needs reviewed stop-arrival labels. If labels are derived from GPS, inspect failure cases and independently review a sample. A model trained to imitate wrong stop detection can appear accurate against those same wrong labels.

## 6. Evaluate on unseen complete trips

Keep a whole run in one evaluation partition. Train on earlier complete runs and evaluate on later unseen runs; also consider holding out routes if the intended claim includes generalizing to new routes. Nearby points from the same journey are highly related, so a random point-level split can overstate usefulness.

Fit normalization, imputation, and feature selection using training data only. Apply the fitted transformations to validation/test data. This follows the leakage guidance in [scikit-learn's common pitfalls](https://scikit-learn.org/stable/common_pitfalls.html).

Report results by prediction horizon and operating condition, not just one overall average:

| Metric | What it answers |
| --- | --- |
| Median absolute error | What a typical prediction error looks like. |
| Mean absolute error | Average magnitude of error in understandable time units. |
| High-percentile absolute error | How poor the more difficult predictions can be. |
| Coverage | How much of the time before each stop's arrival the system showed a still-valid estimate, rather than withholding it or having no position. Measured in time, so a GPS dropout or a withheld estimate counts against it. |
| Interval coverage | Whether an advertised range actually contains the observed arrival at its intended rate. |
| Early/late bias | Whether the service systematically suggests the bus is sooner or later than it is. |

Measure 2-, 5-, 10-, and 15-minute horizons where enough examples exist. Report the sample count. Keep a final test set that was not used to select the model or tune thresholds. If improvement is small or unreliable, retain the baseline.

**Replay harness.** `bun run eval` in `apps/backend` builds deterministic fictional runs (`apps/backend/eval/tracks.ts`: an invented street grid with traffic, red lights, dwell, GPS noise and upload dropouts), replays every fix through the backend's own progress and estimate code, tunes the baseline on the earlier runs only, and reports the metrics above by horizon on later held-out runs. Coverage there is time-weighted: for each stop, the span from run start to its true arrival is the opportunity, and only the time during which the newest fix's estimate was still valid counts as covered (a newer fix replaces the older estimate, as the tracking query does). Counting per fix would hide dropouts, because a fix that never arrived drops out of both sides of the ratio. True arrivals come from the simulation, not from stop detection. Its numbers describe the simulation, not field accuracy; replace or extend the runs with reviewed real recordings (kept out of this public repository) before claiming accuracy for a pilot.

## 7. When to withhold or change a prediction

Suppress or downgrade the ETA when GPS is stale, no valid position exists, the route version is mismatched, progress is ambiguous, the run has ended, or a detour is outside the supported model. A staff-confirmed or driver-reported delay can be displayed immediately even if an accurate new ETA is unavailable.

**Implemented: driver-reported delay.** A driver's report (docs/05 D20, docs/08 §9.4) reaches families as `reportedDelay` on `tracking:myRun`: "Driver reported a delay (traffic), about 10 min — reported 3 min ago". It is informational only: it never changes, replaces or fakes the ETA, which keeps all of its own suppression rules, and it is shown with its age and hidden after 60 minutes. Staff-confirmed delays have no endpoint yet.

Avoid double-counting a delay. If updated travel observations already reflect slower movement, blindly adding the full driver's delay estimate again may exaggerate the remaining time. Define whether a staff report changes a specific expected segment/hold time or is informational only.

A GPS-derived unusual pause is a possible operational anomaly. It cannot establish a vehicle breakdown or emergency. Staff can confirm and classify the situation through the established reporting process.

## 8. Notifications are a server workflow

The iPhone's foreground subscription is responsible for visible updates. The backend is responsible for deciding whether an alert is relevant while the app is closed or suspended. Silent background pushes are not a continuous GPS transport: Apple says they may be throttled and are not guaranteed. See [Pushing background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).

For each accepted fresh state, evaluate only relevant subscribed recipients. A five-minute preference means “notify once when a reliable prediction enters the selected approaching condition,” not “send every five minutes” or “notify on each GPS packet.”

Create a logical event identity from recipient, run, assigned stop, and alert type. Check whether it already exists. Apply hysteresis/cooldown for fluctuating predictions and define a separate meaningful-update rule. Otherwise estimates moving between 4:59 and 5:01 could produce repeated alerts.

Record user preferences separately from operating-system permission. A user can want an alert while iOS permission is denied; the app must explain the actual permission state. The in-app alerts inbox remains useful when push is unavailable.

## 9. Outbox, delivery, and retries

Persist the alert and a delivery job before contacting APNs. Suggested job states are pending, in progress, provider accepted, retryable failure, permanent failure, and expired. A worker claims a job with a bounded lease/attempt identity so two workers do not intentionally send it simultaneously.

Immediately before delivery, verify that the run is still relevant, the student assignment/guardian link still permits access, the user's preference remains enabled, and the token belongs to the correct account/application environment. Avoid private student details in Lock Screen text.

The APNs delivery adapter must support HTTP/2 and the appropriate authentication mechanism. A normal HTTP/1-only client is insufficient. Implement a tested server-side adapter in a suitable runtime or a dedicated delivery worker; keep its signing key server-side. Convex offers an opt-in Node.js action runtime, but the chosen library/protocol path must be verified in the actual deployment. See [Convex runtimes](https://docs.convex.dev/functions/runtimes) and [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

Use bounded retries with jitter for transient failures. Permanent token failures disable that token association. A timeout can be ambiguous: APNs might have accepted the request even though the sender did not receive the response. Stable job identities and collapse behavior reduce redundant presentation but do not create an exactly-once delivery guarantee.

Set useful expiration times for time-sensitive alerts. APNs `apns-expiration` uses epoch **seconds**, unlike I.T.S.S.B.'s internal `expiresAtMs`; explicitly convert at the adapter boundary. Apple describes APNs as best effort, with possible delay, reordering, throttling, and non-delivery. Provider acceptance is not evidence that the user read the message. [APNs delivery behavior](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

When a notification is tapped, the app fetches current authorized state. It may now show a completed or canceled trip. The notification's older payload must not override the live backend result.

**Implemented outbox.** Telemetry ingest stores the estimate and only schedules the approaching rule (`convex/alerts.ts`, `convex/lib/alertRules.ts`), which then pages through the route's assignments 20 at a time, so a route with many recipients can never make an upload fail. Each page first rechecks that its source is still the run's newest matched position and is still fresh on the server clock, so a newer off-route fix or a delayed scheduler cancels it. It requires an active run, a position younger than `ALERT_MAX_INPUT_AGE_MS`, a still-valid estimate, an approved assignment and recipient (the student's account and approved guardians), and that person's enabled preference. It then checks the logical key and creates the alert and one `pending` job per active token in the same transaction; when the predicted arrival has already passed, only the inbox entry is created. The worker (`convex/pushDelivery.ts`, Node runtime) claims a job with a fresh lease, rechecks run state, that the bus has not yet reached the stop, that its newest position is fresh and on the route with a still-valid estimate for the stop (otherwise the job is cancelled as `estimate_unavailable` and only the inbox entry remains), access, preference, token ownership, attempts, and expiry, sends outside any transaction, and records the result only for the lease that sent it. Retries back off exponentially from 5 s, the base capped at 5 minutes, plus up to 20% jitter (so no wait exceeds 6 minutes), for at most `MAX_DELIVERY_ATTEMPTS` attempts; a job expires at the estimate's predicted arrival, never later. A permanent token rejection disables that token only if the phone still holds it. Ending a run cancels its open jobs in the same transaction. Without APNs configuration (`APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID` in the deployment environment) nothing is sent and jobs expire; the inbox still shows the alert. The APNs path has not yet been run against Apple: that needs the owner's key and a signed device build.

## 10. Scheduling and recovery

Convex can schedule an action as part of a mutation's successful commit. A one-minute cron (`convex/crons.ts`) runs the recovery sweep: it expires jobs past their expiry and reschedules only due retries and expired leases, never accepted, failed, or stopped jobs. External-effect actions are not automatically retried, and scheduled functions do not inherit the initiating person's authentication. Implement recovery checks around durable jobs and pass identifiers needed to revalidate current state. [Scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions).

The notification outbox is therefore an application record, not merely an assumption that a scheduled callback will eventually succeed. A recovery sweep can find expired leases or due retries, while observing backoff and expiration. It must never resend all old approaching alerts after a backend outage or database restoration.

Test GPS dropout, estimate oscillation, cancellation between enqueue and send, guardian revocation, token rotation, a notification tapped after completion, duplicate jobs, and a delivery timeout. Demonstrate honest behavior before enabling alerts for a real pilot.

## Sources

- [scikit-learn: preprocessing and data leakage](https://scikit-learn.org/stable/common_pitfalls.html)
- [Apple: sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Apple: background updates and delivery limitations](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)
- [Convex runtimes](https://docs.convex.dev/functions/runtimes)

The baseline, model candidates, evaluation plan, preference behavior, and job design above are I.T.S.S.B. engineering proposals. They require implementation and measurement.
