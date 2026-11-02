# 1.0.1 reliability verification

This patch addresses an intermittent embedding-index test timeout and a reproducible Windows file-replacement failure. Tests use temporary Vaults and synthetic embeddings, without real memories, agent configuration, or model calls.

## Evidence

- The original [Windows / Node 20 CI failure](https://github.com/iced7/memory-ferry/actions/runs/41324032162/attempts/1) timed out after a two-second cache polling deadline. Background errors were discarded, so that historical log cannot distinguish a slow task from a failed write.
- On an independent Windows machine (build 10.0.26200.9711), Node 20.20.2 ran the original lifecycle test 80 times, four workers at a time, with zero failures. Only background error logging was added to that temporary baseline; no behavior was changed.
- A separate native Windows regression holds the destination open without delete sharing. Version 1.0.0 fails with `EPERM` at `rename`; the patch waits for the handle to close and successfully replaces the file. This establishes a real failure mode, not the cause of the historical CI failure. Windows sharing rules are documented by [Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea).
- The patched lifecycle test passed another 80 repetitions on Windows / Node 20.20.2. Full suites on Windows Node 20.20.2 and 24.19.0 each passed 71 tests with the one POSIX-only test skipped. The macOS / Node 24.21.0 suite passed 71 tests with the Windows-only native handle test skipped.
- Windows / Node 20 stress: 25 rounds, 200 memories, 600 mutations, 187,265 concurrent cache reads, zero assertion failures (26 seconds). The same workload also passed on macOS. Counts of reads vary with scheduling; they are not a performance benchmark.
- Regression tests cover bounded permanent failures, preservation of previous data, temporary-file cleanup, immediate propagation of unrelated errors, and background filesystem failure reporting followed by successful recovery.
- The 1.0.1 Windows GUI executable (embedded Node 22.23.4) passed version, CLI, MCP pipe, recall, and dashboard-startup smoke tests on the independent machine. Its locally built SHA-256 was `5cbae8ed7a6386c6ab1afa30a8ecc4c1d6a01b90d77c63a9d90e5c0a5f0e75f4`; GitHub-built artifacts carry their own checksum.

## Behavior and ongoing checks

Atomic JSON writes retain the old destination throughout retries. Windows `EPERM`, `EACCES`, and `EBUSY` errors receive at most 4.75 seconds of backoff; all other errors propagate immediately. Failure cleanup removes only that write's temporary file. This cannot repair permanent permissions, full disks, or unavailable storage.

`Vault.flushEmbeddings()` waits for queued background work in that instance and reports retained original error causes. Tests assert the resulting vectors after completion instead of guessing a two-second deadline. Normal memory commits remain independent of optional embedding availability; failures produce an stderr diagnostic without memory contents or vectors. Search can rebuild missing/stale entries.

Every Windows Node 20/22/24 CI job runs `npm run test:stress`. The release workflow also runs it. Matrix fail-fast is disabled so one failed job does not hide the remaining results. Each build checks the package, lockfile, and runtime version for consistency; the executable smoke test verifies its reported version, CLI, MCP pipes, recall, and dashboard startup.

These checks cover the demonstrated failure mode and remove the timing-dependent assertion. They do not establish that all future failures are impossible. Desktop interaction and real cloud-drive sync are outside this patch's test scope. Source and release CI results are available on the associated GitHub pull request and release runs.
