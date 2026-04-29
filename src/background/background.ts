import { ModelRegistry } from "@huggingface/transformers";

import {
  MODELS,
  REQUIRED_MODEL_IDS,
  SIDEPANEL_PORT_NAME,
} from "../shared/constants.ts";
import { AvailableTools } from "../shared/tools.ts";
import {
  BackgroundMessages,
  BackgroundTasks,
  ResponseStatus,
  UserActivityEventType,
} from "../shared/types.ts";
import Agent from "./agent/Agent.ts";
import {
  createAskWebsiteTool,
  highlightWebsiteElementTool,
} from "./tools/askWebsite.ts";
//import { googleSearchTool } from "./tools/search.ts";
import {
  closeTabTool,
  getOpenTabsTool,
  goToTabTool,
  openUrlTool,
} from "./tools/tabActions.ts";
import FeatureExtractor from "./utils/FeatureExtractor.ts";
import VectorHistory from "./vectorHistory/VectorHistory.ts";

import Tab = chrome.tabs.Tab;

let lastProgress: number = 0;
const onModelDownloadProgress = (modelId: string, percentage: number) => {
  const rounded = Math.round(percentage * 100) / 100;
  if (rounded === lastProgress) return;
  lastProgress = rounded;

  chrome.runtime.sendMessage({
    type: BackgroundMessages.DOWNLOAD_PROGRESS,
    modelId,
    percentage: rounded,
  });
};

const featureExtractor = new FeatureExtractor();
const vectorHistory = new VectorHistory(featureExtractor);
let currentAgent: Agent | null = null;
const sidePanelPorts = new Set<chrome.runtime.Port>();

const PROACTIVE_ALARM_NAME = "proactive-check";
const PROACTIVE_MIN_DWELL_MS = 1 * 60 * 1000;
const PROACTIVE_GLOBAL_COOLDOWN_MS = 10 * 60 * 1000;
const SIDEPANEL_HEARTBEAT_TTL_MS = 35_000;

type EngagementState = {
  tabId: number;
  url: string;
  activeSince: number;
  lastInteractionAt: number | null;
  hasInteraction: boolean;
};

let currentEngagement: EngagementState | null = null;
let lastGlobalProactiveAt: number | null = null;
const promptedUrls = new Set<string>();
let lastSidePanelHeartbeatAt: number | null = null;
let pendingModelTasks = 0;
let modelTaskQueue: Promise<void> = Promise.resolve();

const availableTools: Record<string, () => any> = {
  [AvailableTools.GET_OPEN_TABS]: () => getOpenTabsTool,
  [AvailableTools.GO_TO_TAB]: () => goToTabTool,
  [AvailableTools.OPEN_URL]: () => openUrlTool,
  [AvailableTools.CLOSE_TAB]: () => closeTabTool,
  [AvailableTools.FIND_HISTORY]: () => vectorHistory.findHistoryTool,
  [AvailableTools.ASK_WEBSITE]: () => createAskWebsiteTool(featureExtractor),
  [AvailableTools.HIGHLIGHT_WEBSITE_ELEMENT]: () => highlightWebsiteElementTool,
  //[AvailableTools.GOOGLE_SEARCH]: () => googleSearchTool,
};

const createAgent = (toolNames?: string[]): Agent => {
  const agent = new Agent();

  const toolsToRegister = toolNames || Object.keys(availableTools);

  for (const toolName of toolsToRegister) {
    const toolFactory = availableTools[toolName];
    if (toolFactory) {
      agent.setTool(toolFactory());
    } else {
      console.warn(`[Agent] Unknown tool requested: ${toolName}`);
    }
  }

  agent.onChatMessageUpdate((messages) =>
    chrome.runtime.sendMessage({
      type: BackgroundMessages.MESSAGES_UPDATE,
      messages,
    })
  );

  return agent;
};

const getAgent = (): Agent => {
  if (!currentAgent) {
    currentAgent = createAgent();
  }
  return currentAgent;
};

const isTrackableUrl = (url: string | undefined): url is string =>
  Boolean(url?.startsWith("http"));

const startTracking = (tabId: number, url: string) => {
  if (currentEngagement?.tabId === tabId && currentEngagement.url === url) return;

  currentEngagement = {
    tabId,
    url,
    activeSince: Date.now(),
    lastInteractionAt: null,
    hasInteraction: false,
  };
};

const markUserInteraction = (tabId: number, url: string) => {
  if (!currentEngagement) return;
  if (currentEngagement.tabId !== tabId || currentEngagement.url !== url) return;

  currentEngagement = {
    ...currentEngagement,
    hasInteraction: true,
    lastInteractionAt: Date.now(),
  };
};

