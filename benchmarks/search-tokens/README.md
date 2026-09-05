# Search output token benchmark

Observed on September 6, 2026 (Asia/Shanghai), on macOS arm64. The corpus contains **8 synthetic Claude Code Sessions and 112 source records**. No personal Session data is used. [measured-results.json](measured-results.json) records measured totals and accuracy checks; [measured-results-queries.csv](measured-results-queries.csv) records every individual query count and stdout hash.

## Results

Glia's new `search --compact --json` reduces common-query output from **3,376 to 3,234 tokens (4.21%)**, and from **8,010 to 7,056 (11.91%)** with `-C 2`, using `o200k_base`. The dense `lease` query saves **12.07%** without context and **26.56%** with context (2,745 → 2,016 tokens). These are totals over five queries, including one empty result, with 20 matching events across the four nonempty queries.

| Search interface                        | o200k_base | cl100k_base | Content returned                                              |
| --------------------------------------- | ---------: | ----------: | ------------------------------------------------------------- |
| Glia before, JSON                       |      3,376 |       3,346 | Event matches, timestamps, source locators, 120-unit excerpts |
| Glia after, JSON                        |      3,376 |       3,346 | Same flat contract                                            |
| Glia after, JSON `--compact`            |  **3,234** |   **3,205** | Same fields through lossless inheritance                      |
| Glia human text, before and after       |      1,530 |       1,527 | Session headers, event summaries, source file/line            |
| ctx 1.3.1, `--events --format json`     |     15,955 |      15,999 | Native event JSON, citations, retrieval metadata/commands     |
| ctx 1.3.1, `--events`, native text      |      1,877 |       1,903 | Short IDs, timestamp, snippet, inspect command                |
| Obelisk `69d9e21`, native `--search`    |     19,189 |      19,225 | Full indexed messages plus up to six context messages         |
| Obelisk, official compact query pattern |      1,777 |       1,779 | Session ID/title, message UUID, 240-character prefix          |

Every row above retrieves the same 20 matching event identities with no false positives. Their metadata, snippet lengths, and included context differ, so this is a comparison of actual interfaces, not a claim that the payloads are interchangeable. ctx's default Session mode returns 16 rows instead; its separately recorded totals are 14,731 JSON / 1,485 text tokens (`o200k_base`).

| Search with up to two neighbors per side | o200k_base | cl100k_base |
| ---------------------------------------- | ---------: | ----------: |
| Glia before, JSON `-C 2`                 |      8,010 |       7,943 |
| Glia after, JSON `--compact -C 2`        |  **7,056** |   **6,982** |
| Obelisk, custom context-2 query          |     14,352 |      14,381 |

Glia selects logical events and excludes shown matches from context; Obelisk's custom query selects visible messages and retains full indexed text. ctx has no search context-size flag. These context totals describe those configurations, not identical neighborhoods.

All **18 query/context cases** passed old/new flat-result equality and compact expansion equality, including every field and array order. The adaptive representation selected **9 grouped and 9 flat** outputs; none increased stdout bytes. Full evidence checks passed for **32 unique Glia events and all 8 preserved transcripts**, before and after. ctx's separate `show`/`locate` checks passed for **40 unique events**. Obelisk's returned message UUIDs and Session IDs were checked against the generated sources.

Supplemental probes expose existing search differences and are excluded from token totals:

| Probe                                   | Expected source events | Glia before / after | ctx events | Obelisk native search |
| --------------------------------------- | ---------------------: | ------------------: | ---------: | --------------------: |
| Distant `semaphore rollback` terms      |                      1 |               1 / 1 |          1 |                     1 |
| CJK substring `重建投影`                |                      2 |               2 / 2 |          2 |                     0 |
| `lateboundary` after character 10,000   |                      1 |               1 / 1 |          1 |                     0 |
| `toolneedle` in Bash inputs and results |                     16 |               8 / 8 |         16 |                     0 |

Glia's distant-term excerpt and Obelisk's compact prefix do not display every query term, although the event is found. Glia's existing Claude adapter indexes these tool results but not Bash input text. Obelisk's native message FTS has different CJK tokenization, truncates indexed text at 10,000 characters, and stores tool records separately. Its SQL/raw APIs offer other retrieval paths. The optimization changes none of these behaviors, and fewer retrieved events are never treated as token savings.

