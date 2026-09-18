# Schema Storage Benchmark: Variant A vs Variant B

Evaluated across **2000 synthetic ticks** of realistic gameplay with dynamic option generation from `buildOptions` (varying characters, MP, weapons, distances, and live threats).

## Metrics Comparison

| Metric | Variant A (Full Schema Hashing) | Variant B (Stable Schema + Inline Criteria) | Delta (B vs A) |
|---|---|---|---|
| Schema files written | 1,999 | 1 | -1,998 (-99.9%) |
| Total bytes of schema files | 5,609,884 B (5.35 MB) | 1,116 B (1.09 KB) | -5,608,768 B |
| Total bytes of judgements.jsonl | 1,663,277 B (1.59 MB) | 4,780,806 B (4.56 MB) | +3,117,529 B |
| Mean bytes per judgement row | 831.6 B | 2390.4 B | +1558.8 B |
| Combined total bytes | 7,273,161 B (6.94 MB) | 4,781,922 B (4.56 MB) | -2,491,239 B (-34.3%) |
| Hashing + serialising time | 581.1 ms | 43.0 ms | -538.2 ms |

## Crossover Progression

| Tick | Variant A Schemas | Variant A Total Bytes | Variant B Schemas | Variant B Total Bytes | Winner | Margin |
|---|---|---|---|---|---|---|
| 1 | 1 | 3,866 B | 1 | 3,717 B | **Variant B** | B by 149 B |
| 2 | 2 | 7,794 B | 1 | 6,380 B | **Variant B** | B by 1,414 B |
| 3 | 3 | 11,672 B | 1 | 8,993 B | **Variant B** | B by 2,679 B |
| 5 | 5 | 18,109 B | 1 | 12,980 B | **Variant B** | B by 5,129 B |
| 10 | 10 | 37,629 B | 1 | 26,183 B | **Variant B** | B by 11,446 B |
| 50 | 50 | 184,436 B | 1 | 123,030 B | **Variant B** | B by 61,406 B |
| 100 | 100 | 370,427 B | 1 | 246,411 B | **Variant B** | B by 124,016 B |
| 500 | 500 | 1,813,436 B | 1 | 1,191,220 B | **Variant B** | B by 622,216 B |
| 1000 | 1000 | 3,617,542 B | 1 | 2,372,482 B | **Variant B** | B by 1,245,060 B |
| 2000 | 1999 | 7,273,161 B | 1 | 4,781,922 B | **Variant B** | B by 2,491,239 B |

## Verdict

Variant B is the decisive winner, eliminating 99.9% of schema files (1 file vs 1,999 files) and reducing total storage by 2.38 MB (34.3% smaller footprint at 2000 ticks). Variant B wins across all evaluated run lengths starting from tick 1 (by 149 B) and steadily expanding its advantage because dynamic option churn forces Variant A to write a ~2.8 KB pretty-printed schema file on nearly every tick. Variant A could only win if question criteria remained static across a match (where a single shared schema amortizes over compact rows), but under realistic combat with continuous variation in distances, weapons, and MP, Variant B decisively prevents severe filesystem inode exhaustion and disk waste.
