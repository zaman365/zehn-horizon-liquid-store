import { Component } from '@theme/component';
import { morphSection } from '@theme/section-renderer';
import { fetchConfig } from '@theme/utilities';
import { cartPerformance } from '@theme/performance';
import { CartDiscountUpdateEvent, CartErrorEvent } from '@shopify/events';

/**
 * A custom element that applies a discount to the cart.
 *
 * @typedef {Object} CartDiscountComponentRefs
 * @property {HTMLElement} cartDiscountError - The error element.
 * @property {HTMLElement} cartDiscountErrorDiscountCode - The discount code error element.
 * @property {HTMLElement} cartDiscountErrorShipping - The shipping error element.
 */

/**
 * @extends {Component<CartDiscountComponentRefs>}
 */
class CartDiscount extends Component {
  requiredRefs = ['cartDiscountError', 'cartDiscountErrorDiscountCode', 'cartDiscountErrorShipping'];

  /** @type {AbortController | null} */
  #activeFetch = null;

  #createAbortController() {
    if (this.#activeFetch) {
      this.#activeFetch.abort();
    }

    const abortController = new AbortController();
    this.#activeFetch = abortController;
    return abortController;
  }

  /**
   * Handles updates to the cart note.
   * @param {SubmitEvent} event - The submit event on our form.
   */
  applyDiscount = async (event) => {
    const { cartDiscountError, cartDiscountErrorDiscountCode, cartDiscountErrorShipping } = this.refs;

    event.preventDefault();
    event.stopPropagation();

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    const discountCode = form.querySelector('input[name="discount"]');
    if (!(discountCode instanceof HTMLInputElement) || typeof this.dataset.sectionId !== 'string') return;

    const discountCodeValue = discountCode.value.trim();

    if (!discountCodeValue) {
      this.#handleDiscountError('discount_code');
      return;
    }

    const abortController = this.#createAbortController();

    const existingDiscounts = this.#existingDiscounts();
    if (existingDiscounts.some((code) => this.#normalizeCode(code) === this.#normalizeCode(discountCodeValue))) {
      discountCode.value = '';
      return;
    }

    cartDiscountError.classList.add('hidden');
    cartDiscountErrorDiscountCode.classList.add('hidden');
    cartDiscountErrorShipping.classList.add('hidden');

    const allDiscountCodes = [...existingDiscounts, discountCodeValue];
    const deferredPromise = CartDiscountUpdateEvent.createPromise();

    this.dispatchEvent(
      new CartDiscountUpdateEvent({
        discountCodes: allDiscountCodes.map((code) => ({ code })),
        promise: deferredPromise.promise,
      })
    );

    try {
      const config = fetchConfig('json', {
        body: JSON.stringify({
          discount: allDiscountCodes.join(','),
          sections: [this.dataset.sectionId],
        }),
      });

      const response = await fetch(Theme.routes.cart_update_url, {
        ...config,
        signal: abortController.signal,
      });

      if (!response.ok) throw new Error(`Discount update failed with status ${response.status}`);

      let data = await response.json();
      let discountWasApplied = this.#hasApplicableDiscount(data, discountCodeValue);

      // Shopify can persist a valid code before the mutation response reflects its
      // final allocation. Confirm an ambiguous response against the persisted cart,
      // matching the safeguard used by the Hydrogen storefront.
      if (!discountWasApplied) {
        const persistedResponse = await fetch(`${Theme.routes.cart_url}.json`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: abortController.signal,
        });

        if (persistedResponse.ok) {
          const persistedCart = await persistedResponse.json();
          discountWasApplied = this.#hasApplicableDiscount(persistedCart, discountCodeValue);

          // Request fresh section HTML after an eventually-consistent success so
          // totals and the applied-code pill render from the persisted cart state.
          if (discountWasApplied) {
            const refreshedResponse = await fetch(Theme.routes.cart_update_url, {
              ...config,
              signal: abortController.signal,
            });
            if (refreshedResponse.ok) data = await refreshedResponse.json();
          }
        }
      }

      if (!discountWasApplied) {
        discountCode.value = '';
        this.#handleDiscountError('discount_code');
        deferredPromise.resolve({
          cart: CartDiscountUpdateEvent.createCartFromAjaxResponse(data),
        });
        return;
      }

      const newHtml = data.sections[this.dataset.sectionId];
      const parsedHtml = new DOMParser().parseFromString(newHtml, 'text/html');
      const section = parsedHtml.getElementById(`shopify-section-${this.dataset.sectionId}`);
      const discountCodes = section?.querySelectorAll('.cart-discount__pill') || [];
      if (section) {
        const codes = Array.from(discountCodes)
          .map((element) => (element instanceof HTMLLIElement ? element.dataset.discountCode : null))
          .filter(Boolean);
        // Before morphing, we need to check if the shipping discount is applicable in the UI
        // we check the liquid logic compared to the cart payload to assess whether we leveraged
        // a valid shipping discount code.
        if (
          codes.length === existingDiscounts.length &&
          codes.every((/** @type {string} */ code) => existingDiscounts.includes(code)) &&
          this.#hasApplicableDiscount(data, discountCodeValue)
        ) {
          this.#handleDiscountError('shipping');
          discountCode.value = '';
          deferredPromise.resolve({
            cart: CartDiscountUpdateEvent.createCartFromAjaxResponse(data),
          });
          return;
        }
      }

      deferredPromise.resolve({
        cart: CartDiscountUpdateEvent.createCartFromAjaxResponse(data),
      });
      // Clear the input explicitly: data-skip-node-update on <input name="discount"> means
      // morphSection no longer syncs the input value from the server-rendered empty state,
      // so without this the user's typed code stays in the field after a successful apply.
      discountCode.value = '';
      morphSection(this.dataset.sectionId, newHtml, { mode: this.closest('theme-drawer') ? 'hydration' : 'full' });
    } catch (error) {
      deferredPromise.reject(error);
      if (error instanceof Error && error.name !== 'AbortError') {
        this.dispatchEvent(
          new CartErrorEvent({
            error: error.message || 'Failed to apply discount',
            code: 'SERVICE_UNAVAILABLE',
          })
        );
      }
    } finally {
      this.#activeFetch = null;
      cartPerformance.measureFromEvent('discount-update:user-action', event);
    }
  };

  /**
   * Handles removing a discount from the cart.
   * @param {MouseEvent | KeyboardEvent} event - The mouse or keyboard event in our pill.
   */
  removeDiscount = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (
      (event instanceof KeyboardEvent && event.key !== 'Enter') ||
      !(event instanceof MouseEvent) ||
      !(event.target instanceof HTMLElement) ||
      typeof this.dataset.sectionId !== 'string'
    ) {
      return;
    }

    const pill = event.target.closest('.cart-discount__pill');
    if (!(pill instanceof HTMLLIElement)) return;

    const discountCode = pill.dataset.discountCode;
    if (!discountCode) return;

    const existingDiscounts = this.#existingDiscounts();
    const index = existingDiscounts.indexOf(discountCode);
    if (index === -1) return;

    existingDiscounts.splice(index, 1);

    const abortController = this.#createAbortController();
    const deferredPromise = CartDiscountUpdateEvent.createPromise();

    this.dispatchEvent(
      new CartDiscountUpdateEvent({
        discountCodes: existingDiscounts.map((code) => ({ code })),
        promise: deferredPromise.promise,
      })
    );

    try {
      const config = fetchConfig('json', {
        body: JSON.stringify({ discount: existingDiscounts.join(','), sections: [this.dataset.sectionId] }),
      });

      const response = await fetch(Theme.routes.cart_update_url, {
        ...config,
        signal: abortController.signal,
      });

      const data = await response.json();

      deferredPromise.resolve({
        cart: CartDiscountUpdateEvent.createCartFromAjaxResponse(data),
      });

      morphSection(this.dataset.sectionId, data.sections[this.dataset.sectionId], {
        mode: this.closest('theme-drawer') ? 'hydration' : 'full',
      });
    } catch (error) {
      deferredPromise.reject(error);
      if (error instanceof Error && error.name !== 'AbortError') {
        this.dispatchEvent(
          new CartErrorEvent({
            error: error.message || 'Failed to remove discount',
            code: 'SERVICE_UNAVAILABLE',
          })
        );
      }
    } finally {
      this.#activeFetch = null;
    }
  };

  /**
   * Handles the discount error.
   *
   * @param {'discount_code' | 'shipping'} type - The type of discount error.
   */
  #handleDiscountError(type) {
    const { cartDiscountError, cartDiscountErrorDiscountCode, cartDiscountErrorShipping } = this.refs;
    const target = type === 'discount_code' ? cartDiscountErrorDiscountCode : cartDiscountErrorShipping;
    cartDiscountError.classList.remove('hidden');
    target.classList.remove('hidden');

    const errorMessage = type === 'discount_code' ? 'Invalid discount code' : 'Discount not applicable for shipping';
    this.dispatchEvent(
      new CartErrorEvent({
        error: errorMessage,
        code: 'VALIDATION_CUSTOM',
      })
    );
  }

  /**
   * Returns an array of existing discount codes.
   * @returns {string[]}
   */
  #existingDiscounts() {
    /** @type {string[]} */
    const discountCodes = [];
    const discountPills = this.querySelectorAll('.cart-discount__pill');
    for (const pill of discountPills) {
      if (pill instanceof HTMLLIElement && typeof pill.dataset.discountCode === 'string') {
        discountCodes.push(pill.dataset.discountCode);
      }
    }

    return discountCodes;
  }

  /**
   * Normalizes a code for comparisons while preserving the submitted value sent to Shopify.
   * @param {string} code
   */
  #normalizeCode(code) {
    return code.trim().toLocaleLowerCase();
  }

  /**
   * Checks both Shopify's discount-code response and the resulting discount allocations.
   * @param {any} cart
   * @param {string} submittedCode
   */
  #hasApplicableDiscount(cart, submittedCode) {
    const normalizedCode = this.#normalizeCode(submittedCode);
    const codeMatches = (/** @type {unknown} */ code) =>
      typeof code === 'string' && this.#normalizeCode(code) === normalizedCode;

    if (
      Array.isArray(cart?.discount_codes) &&
      cart.discount_codes.some(
        (/** @type {{ code?: string; applicable?: boolean }} */ discount) =>
          codeMatches(discount.code) && discount.applicable !== false
      )
    ) {
      return true;
    }

    if (
      Array.isArray(cart?.cart_level_discount_applications) &&
      cart.cart_level_discount_applications.some(
        (/** @type {{ title?: string }} */ application) => codeMatches(application.title)
      )
    ) {
      return true;
    }

    return (
      Array.isArray(cart?.items) &&
      cart.items.some(
        (/** @type {{ line_level_discount_allocations?: Array<{ discount_application?: { title?: string } }> }} */ item) =>
          item.line_level_discount_allocations?.some((allocation) =>
            codeMatches(allocation.discount_application?.title)
          )
      )
    );
  }
}

if (!customElements.get('cart-discount-component')) {
  customElements.define('cart-discount-component', CartDiscount);
}