## Method

Five shared queries (`lease`, `migration`, `quartz`, `checkpoint`, `missingbenchmarkword`) have 8, 4, 4, 4, and 0 known source-event matches. Each is a standalone ASCII word; substring and lexical matching agree on this corpus. A 20-hit cap and Glia's 3-hit per-Session cap do not remove any expected result. Separate probes cover distant terms, CJK substrings, a marker after 10,000 characters, and tool inputs/results. These probes are excluded from token averages because the products have different matching scopes.

`tiktoken==0.12.0` counts **complete stdout**, including JSON envelopes, formatting, and trailing newlines, with both `o200k_base` and `cl100k_base`. Stderr and tool transport framing are excluded. These are tokenizer counts, not billed tokens or a benchmark of any model's answer quality. The harness preserves raw stdout in the temporary benchmark directory.

The Glia comparison runs the same queries against the same imported Store using baseline commit `d33155e532e9b2282f86de3fd11277ea62c950a8` and the current checkout. It exercises both the grouped representation and flat fallback, restores grouped results, and compares each entire result to flat JSON. It also checks that compact stdout never uses more UTF-8 bytes on this corpus. It also verifies source UUIDs/line numbers, Session identity, timestamps, complete `view --seq` text, and each preserved transcript's SHA-256 and size.

## Reproduce

Requirements: Bun dependencies installed in this checkout, Python 3.9+, Git, and Node 24 for Obelisk. The commands below use only generated data under `/tmp/glia-search-benchmark`. Use a fresh root to avoid mixing corpora; `BENCHMARK_ROOT` configures competitor scripts, and `--root` configures the generator and Glia runner. macOS ctx requires canonical `/private/tmp` paths; the scripts resolve them.

```sh
python3 -m venv /tmp/glia-search-benchmark/venv
/tmp/glia-search-benchmark/venv/bin/python -m pip install -r benchmarks/search-tokens/requirements.txt
python3 benchmarks/search-tokens/generate.py
/tmp/glia-search-benchmark/venv/bin/python benchmarks/search-tokens/run.py
```

The first tokenization downloads two tokenizer vocabularies into the temporary `tiktoken-cache` directory. `--before-only` measures the old Glia without requiring `--compact`; `--summarize-only` recounts existing stdout without rerunning searches.

For ctx, download the pinned **1.3.1 macOS arm64 release** and verify its published hash. The investigated repository HEAD had manifest version 1.3.2; it was not the tested binary.

```sh
curl -fL https://github.com/ctxrs/ctx/releases/download/v1.3.1/ctx-macos-arm64 -o /tmp/glia-search-benchmark/ctx-bin
chmod +x /tmp/glia-search-benchmark/ctx-bin
python3 benchmarks/search-tokens/ctx.py
```

`ctx.py` rejects any binary whose SHA-256 differs from `90807a133453ed6a2a70b6fdfb70a1ce7da9b6d4eb2cf33248020c664d330d99`. Its wrapper disables automatic discovery, telemetry, upgrades, and semantic search, and uses an empty HOME and isolated state. Import may require permission to create a local Unix socket. It checks all 112 records were indexed, then runs native text/JSON in both event and Session modes. Separate `locate`/`show` calls verify original evidence and are not counted as search output.

For Obelisk, use the exact source commit (CLI package `0.2.6-rc.0`):

```sh
git clone https://github.com/tommy0103/obelisk.git /tmp/glia-search-benchmark/obelisk
git -C /tmp/glia-search-benchmark/obelisk checkout 69d9e21a90e55f310376d8f49929b1c16f5a1f0c
python3 benchmarks/search-tokens/obelisk.py
/tmp/glia-search-benchmark/venv/bin/python benchmarks/search-tokens/run.py --summarize-only --export benchmarks/search-tokens/measured-results.json
```

The Obelisk runner configures isolated provider roots, runs the real CLI's `--build`, and measures native `--search`, the official four-field compact projection, and a caller-authored query selecting up to two messages before and after each hit. The last configuration is not an upstream context flag.

