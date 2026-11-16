export {};

const query = document.querySelector<HTMLInputElement>('#collection-query');
const cards = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-card]')];
const filters = [...document.querySelectorAll<HTMLButtonElement>('[data-collection-filter]')];
const status = document.querySelector<HTMLElement>('#collection-results');
const empty = document.querySelector<HTMLElement>('#collection-no-results');
if (query && cards.length && status && empty) {
  let section = 'all';
  const normalized = (s: string) =>
    s.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
  const labels = new Map(
    cards.map((card) => [card, normalized(card.dataset.collectionSearch ?? '')]),
  );
  const update = () => {
    const words = normalized(query.value.trim()).split(/\s+/).filter(Boolean);
    let count = 0;
    for (const card of cards) {
      const visible =
        (section === 'all' || card.dataset.collectionSection === section) &&
        words.every((word) => labels.get(card)!.includes(word));
      card.hidden = !visible;
      if (visible) count++;
    }
    status.textContent = `${count} ${count === 1 ? 'collection' : 'collections'}`;
    empty.hidden = count > 0;
  };
  query.addEventListener('input', update);
  for (const button of filters)
    button.addEventListener('click', () => {
      section = button.dataset.collectionFilter!;
      for (const other of filters) other.setAttribute('aria-pressed', String(other === button));
      update();
    });
}