const hasOpenSidePanel = () => {
  if (sidePanelPorts.size > 0) return true;
  if (!lastSidePanelHeartbeatAt) return false;
  return Date.now() - lastSidePanelHeartbeatAt <= SIDEPANEL_HEARTBEAT_TTL_MS;
};
const isModelBusy = () => pendingModelTasks > 0;

const enqueueModelTask = <T>(task: () => Promise<T>): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const run = async (): Promise<void> => {
      pendingModelTasks += 1;
      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        pendingModelTasks -= 1;
      }
    };

    modelTaskQueue = modelTaskQueue.then(run, run);
  });
};

const shouldTriggerProactiveMessage = (now: number) => {
  if (!hasOpenSidePanel()) return false;
  if (!currentEngagement) return false;
  if (promptedUrls.has(currentEngagement.url)) return false;
  if (now - currentEngagement.activeSince < PROACTIVE_MIN_DWELL_MS) return false;
  if (!currentEngagement.hasInteraction) return false;
  if (
    lastGlobalProactiveAt &&
    now - lastGlobalProactiveAt < PROACTIVE_GLOBAL_COOLDOWN_MS
  ) {
    return false;
  }

  return true;
};

const createProactivePrompt = (tabTitle: string, url: string): string =>
  [
    "あなたはブラウジング中のユーザーに寄り添う、カジュアルな日本語アシスタントです。",
    "ユーザーがこのページをしばらく読んでいます。",
    `ページタイトル: ${tabTitle}`,
    `URL: ${url}`,
    "1〜2文で、押しつけず自然に話しかけてください。",
    "ユーザーが何に興味を持ったかを尋ねるオープンな問いを必ず含めてください。",
  ].join("\n");

const maybeSendProactiveMessage = async () => {
  const now = Date.now();
  if (!shouldTriggerProactiveMessage(now) || !currentEngagement) return;
  if (isModelBusy()) return;

  try {
    const tab = await chrome.tabs.get(currentEngagement.tabId);
    if (!isTrackableUrl(tab.url) || tab.url !== currentEngagement.url) return;

    const tabTitle = tab.title || "Untitled";
    const prompt = createProactivePrompt(tabTitle, currentEngagement.url);
    const agent = getAgent();

    await enqueueModelTask(() =>
      agent.runAgent(prompt, { includeUserMessage: false })
    );

    promptedUrls.add(currentEngagement.url);
    lastGlobalProactiveAt = now;
  } catch (error) {
    console.error("Failed to send proactive message:", error);
  }
};

const syncTrackingToCurrentTab = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isTrackableUrl(tab.url)) {
      currentEngagement = null;
      return;
    }

    startTracking(tab.id, tab.url);
  } catch (error) {
    console.error("Failed to sync active tab for proactive tracking:", error);
  }
};

