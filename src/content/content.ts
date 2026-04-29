import extractWebsiteParts from "./utils/extractWebsiteParts.ts";
import highlightParagraph from "./utils/highlightParagraph.ts";

const ContentTasks = {
  EXTRACT_PAGE_DATA: 0,
  HIGHLIGHT_ELEMENTS: 1,
  CLEAR_HIGHLIGHTS: 2,
} as const;

const REPORT_USER_ACTIVITY_TASK = 7;
type UserActivityEventType = "scroll" | "click";

const USER_ACTIVITY_THROTTLE_MS = 10_000;
let lastActivitySentAt = 0;

const reportUserActivity = (eventType: UserActivityEventType) => {
  const now = Date.now();
  if (now - lastActivitySentAt < USER_ACTIVITY_THROTTLE_MS) return;

  lastActivitySentAt = now;
  chrome.runtime.sendMessage(
    {
      type: REPORT_USER_ACTIVITY_TASK,
      eventType,
      url: window.location.href,
      timestamp: now,
    },
    () => {
      // Ignore "receiving end does not exist" while worker is sleeping.
      void chrome.runtime.lastError;
    }
  );
};

window.addEventListener(
  "scroll",
  () => {
    reportUserActivity("scroll");
  },
  { passive: true }
);

window.addEventListener("click", () => {
  reportUserActivity("click");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === ContentTasks.EXTRACT_PAGE_DATA) {
    const main =
      document.querySelector("main") || document.querySelector("body");

    const parts = extractWebsiteParts(main);

    sendResponse({
      parts,
    });
  }

  if (message.type === ContentTasks.HIGHLIGHT_ELEMENTS) {
    highlightParagraph(message.payload.id);
    sendResponse({ success: true });
  }

  if (message.type === ContentTasks.CLEAR_HIGHLIGHTS) {
    const allElements = document.querySelectorAll('[style*="outline"]');
    allElements.forEach((element) => {
      const htmlElement = element as HTMLElement;
      htmlElement.style.outline = "";
      htmlElement.style.backgroundColor = "";
    });

    sendResponse({ success: true });
  }

  return true;
});
