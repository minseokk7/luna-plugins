import { LunaUnload, Tracer } from "@luna/core";
import { redux } from "@luna/lib";
import { translations } from "./translations";

const { trace } = Tracer("[KoreanTranslation]");

export const unloads = new Set<LunaUnload>();

const untranslatedStrings = new Set<string>();
let isTranslating = false;

// 1. Redux Direct Injection & Interception
// Direct injection into the Redux state to provide a "permanent" change feel without flicker.
const injectTranslationsToRedux = () => {
  try {
    const state = redux.store.getState();
    const currentBundleName = state.locale?.currentBundleName;
    const bundle = state.locale?.bundles?.[currentBundleName];
    if (bundle && bundle.i18n) {
      Object.assign(bundle.i18n, translations);
      // We don't log to keep the UI clean as requested.
    }
  } catch (err) {
    // Silent fail to keep user experience smooth
  }
};

// Intercept locale loading actions to inject translations before strings hit the UI
redux.intercept("locale/LOAD_BUNDLE_SUCCESS", unloads, (payload: any) => {
  if (payload.bundle && payload.bundle.i18n) {
    Object.assign(payload.bundle.i18n, translations);
  }
});

// Re-inject on bundle switch or navigation to ensure translations stick
redux.intercept(["locale/BUNDLE_SWITCH_SUCCESS", "router/NAVIGATED"], unloads, () => {
    setTimeout(injectTranslationsToRedux, 200);
});

// Perform initial injection
injectTranslationsToRedux();

// 2. Modified translateText for non-Redux strings (Fallback)
const translateText = (node: Node) => {
  // We removed the isSettingsPage() guard here so that global menus 
  // (like the User Profile menu) are translated even when on the settings page.
  // Performance is handled by the 100ms throttle and Redux injection.

  if (node.nodeType === Node.TEXT_NODE) {
    const originalText = node.textContent?.trim();
    if (originalText && originalText.length > 1) { 
      if (translations[originalText]) {
        isTranslating = true;
        node.textContent = node.textContent!.replace(originalText, translations[originalText]);
        isTranslating = false;
      }
    }
  } else if (node instanceof HTMLElement) {
    ["placeholder", "title", "aria-label"].forEach(attr => {
      const val = node.getAttribute(attr);
      if (val && translations[val.trim()]) {
        isTranslating = true;
        node.setAttribute(attr, translations[val.trim()]);
        isTranslating = false;
      }
    });
  }
};

// Optimized Recursive function for initial and fallback translation
const translateSubtree = (root: Node) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      if (node instanceof HTMLElement) {
        if (node.tagName === "SCRIPT" || node.tagName === "STYLE") return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let currentNode = walker.currentNode;
  while (currentNode) {
    translateText(currentNode);
    currentNode = walker.nextNode()!;
  }
};

const pendingNodes = new Set<Node>();
let mutationTimeout: any = null;

const processPendingNodes = () => {
  const nodesToProcess = Array.from(pendingNodes);
  pendingNodes.clear();
  nodesToProcess.forEach(node => translateSubtree(node));
  mutationTimeout = null;
};

const observer = new MutationObserver((mutations) => {
  // CRITICAL: Ignore mutations triggered by our own translations to prevent infinite loops and freezes.
  if (isTranslating) return;

  let totalAdded = 0;
  for (const mutation of mutations) {
    if (mutation.type === "childList") {
      totalAdded += mutation.addedNodes.length;
      mutation.addedNodes.forEach(node => pendingNodes.add(node));
    } else if (mutation.type === "characterData" || mutation.type === "attributes") {
      pendingNodes.add(mutation.target);
    }
  }

  if (pendingNodes.size === 0) return;

  // Use a short delay even for "instant" feel to avoid blocking the UI thread during bursts.
  // 16ms roughly corresponds to 1 frame at 60fps, providing a smooth experience.
  if (pendingNodes.size < 30 && totalAdded < 20) {
    if (mutationTimeout) clearTimeout(mutationTimeout);
    mutationTimeout = setTimeout(processPendingNodes, 16); // "Instant" but safe
  } else if (!mutationTimeout) {
    // Large batch (like a playlist): use longer throttle to keep app responsive.
    mutationTimeout = setTimeout(processPendingNodes, 150);
  }
});

// Start initial fallback translation
translateSubtree(document.body);

// Start observer
observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ["placeholder", "title", "aria-label", "class"]
});

unloads.add(() => {
  observer.disconnect();
});

