export function formatEuro(cents: number): string {
  const euros = (cents / 100).toFixed(2);
  // Austrian/German formatting
  return euros.replace(".", ",") + " €";
}
