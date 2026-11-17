"""Opt-in "Throughput mode": run several independent LLM units at once, in order.

workers=1 (the default everywhere) is a plain loop — the sequential path is
literally the same code QUAILS always ran, so default runs stay replicable.
With workers>1, Ollama batches concurrent requests on the GPU (needs the
server's OLLAMA_NUM_PARALLEL ≥ workers); batching can change floating-point
results slightly, which is why it is opt-in and recorded with every run
(see replicability.md).
"""

from collections import deque
from concurrent.futures import ThreadPoolExecutor


def ordered_map(fn, items, workers=1, should_stop=None):
    """Yield (item, result) in input order. Stops submitting new work once
    should_stop() is true; work already in flight is allowed to finish."""
    items = list(items)
    workers = max(1, int(workers or 1))
    if workers == 1:
        for it in items:
            if should_stop and should_stop():
                return
            yield it, fn(it)
        return

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="quails-llm") as pool:
        pending = deque()
        idx = 0
        while idx < len(items) or pending:
            while idx < len(items) and len(pending) < workers:
                if should_stop and should_stop():
                    idx = len(items)
                    break
                pending.append((items[idx], pool.submit(fn, items[idx])))
                idx += 1
            if not pending:
                break
            it, fut = pending.popleft()
            yield it, fut.result()


def _selftest():
    import random
    import time

    def slow(x):
        time.sleep(random.random() * 0.01)
        return x * x

    data = list(range(50))
    assert [r for _, r in ordered_map(slow, data, 1)] == [x * x for x in data]
    assert [r for _, r in ordered_map(slow, data, 4)] == [x * x for x in data]
    done = []
    stop = lambda: len(done) >= 10
    for it, r in ordered_map(slow, data, 4, should_stop=stop):
        done.append(it)
    assert 10 <= len(done) <= 14 and done == data[:len(done)], done
    print("parallel self-test: 3/3 checks passed")


if __name__ == "__main__":
    _selftest()