## Interpretation

- Compare Glia event results with ctx `--events`. ctx's default Session grouping returns fewer rows for multiple hits in a Session.
- ctx search has fixed query-focused snippets capped at 320 grapheme clusters and no search context-size flag. Obelisk native search includes full message text and up to six neighboring messages. Its compact projection includes fewer metadata fields and a 240-character prefix. These interfaces carry different information; their token totals are not equivalent payloads.
- Glia compact retains every flat-result field through inheritance and shared context. It selects grouped output only when its serialized JSON uses fewer UTF-8 bytes; otherwise it returns the original flat result. This avoids extra bytes for empty or sparse results. Byte size is the selection rule: it does not guarantee fewer tokens for every tokenizer and possible input. The reported token savings are measurements on this corpus.
- On this corpus, every product returns all 20 common-query events with no false positives. Glia preserves the old search behavior: the distant-term match is found but the excerpt does not show every term, and Bash input text is not indexed (8 of 16 tool source records match). ctx finds all supplemental events. Obelisk does not find the CJK substring, the marker beyond its indexing cap, or these tool events; its compact prefix omits the distant second term. Missing results must not be counted as token savings.
- IDs, Store commit hashes, source paths, and ctx runtime metadata can vary across fresh imports or platforms. The corpus and commands are reproducible, but raw envelope token counts can vary slightly. All reported comparisons use actual stdout from the same captured run, without normalizing away these costs.

## Further optimization choices

The implemented grouping removes repeated Session identity and source file names while retaining each exact event identity, timestamp, excerpt, and source cursor. Shared context removes duplicates while `contextSeqs` preserves every original window. Sparse results use the original flat output when it is smaller.

Using the existing `--word`, `--filter`, `--file`, and `--since` options can reduce irrelevant hits when the task supplies those constraints. Request context only when needed, then use `view --seq` to recover complete source evidence. Merely lowering `--limit` or shortening excerpts was not used to obtain the reported savings: either can hide information the agent needs.

Custom field selection could approach the smaller Obelisk compact payload, but its four-field example omits timestamps, event kinds, and Glia's physical source locators. Short IDs would require a collision-aware resolution contract. Removing projection freshness or true match counts would hide stale or capped results. These are separate interface tradeoffs rather than further lossless savings in this change. Query-focused multi-window excerpts could improve distant-term visibility, but should be evaluated on retrieval quality before changing the existing preview contract.

## Source references

- Glia baseline: [search serialization](https://github.com/anxndsgn/glia/blob/d33155e532e9b2282f86de3fd11277ea62c950a8/packages/cli/src/session/commands/search.ts), [excerpt renderer](https://github.com/anxndsgn/glia/blob/d33155e532e9b2282f86de3fd11277ea62c950a8/packages/cli/src/session/projection/excerpt.ts).
- ctx tested release: [v1.3.1](https://github.com/ctxrs/ctx/releases/tag/v1.3.1), [JSON serialization](https://github.com/ctxrs/ctx/blob/d382b6502dbf5e85f4ffc274b88633b63496b8c6/crates/ctx-history-read-application/src/search_read_model.rs), [native text renderer](https://github.com/ctxrs/ctx/blob/d382b6502dbf5e85f4ffc274b88633b63496b8c6/crates/ctx-history-cli/src/source_index/render/search.rs), [snippet budget](https://github.com/ctxrs/ctx/blob/d382b6502dbf5e85f4ffc274b88633b63496b8c6/crates/ctx-history-read-application/src/presentation.rs#L28).
- Obelisk tested source: [search and context](https://github.com/tommy0103/obelisk/blob/69d9e21a90e55f310376d8f49929b1c16f5a1f0c/packages/core/src/query.ts#L288-L390), [official compact query pattern](https://github.com/tommy0103/obelisk/blob/69d9e21a90e55f310376d8f49929b1c16f5a1f0c/skill-doc/SKILL.md#L432-L444), [index text extraction and limit](https://github.com/tommy0103/obelisk/blob/69d9e21a90e55f310376d8f49929b1c16f5a1f0c/packages/core/src/parsing.ts#L18-L77).
