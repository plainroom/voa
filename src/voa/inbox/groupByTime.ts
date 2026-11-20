const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Groups items (already ordered) into Today, Yesterday, This week (since Monday,
 * excluding today and yesterday), then one group per month, in the order first seen.
 * Times are read in the local timezone.
 */
export function groupByTime<T>(
  items: T[],
  at: (t: T) => number,
  now: Date,
): { label: string; items: T[] }[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const sinceMonday = (now.getDay() + 6) % 7;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday).getTime();

  const labelOf = (time: number): string => {
    if (time >= startOfToday) return "Today";
    if (time >= startOfYesterday) return "Yesterday";
    if (time >= startOfWeek) return "This week";
    const d = new Date(time);
    const month = MONTHS[d.getMonth()]!;
    return d.getFullYear() === now.getFullYear() ? month : `${month} ${d.getFullYear()}`;
  };

  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = labelOf(at(item));
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }
  return [...groups].map(([label, grouped]) => ({ label, items: grouped }));
}
