/** Runs `work` over `items` with at most `concurrency` at a time; the results keep the items' order. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!, index);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}
