function initializeZehnRails(root = document) {
  root.querySelectorAll('[data-zehn-product-rail]').forEach((rail) => {
    if (rail.dataset.initialized === 'true') return;

    const track = rail.querySelector('[data-zehn-rail-track]');
    if (!track) return;

    rail.dataset.initialized = 'true';
    rail.querySelectorAll('[data-zehn-rail-direction]').forEach((button) => {
      button.addEventListener('click', () => {
        const direction = button.dataset.zehnRailDirection === 'previous' ? -1 : 1;
        const card = track.querySelector('.zehn-product-rail__item');
        const distance = card ? card.getBoundingClientRect().width + 12 : track.clientWidth * 0.8;
        track.scrollBy({ left: distance * direction, behavior: 'smooth' });
      });
    });
  });
}

function initializeZehnCategoryExplorers(root = document) {
  root.querySelectorAll('[data-zehn-category-explorer]').forEach((explorer) => {
    if (explorer.dataset.initialized === 'true') return;

    const subnav = explorer.querySelector('[data-zehn-category-subnav]');
    const resultsShell = explorer.querySelector('[data-zehn-category-results-shell]');
    const results = explorer.querySelector('[data-zehn-category-results]');
    const status = explorer.querySelector('[data-zehn-category-status]');
    const title = explorer.querySelector('[data-zehn-category-title]');
    const viewAll = explorer.querySelector('[data-zehn-category-all]');
    if (!subnav || !resultsShell || !results || !status || !title || !viewAll) return;

    explorer.dataset.initialized = 'true';
    const cache = new Map();
    let activeRequest;

    const setMainState = (activeLink) => {
      explorer.querySelectorAll('[data-zehn-category-level="main"]').forEach((link) => {
        const isActive = link === activeLink;
        link.classList.toggle('is-active', isActive);
        link.setAttribute('aria-expanded', String(isActive));
        if (isActive) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });

      const handle = activeLink.dataset.zehnCategoryHandle;
      let hasSubcategories = false;
      explorer.querySelectorAll('[data-zehn-category-subgroup]').forEach((group) => {
        const isActive = group.dataset.zehnCategorySubgroup === handle;
        group.hidden = !isActive;
        if (isActive) hasSubcategories = group.children.length > 0;
      });
      subnav.hidden = !hasSubcategories;
    };

    const setSubState = (activeLink) => {
      explorer.querySelectorAll('[data-zehn-category-level="sub"]').forEach((link) => {
        const isActive = link === activeLink;
        link.classList.toggle('is-active', isActive);
        if (isActive) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
    };

    const renderError = (link) => {
      results.replaceChildren();
      const message = document.createElement('p');
      message.textContent = 'Diese Kategorie konnte gerade nicht geladen werden.';
      const fallback = document.createElement('a');
      fallback.href = link.href;
      fallback.textContent = 'Kategorie direkt öffnen';
      fallback.className = 'zehn-category-explorer__fallback';
      results.append(message, fallback);
      status.textContent = '';
    };

    const loadProducts = async (link) => {
      const handle = link.dataset.zehnCategoryHandle;
      const label = link.dataset.zehnCategoryLabel || link.textContent.trim();
      if (!handle) return;

      resultsShell.hidden = false;
      title.textContent = label;
      viewAll.href = link.href;
      viewAll.setAttribute('aria-label', `${label}: Alle ansehen`);
      explorer.setAttribute('aria-busy', 'true');
      results.classList.add('is-loading');
      status.textContent = `${label} wird geladen …`;

      activeRequest?.abort();
      const requestController = new AbortController();
      activeRequest = requestController;

      try {
        let productMarkup = cache.get(handle);
        if (!productMarkup) {
          const requestUrl = new URL(link.href);
          requestUrl.searchParams.set('section_id', 'section-rendering-zehn-category-products');
          const response = await fetch(requestUrl, {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            signal: requestController.signal,
          });
          if (!response.ok) throw new Error(`Category request failed: ${response.status}`);

          const html = await response.text();
          const parsed = new DOMParser().parseFromString(html, 'text/html');
          const payload = parsed.querySelector('[data-zehn-category-products]');
          if (!payload) throw new Error('Category response was incomplete');
          productMarkup = payload.innerHTML;
          cache.set(handle, productMarkup);
        }

        results.innerHTML = productMarkup;
        status.textContent = `${label} wurde geladen.`;
      } catch (error) {
        if (error.name === 'AbortError') return;
        renderError(link);
      } finally {
        if (activeRequest === requestController && !requestController.signal.aborted) {
          explorer.removeAttribute('aria-busy');
          results.classList.remove('is-loading');
        }
      }
    };

    explorer.addEventListener('click', (event) => {
      const link = event.target.closest('[data-zehn-category-link]');
      if (!link || !explorer.contains(link)) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      event.preventDefault();
      if (link.dataset.zehnCategoryLevel === 'main') {
        setMainState(link);
        setSubState(null);
      } else {
        setSubState(link);
      }
      loadProducts(link);
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initializeZehnRails();
    initializeZehnCategoryExplorers();
  }, { once: true });
} else {
  initializeZehnRails();
  initializeZehnCategoryExplorers();
}

document.addEventListener('shopify:section:load', (event) => {
  initializeZehnRails(event.target);
  initializeZehnCategoryExplorers(event.target);
});
