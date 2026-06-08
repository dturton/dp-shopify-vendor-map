/*
 * MAP price notice — keeps the notice in sync with the selected variant.
 *
 * Each block embeds a JSON map of variantId -> { enabled, price } (price is the
 * advertised MAP, i.e. variant.price). When the shopper switches variants we show
 * or hide the notice and update the displayed list price. For single-variant or
 * product-level MAP this is a no-op beyond the initial render.
 */
(function () {
  function initBlock(root) {
    var dataEl = root.querySelector("[data-map-notice-data]");
    if (!dataEl) return;

    var variants;
    try {
      variants = (JSON.parse(dataEl.textContent) || {}).variants || {};
    } catch (e) {
      return;
    }

    var priceEl = root.querySelector("[data-map-price]");

    // Optional: hide the theme's own price element on MAP variants.
    var hideNative = root.getAttribute("data-hide-native-price") === "true";
    var nativeSelector = root.getAttribute("data-native-price-selector") || "";
    var scope = root.closest(".shopify-section") || document;

    function toggleNativePrice(hide) {
      if (!hideNative || !nativeSelector) return;
      var nodes;
      try {
        nodes = scope.querySelectorAll(nativeSelector);
      } catch (e) {
        return; // invalid selector — fail safe, don't touch anything
      }
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (root.contains(node)) continue; // never hide our own price
        node.style.display = hide ? "none" : "";
      }
    }

    function apply(variantId) {
      if (variantId === null || variantId === undefined) return;
      var info = variants[String(variantId)];
      // Unknown variant (e.g. a product with >50 variants): leave the current
      // server-rendered state untouched rather than guessing.
      if (!info) return;
      root.hidden = !info.enabled;
      if (priceEl && info.price) priceEl.innerHTML = info.price;
      toggleNativePrice(info.enabled);
    }

    var form =
      root.closest("form[action*='/cart/add']") ||
      document.querySelector("form[action*='/cart/add']");

    function currentVariantId() {
      var input = form && form.querySelector("[name='id']");
      return input ? input.value : null;
    }

    if (form) {
      form.addEventListener("change", function () {
        // Defer so the theme's own handler updates the hidden id input first.
        window.setTimeout(function () {
          apply(currentVariantId());
        }, 0);
      });
      apply(currentVariantId());
    } else {
      // No product form found — honor the server-rendered state for the initial
      // native-price hide (variant switching just won't be tracked).
      toggleNativePrice(!root.hidden);
    }

    // Best-effort support for themes that broadcast a variant change event.
    ["variant:change", "on:variant:change"].forEach(function (name) {
      document.addEventListener(name, function (event) {
        var v = event && event.detail && event.detail.variant;
        if (v && v.id !== undefined && v.id !== null) apply(v.id);
      });
    });
  }

  function initAll() {
    var blocks = document.querySelectorAll("[data-map-notice]");
    for (var i = 0; i < blocks.length; i++) initBlock(blocks[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();
