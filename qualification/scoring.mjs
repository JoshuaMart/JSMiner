export const categories = ['endpoints', 'secrets', 'gql_operations', 'subdomains'];
export function score(expected, observed) {
  const truth = new Set(expected),
    actual = new Set(observed);
  return {
    tp: [...actual].filter((x) => truth.has(x)).length,
    fp: [...actual].filter((x) => !truth.has(x)).length,
    fn: [...truth].filter((x) => !actual.has(x)).length,
  };
}
export function rates({ tp, fp, fn }) {
  return {
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
  };
}
export function aggregate(rows) {
  return Object.fromEntries(
    categories.map((category) => [
      category,
      rates(
        rows.reduce(
          (sum, row) => {
            for (const key of ['tp', 'fp', 'fn']) sum[key] += row.quality[category][key];
            return sum;
          },
          { tp: 0, fp: 0, fn: 0 },
        ),
      ),
    ]),
  );
}
export function qualityPass(quality, thresholds) {
  return categories.every(
    (c) =>
      quality[c].precision !== null &&
      quality[c].recall !== null &&
      quality[c].precision >= thresholds[c].precision &&
      quality[c].recall >= thresholds[c].recall,
  );
}
