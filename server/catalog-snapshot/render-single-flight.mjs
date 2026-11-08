// Never share pending render promises or response streams between invocations.
// Completed public HTML is already cached by snapshot-html-cache after its
// authenticated root/renderer checks. A slow or abandoned request must not hold
// another visitor's cold render open.
export async function renderSingleFlight(_cache, _key, render) {
  return render();
}
