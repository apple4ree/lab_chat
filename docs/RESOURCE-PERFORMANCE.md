# Resource read performance — 2026-10-21

## Method

Run `node scripts/measure-resources.mjs 6` and `node scripts/measure-resources.mjs 1024`.
The script creates and removes its own temporary SQLite database. Each GPU has one
active approved reservation. It exercises the production management service and
serializes its complete response, without HTTP, authentication, collectors or UI.
It never opens the deployed database.

Baseline: commit `25206243f74d659f8f680f138d612cc647cdd15e`, using the same measurement
script. Node 24.15.0 on the same Linux host, three fresh processes per version and
size, alternating before/after. Values below are medians; the shared host was not
otherwise idle. Cold means the first management read after fixture setup, including
server discovery; it does not include application/process startup. Warm means 200
subsequent reads, including JSON serialization.

## Results

| Measurement | 6 GPUs before → after | 1,024 GPUs before → after |
| --- | --- | --- |
| Cold elapsed time | 1.64 → 1.65 ms | 61.94 → 21.06 ms |
| Warm elapsed time, 200 reads | 114.82 → 92.61 ms | 10,363.07 → 3,207.56 ms |
| Warm CPU time, user + system | 120.76 → 97.16 ms | 10,459.41 → 3,293.62 ms |
| Warm prepared SELECT executions | 2,000 → 1,400 | 205,600 → 1,400 |
| Warm prepared INSERT executions | 1,400 → 0 | 208,000 → 0 |
| Process peak RSS, including setup | 57,544 → 57,812 KiB | 179,268 → 123,248 KiB |
| Serialized bytes per response | 4,279 → 4,279 | 379,690 → 379,690 |

Warm elapsed time fell about 19% at six GPUs and 69% at 1,024 GPUs. There is no
meaningful cold-time or memory improvement at six GPUs. Statement counts include
prepared statements executed by the measured service, not transaction control via
`db.exec`. The process has no children, so its peak RSS covers the process family.
These figures do not establish public network latency, end-to-end application
throughput, or performance with a large historical reservation ledger. Agent token
cost was not measured.

The changed catalog reads current DB identities and writes only newly discovered
servers/GPUs. It does not memoize live resource state. Management reads obtain all
current reservations in one SQL query and map observations by host/GPU identity.
Reservation time transitions, ownership, role checks and pagination remain active.

## HTTP and client size

The history UI now submits one bounded batch request per selection, rather than
one request per GPU. Browser verification observed one POST for the initial three
GPUs and three rendered series. The API supports at most six targets, validates
them once and uses one time window. It still performs one source history read per
GPU; this change does not claim to shrink the number of chart points or bypass
upstream limits. Existing single-GPU clients remain supported.

Using the same `scripts/audit-size.mjs` gzip calculation, the initial JS changed
from 104,064 to 104,043 bytes; CSS remained 10,185 bytes. No dependencies or native
installer changes were introduced. The 21-byte difference is negligible; the
meaningful reductions are request count and repeated backend work. Local installer
and rollback artifacts are not part of this initial client payload and were not
deleted during the optimization.

Validation: 68 Node tests and six resource browser scenarios passed. Coverage
includes role revocation, external DB registration, reads while another connection
holds a write lock, reservation boundaries, batch validation/failure, cancelled
selection changes and mobile layout. Test mutations used isolated databases.