const ensureProactiveAlarm = async () => {
  await chrome.alarms.create(PROACTIVE_ALARM_NAME, { periodInMinutes: 1 });
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === BackgroundTasks.CHECK_MODELS) {
    Promise.all(
      REQUIRED_MODEL_IDS.map(async (modelId) => {
        const model = Object.values(MODELS).find((m) => m.modelId === modelId);
        const files = await ModelRegistry.get_pipeline_files(
          model.task,
          modelId,
          {
            dtype: model.dtype,
          }
        );
        const metas = await Promise.all(
          files.map((file) => ModelRegistry.get_file_metadata(modelId, file))
        );
        const downloadSize = metas.reduce(
          (total, item) => total + (item.size ?? 0),
          0
        );
        const isCached = await ModelRegistry.is_pipeline_cached(
          model.task,
          modelId,
          {
            dtype: model.dtype,
          }
        );
        return {
          size: downloadSize,
          cached: isCached,
          modelId,
        };
      })
    )
      .then((results) => {
        sendResponse({ status: ResponseStatus.SUCCESS, results });
      })
      .catch((error: Error) => {
        console.error("CHECK_MODELS failed:", error);
        sendResponse({ status: ResponseStatus.ERROR, error: error.message });
      });
    return true;
  }

  if (message.type === BackgroundTasks.INITIALIZE_MODELS) {
    const agent = getAgent();
    Promise.all([
      featureExtractor.getFeatureExtractionPipeline(onModelDownloadProgress),
      agent.getTextGenerationPipeline(onModelDownloadProgress),
    ])
      .then(() => {
        sendResponse({ status: ResponseStatus.SUCCESS });
      })
      .catch((error: Error) => {
        console.error("INITIALIZE_MODELS failed:", error);
        sendResponse({ status: ResponseStatus.ERROR, error: error.message });
      });

    return true;
  }

  if (message.type === BackgroundTasks.AGENT_INITIALIZE) {
    if (isModelBusy()) {
      sendResponse({
        status: ResponseStatus.ERROR,
        error: "Agent is busy. Please retry after the current response finishes.",
      });
      return true;
    }

    const tools = message.tools as string[] | undefined;
    currentAgent = createAgent(tools);
    sendResponse({ status: ResponseStatus.SUCCESS });
    chrome.runtime.sendMessage({
      type: BackgroundMessages.MESSAGES_UPDATE,
      messages: [],
    });
    return true;
  }

  if (message.type === BackgroundTasks.AGENT_GENERATE_TEXT) {
    const agent = getAgent();
    enqueueModelTask(() => agent.runAgent(message.prompt))
      .then((metrics) => {
        sendResponse({ status: ResponseStatus.SUCCESS, metrics });
      })
      .catch((error: Error) => {
        console.error("GENERATE_TEXT failed:", error);
        sendResponse({ status: ResponseStatus.ERROR, error: error.message });
      });

    return true;
  }

  if (message.type === BackgroundTasks.AGENT_GET_MESSAGES) {
    const agent = getAgent();
    sendResponse({
      status: ResponseStatus.SUCCESS,
      messages: agent.chatMessages,
    });
    return true;
  }

  if (message.type === BackgroundTasks.AGENT_CLEAR) {
    if (isModelBusy()) {
      sendResponse({
        status: ResponseStatus.ERROR,
        error: "Agent is busy. Please retry after the current response finishes.",
      });
      return true;
    }

    const agent = getAgent();
    agent.clear();
    sendResponse({ status: ResponseStatus.SUCCESS });
    return true;
  }

  if (message.type === BackgroundTasks.EXTRACT_FEATURES) {
    enqueueModelTask(() => featureExtractor.extractFeatures([message.text]))
      .then((result) => {
        sendResponse({ status: ResponseStatus.SUCCESS, result: result[0] });
      })
      .catch((error) => {
        console.error("EXTRACT_FEATURES failed:", error);
        sendResponse({ status: ResponseStatus.ERROR, error: error.message });
      });

    return true;
  }

  if (message.type === BackgroundTasks.REPORT_USER_ACTIVITY) {
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url;
    const eventType = message.eventType as UserActivityEventType | undefined;

    if (tabId && tabUrl && (eventType === "scroll" || eventType === "click")) {
      markUserInteraction(tabId, tabUrl);
    }

    sendResponse({ status: ResponseStatus.SUCCESS });
    return true;
  }

  if (message.type === BackgroundTasks.SIDEPANEL_HEARTBEAT) {
    lastSidePanelHeartbeatAt = Date.now();
    sendResponse({ status: ResponseStatus.SUCCESS });
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SIDEPANEL_PORT_NAME) return;

  lastSidePanelHeartbeatAt = Date.now();
  sidePanelPorts.add(port);
  port.onDisconnect.addListener(() => {
    sidePanelPorts.delete(port);
    if (sidePanelPorts.size === 0) {
      lastSidePanelHeartbeatAt = null;
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PROACTIVE_ALARM_NAME) return;
  void maybeSendProactiveMessage();
});

void ensureProactiveAlarm();
void syncTrackingToCurrentTab();

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!isTrackableUrl(tab.url)) {
      currentEngagement = null;
      return;
    }

    startTracking(activeInfo.tabId, tab.url);
  } catch (error) {
    console.error("Failed to update engagement after tab activation:", error);
  }
});

const addCurrentPageToVectorHistory = async (tabId: number, tab: Tab) => {
  const title = tab.title || "Untitled";
  let description = "";

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const metaDescription = document.querySelector(
          'meta[name="description"]'
        );
        return metaDescription?.getAttribute("content") || "";
      },
    });
    description = results[0]?.result || "";
  } catch (error) {
    console.error(`Could not extract description from tab ${tabId}:`, error);
  }

  if (!description) {
    description = tab.url || "";
  }

  // Add to vector history
  try {
    await enqueueModelTask(() => vectorHistory.addEntry(title, description, tab.url));
  } catch (error) {
    console.error("Failed to add page to vector history:", error);
  }
};

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!isTrackableUrl(tab.url)) return;

  // Add page to vector history for later retrieval
  addCurrentPageToVectorHistory(tabId, tab);

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id === tabId) {
      startTracking(tabId, tab.url);
    }
  } catch (error) {
    console.error("Failed to update engagement after tab update:", error);
  }
});
