# Target-host runtime evidence (PIC-366)

Owner-forwarded offline report, received September 15, 2026. Evaluated source:
`84219d7cefa35b2ff053e1c78adaeaa02c0e220b`, native Node **22.23.2**, Intel Core
Ultra 5 225H, Ubuntu 24.04.4. This is a sanitized summary of the supplied report;
the lead did not independently inspect the remote raw JSON or host artifacts.

Both focused suites passed **54/54** tests. The six-case background benchmark
ran once and exited 0. No source, fixture or budget changes, provider calls,
application access, deployment, or service restarts were reported. The detached
source remained clean. Private artifacts remain outside Git.

## Workload

Each case ran in a fresh process with two loopback HTTP clients and recurring
SQLite metadata writes during at least twenty rebuilds and one second of work.
Inputs were synthetic and fixed. All fixtures explicitly enabled the experimental
semantic veto; only gapped triples enabled lookback at 0.05. Neither is a new
production policy or calibrated threshold.

The host reported 14 CPUs available by affinity, approximately 62 GiB RAM and
no finite limits in visible ancestor CPU/memory cgroups. Existing services
remained running under low observed before/after load. These observations do not
establish a controlled concurrent-workload trace or container resource envelope.

## Measurements

Times are milliseconds; RSS is MiB. Parenthesized request values are sample counts.
The slice maximum includes both cold-build and rebuild slices.

| Fixture | Cold / rebuild p95 | List HTTP p95 (n) | Decision HTTP p95 (n) | Loop p95 / max | Max slice / count >8 ms | RSS baseline / peak / increase |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1k pending | 2.64 / 1.05 | 9.06 (116) | 16.40 (115) | 6.71 / 15.82 | 3.43 / 0 | 68.73 / 89.93 / 21.20 |
| 10k pending | 17.25 / 21.65 | 24.06 (45) | 25.93 (45) | 11.63 / 19.81 | 7.59 / 0 | 77.78 / 111.34 / 33.56 |
| 30k pending | 27.67 / 56.18 | 26.15 (39) | 33.20 (39) | 12.92 / 24.56 | 16.34 / 1 | 92.12 / 172.04 / 79.92 |
| 100 pending + 30k decided | 29.19 / 69.05 | 27.22 (41) | 31.70 (41) | 15.07 / 22.38 | 8.44 / 1 | 91.84 / 170.34 / 78.50 |
| Dense 30k | 30.77 / 53.46 | 21.11 (41) | 25.39 (41) | 13.63 / 17.20 | 10.12 / 1 | 90.80 / 167.46 / 76.66 |
| Gapped triples 30k | 73.50 / 120.68 | 25.02 (76) | 30.68 (75) | 13.86 / 23.18 | 7.51 / 0 | 91.52 / 229.96 / 138.45 |

Rebuild counts were 346, 95, 21, 20, 20 and 20, over campaigns of
1001.80, 1010.95, 1022.52, 1157.82, 1046.19 and 2018.13 ms respectively.
There were three >8 ms slices in total. The report does not attribute those
individual outliers to sorting, another operation, garbage collection or host
scheduling; no such cause should be asserted from these timings alone.

Dense 30k retained two limited/manual groups after 1,930,840 pair comparisons.
Its per-candidate comparison limit was reached, not the shared two-million
limit. Gapped triples recorded 10,000 joins and 30,000 lookback checks. Other
cases had no limited groups; no case exhausted its lookback-candidate budget.
These metrics describe the final build, not cumulative work across rebuilds.

## Disposition

* **Standalone response/build timing evidence is complete for this pass.** All
  measured list p95 (30 ms), decision p95 (50 ms), loop p95 (50 ms), and
  cold/rebuild (500 ms) targets passed. This supports the cooperative publication
  approach and does not justify introducing a worker pool on this evidence alone.
* **The individual-slice target did not fully pass.** Keep the 8 ms target and
  the measured exceptions visible. PIC-367 must account for input preparation,
  sorting and group-output work when integrating the background builder, then
  profile and bound operations that miss it. Lowering the 4 ms yield timer does
  not guarantee that an indivisible operation or runtime pause becomes bounded.
* **Memory acceptance remains open.** Standard and dense fixture RSS increases
  were 21.20–79.92 MiB. The optional gapped-lookback experiment reached 138.45 MiB,
  10.45 MiB above the comparison threshold. Leave lookback off as already planned;
  do not change its threshold to obtain a benchmark pass. This does not excuse
  measuring baseline production memory or establish safety on other hosts.
* **Keep the production gates.** PIC-367 owns compact evidence/group records and
  bounded kept context. PIC-373 must measure real list/decision routes alongside
  background grouping and Enrich, using the same-server baseline for incremental
  Curate memory and separately recording full-server peak memory. Neither the
  128 MiB incremental target nor the 800 MiB full-server target has passed here.

RSS baseline already includes prepared input and seeded SQLite state. Subsequent
increase includes grouping, HTTP/SQLite work, retained synthetic receipts,
temporary allocations and GC. Explicit GC ran only before the baseline. Peak
sampling can miss short-lived allocations. The Node 22 and Node 25 measurements
use different machines and campaign counts; they do not isolate a Node-version
effect or provide a controlled speedup/memory-reduction comparison.

No repeat of this remote pass or additional owner photo labeling is requested
now. The remaining PIC-366 closeout concerns final large-group role behavior,
context/retention/lineage decisions and review. Production implementation and
integrated acceptance remain necessary; this report does not complete the issue.
