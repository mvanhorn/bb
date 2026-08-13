// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { useBbNavigate } from "@/lib/plugin-sdk-hooks";
import {
  PaneContext,
  type PaneContextValue,
} from "@/views/thread-detail/PaneContext";
import { PluginSlotMount } from "./PluginSlotMount";
import {
  ensurePluginRightPanelDefaultView,
  getPluginPanelRightPanelStateId,
  PluginPanelRightPanelHost,
  reconcilePluginRightPanelState,
} from "./PluginPanelRightPanelHost";
import { createEmptyFixedPanelTabsState } from "@/lib/fixed-panel-tabs-state";
import type { PluginNavPanelSlot } from "@/lib/plugin-slots";

const hostState = vi.hoisted(() => ({
  activePluginPanelTab: null as {
    actionId: string;
    id: string;
    kind: "plugin-panel";
    paramsJson: string | null;
    pluginId: string;
    title: string;
  } | null,
  activeBrowserTab: null as {
    environmentId: null;
    id: string;
    kind: "browser";
    title: string | null;
    url: string;
  } | null,
  browserTabs: [] as Array<{
    environmentId: null;
    id: string;
    kind: "browser";
    title: string | null;
    url: string;
  }>,
  compact: false,
  desktopBrowserApiMode: "scoped" as "legacy" | "scoped",
  frontendLoadState: "loading" as "loading" | "settled",
  panelAvailable: true,
  rightPanelAvailable: true,
  panelOpen: true,
  activeTerminalTab: null as {
    id: string;
    kind: "terminal";
    terminalId: string;
    target: { kind: "host_path"; hostId: string; cwd: null };
  } | null,
  terminalSessions: undefined as
    | Array<{ id: string; status: "running"; title: string }>
    | undefined,
  terminalQueryEnabled: false,
  tools: ["browser", "terminal"] as Array<"browser" | "terminal">,
}));
const openTab = vi.hoisted(() => vi.fn());
const openPluginPanel = vi.hoisted(() => vi.fn());
const updatePanelState = vi.hoisted(() => vi.fn());
const createTerminalMutate = vi.hoisted(() => vi.fn());
const closeTab = vi.hoisted(() => vi.fn());
const closeTerminalMutate = vi.hoisted(() => vi.fn());
const drawerState = vi.hoisted(
  (): {
    onContentAnimationEnd: ((open: boolean) => void) | null;
  } => ({ onContentAnimationEnd: null }),
);
const dispatchBrowserViewBoundsSync = vi.hoisted(() => vi.fn());
const realizeContent = vi.hoisted(() => vi.fn());
const desktopBrowserApiState = vi.hoisted(
  (): {
    onOpenTab: Array<(event: { url: string }) => void>;
    onScopedOpenTab: null | ((event: { tabId: string; url: string }) => void);
  } => ({ onOpenTab: [], onScopedOpenTab: null }),
);
const onOpenTab = vi.hoisted(() =>
  vi.fn((handler: (event: { url: string }) => void) => {
    desktopBrowserApiState.onOpenTab.push(handler);
    return vi.fn();
  }),
);
const onScopedOpenTab = vi.hoisted(() =>
  vi.fn((handler: (event: { tabId: string; url: string }) => void) => {
    desktopBrowserApiState.onScopedOpenTab = handler;
    return vi.fn();
  }),
);

const rightPanelSlot: PluginNavPanelSlot = {
  id: "docs",
  pluginId: "docs",
  generation: 1,
  title: "Docs",
  icon: "FileText",
  path: "docs",
  component: () => null,
  experimental_rightPanel: {
    views: [
      {
        id: "navigation",
        title: "Navigation",
        component: () => null,
        layout: "flush",
      },
    ],
    defaultViewId: "navigation",
  },
};

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => hostState.compact,
}));

vi.mock("@bb/shared-ui/responsive-overlay", async () => {
  const React = await import("react");
  const Drawer = ({
    children,
    onContentAnimationEnd,
    open,
  }: {
    children: React.ReactNode;
    onContentAnimationEnd?: (open: boolean) => void;
    open?: boolean;
  }) => {
    drawerState.onContentAnimationEnd = onContentAnimationEnd ?? null;
    return React.createElement(
      "div",
      { "data-open": String(open), "data-testid": "drawer" },
      children,
    );
  };
  return {
    environmentId: null,
    PersistentResponsiveDrawerShell: Drawer,
    ResponsiveDrawerShell: Drawer,
    useResponsiveDrawerRealization: () => ({
      isContentRealized: true,
      realizeContent,
    }),
  };
});

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  return {
    Panel: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    PanelGroup: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
  };
});

vi.mock("@/lib/fixed-panel-tabs", () => ({
  useCloseFixedSecondaryPanel: () => vi.fn(),
  useFixedPanelTabsState: () => ({
    version: 1,
    lastUsedAt: 0,
    secondary: {
      isOpen: hostState.panelOpen,
      activeTabId:
        hostState.activeTerminalTab?.id ??
        hostState.activePluginPanelTab?.id ??
        hostState.activeBrowserTab?.id ??
        null,
      tabs: [
        ...hostState.browserTabs,
        ...(hostState.activePluginPanelTab
          ? [hostState.activePluginPanelTab]
          : []),
        ...(hostState.activeTerminalTab ? [hostState.activeTerminalTab] : []),
      ],
    },
  }),
  useUpdateFixedPanelTabsState: () => updatePanelState,
}));

vi.mock("@/lib/plugin-slots", async () => {
  const React = await import("react");
  return {
    usePluginSlots: () => ({
      frontendLoadState: hostState.frontendLoadState,
      navPanels: hostState.panelAvailable
        ? [
            {
              id: "docs",
              pluginId: "docs",
              generation: 1,
              title: "Docs",
              icon: "FileText",
              path: "docs",
              component: () => null,
              experimental_rightPanel: hostState.rightPanelAvailable
                ? {
                    views: [
                      {
                        id: "navigation",
                        title: "Navigation",
                        component: ({
                          params,
                          subPath,
                        }: {
                          params: unknown;
                          subPath: string;
                        }) =>
                          React.createElement(
                            "div",
                            { "data-testid": "custom-view" },
                            `${subPath}:${JSON.stringify(params)}`,
                          ),
                        layout: "flush",
                      },
                    ],
                    defaultViewId: "navigation",
                    tools: hostState.tools,
                  }
                : undefined,
            },
          ]
        : [],
    }),
  };
});

vi.mock("@/hooks/queries/thread-terminal-queries", () => ({
  useTerminals: (_scope: unknown, options: { enabled: boolean }) => {
    hostState.terminalQueryEnabled = options.enabled;
    return {
      data:
        hostState.terminalSessions === undefined
          ? undefined
          : { sessions: hostState.terminalSessions },
      error: null,
      isLoading: false,
    };
  },
  useCreateTerminal: () => ({ isPending: false, mutate: createTerminalMutate }),
  useCloseTerminal: () => ({ mutate: closeTerminalMutate }),
}));

vi.mock("@/components/secondary-panel/useThreadFileTabs", () => ({
  useThreadFileTabs: () => ({
    activateTab: vi.fn(),
    activeBrowserTab: hostState.activeBrowserTab,
    activePluginPanelTab: hostState.activePluginPanelTab,
    browserTabs: hostState.browserTabs,
    closeTab,
    openPluginPanel,
    openTab,
    orderedSecondaryFileTabs: [
      ...hostState.browserTabs,
      ...(hostState.activePluginPanelTab
        ? [hostState.activePluginPanelTab]
        : []),
      ...(hostState.activeTerminalTab ? [hostState.activeTerminalTab] : []),
    ],
    reorderFileTab: vi.fn(),
    updateBrowserTab: vi.fn(),
  }),
}));

vi.mock("@/components/secondary-panel/BrowserTabDeck", async () => {
  const React = await import("react");
  return {
    BrowserTabDeck: ({
      browserTabs,
      canShowNativeBrowserView,
    }: {
      browserTabs: readonly { id: string }[];
      canShowNativeBrowserView: boolean;
    }) =>
      React.createElement("div", {
        "data-browser-tab-count": String(browserTabs.length),
        "data-can-show-native-browser-view": String(canShowNativeBrowserView),
        "data-testid": "browser-deck",
      }),
  };
});

vi.mock("@/components/secondary-panel/ThreadSecondaryPanel", async () => {
  const React = await import("react");
  return {
    ThreadSecondaryPanel: ({
      browserDeck,
      fileTabContent,
      onClose,
    }: {
      browserDeck: React.ReactNode;
      fileTabContent: React.ReactNode;
      onClose: () => void;
    }) =>
      React.createElement(
        "div",
        null,
        browserDeck,
        fileTabContent,
        React.createElement(
          "button",
          { type: "button", onClick: onClose },
          "Close right panel",
        ),
      ),
  };
});

vi.mock("@/components/thread/terminal/ThreadTerminalPanel", async () => {
  const React = await import("react");
  return {
    ThreadTerminalPanel: () =>
      React.createElement("div", { "data-testid": "terminal-panel" }),
  };
});

vi.mock("@/lib/bb-desktop", () => ({
  getDesktopBrowserApi: () =>
    hostState.desktopBrowserApiMode === "scoped"
      ? { onOpenTab, onScopedOpenTab }
      : { onOpenTab },
  isDesktopBrowserAvailable: () => true,
}));

vi.mock("@/lib/browser-view-bounds-sync", () => ({
  dispatchBrowserViewBoundsSync,
}));

interface FrameController {
  flushAll: () => void;
}

function installFrameController(): FrameController {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return {
    flushAll: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(0));
    },
  };
}

function browserTab(url = "https://example.com") {
  return {
    environmentId: null,
    id: "browser-tab-1",
    kind: "browser" as const,
    title: null,
    url,
  };
}

const basePaneContext: PaneContextValue = {
  paneId: "plugin-pane",
  isFocused: true,
  isSplitPane: true,
  secondaryPanelHost: null,
  reservesWindowPanelToggle: false,
  onRequestClose: null,
  isMaximized: false,
  onToggleMaximize: null,
  isBoundedPane: true,
  isTopRow: true,
  ownsWindowTopLeft: true,
  navigateInPane: () => {},
};

function NavigationProbe({ url }: { url: string }) {
  const navigate = useBbNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const accepted = navigate.experimental_openRightPanel({
            kind: "browser",
            url,
          });
          document.body.dataset.browserRequestAccepted = String(accepted);
        }}
      >
        Open Browser
      </button>
      <button
        type="button"
        onClick={() => {
          const accepted = navigate.experimental_openRightPanel({
            kind: "view",
            viewId: "navigation",
            params: { selected: "today" },
          });
          document.body.dataset.viewRequestAccepted = String(accepted);
        }}
      >
        Open View
      </button>
      <button
        type="button"
        onClick={() => {
          const accepted = navigate.experimental_openRightPanel({
            kind: "terminal",
            target: { kind: "host_path", hostId: "host-1" },
            title: "Plugin shell",
          });
          document.body.dataset.terminalRequestAccepted = String(accepted);
        }}
      >
        Open Terminal
      </button>
      <button
        type="button"
        onClick={() => {
          const accepted = Reflect.apply(
            navigate.experimental_openRightPanel,
            navigate,
            [{ kind: "terminal" }],
          );
          document.body.dataset.malformedTerminalRequestAccepted =
            String(accepted);
        }}
      >
        Open malformed Terminal
      </button>
    </>
  );
}

function HostFixture({
  flushPageInsets = false,
  paneContext = basePaneContext,
  subPath = "",
  togglePortal,
  url = "https://example.com",
}: {
  flushPageInsets?: boolean;
  paneContext?: PaneContextValue;
  subPath?: string;
  togglePortal?: { panelStateId: string; testId: string };
  url?: string;
}) {
  return (
    <MemoryRouter>
      <PaneContext.Provider value={paneContext}>
        <PluginPanelRightPanelHost
          pluginId="docs"
          panelPath="docs"
          subPath={subPath}
          flushPageInsets={flushPageInsets}
        >
          {togglePortal ? (
            <div
              data-plugin-right-panel-toggle-portal={togglePortal.panelStateId}
              data-testid={togglePortal.testId}
            />
          ) : null}
          <PluginSlotMount pluginId="docs" slotKind="test" slotId="browser">
            <NavigationProbe url={url} />
          </PluginSlotMount>
        </PluginPanelRightPanelHost>
      </PaneContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  hostState.activeBrowserTab = null;
  hostState.activePluginPanelTab = null;
  hostState.browserTabs = [];
  hostState.compact = false;
  hostState.desktopBrowserApiMode = "scoped";
  hostState.frontendLoadState = "loading";
  hostState.panelAvailable = true;
  hostState.rightPanelAvailable = true;
  hostState.panelOpen = true;
  hostState.activeTerminalTab = null;
  hostState.terminalSessions = undefined;
  hostState.terminalQueryEnabled = false;
  hostState.tools = ["browser", "terminal"];
  drawerState.onContentAnimationEnd = null;
  delete document.body.dataset.browserRequestAccepted;
  delete document.body.dataset.viewRequestAccepted;
  delete document.body.dataset.terminalRequestAccepted;
  delete document.body.dataset.malformedTerminalRequestAccepted;
  dispatchBrowserViewBoundsSync.mockClear();
  openTab.mockClear();
  openPluginPanel.mockClear();
  updatePanelState.mockClear();
  createTerminalMutate.mockClear();
  closeTab.mockClear();
  closeTerminalMutate.mockClear();
  realizeContent.mockClear();
  desktopBrowserApiState.onOpenTab = [];
  desktopBrowserApiState.onScopedOpenTab = null;
  onOpenTab.mockClear();
  onScopedOpenTab.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PluginPanelRightPanelHost", () => {
  it("portals each split pane toggle into that pane's owned target", () => {
    const paneA = { ...basePaneContext, paneId: "pane-a" };
    const paneB = { ...basePaneContext, paneId: "pane-b" };
    const targetA = getPluginPanelRightPanelStateId({
      panelPath: "docs",
      paneId: paneA.paneId,
      pluginId: "docs",
    });
    const targetB = getPluginPanelRightPanelStateId({
      panelPath: "docs",
      paneId: paneB.paneId,
      pluginId: "docs",
    });
    render(
      <TooltipProvider>
        <HostFixture
          paneContext={paneA}
          togglePortal={{ panelStateId: targetA, testId: "portal-a" }}
        />
        <HostFixture
          paneContext={paneB}
          togglePortal={{ panelStateId: targetB, testId: "portal-b" }}
        />
      </TooltipProvider>,
    );

    expect(
      within(screen.getByTestId("portal-a")).getAllByRole("button", {
        name: "Show right panel",
      }),
    ).toHaveLength(1);
    expect(
      within(screen.getByTestId("portal-b")).getAllByRole("button", {
        name: "Show right panel",
      }),
    ).toHaveLength(1);
  });

  it("extends flushed panel seams through both page insets", () => {
    const view = render(<HostFixture flushPageInsets />);
    const host = view.container.firstElementChild;

    expect(host?.classList.contains("-m-4")).toBe(true);
    expect(host?.classList.contains("h-[calc(100%+2rem)]")).toBe(true);
    expect(host?.classList.contains("md:-m-5")).toBe(true);
    expect(host?.classList.contains("md:h-[calc(100%+2.5rem)]")).toBe(true);
  });

  it("flushes page insets when a right-panel registration finishes loading", () => {
    hostState.rightPanelAvailable = false;
    const view = render(<HostFixture flushPageInsets />);

    expect(view.container.firstElementChild?.classList.contains("h-full")).toBe(
      true,
    );
    expect(view.container.firstElementChild?.classList.contains("-m-4")).toBe(
      false,
    );

    hostState.rightPanelAvailable = true;
    view.rerender(<HostFixture flushPageInsets />);

    expect(view.container.firstElementChild?.classList.contains("-m-4")).toBe(
      true,
    );
    expect(
      view.container.firstElementChild?.classList.contains(
        "md:h-[calc(100%+2.5rem)]",
      ),
    ).toBe(true);
  });

  it("scopes persisted state by owning split pane", () => {
    expect(
      getPluginPanelRightPanelStateId({
        panelPath: "tasks",
        paneId: "pane-a",
        pluginId: "tasks",
      }),
    ).not.toBe(
      getPluginPanelRightPanelStateId({
        panelPath: "tasks",
        paneId: "pane-b",
        pluginId: "tasks",
      }),
    );
  });

  it("initializes one pinned default without reopening a hidden panel", () => {
    const initialized = ensurePluginRightPanelDefaultView(
      createEmptyFixedPanelTabsState(),
      rightPanelSlot,
    );
    expect(initialized.secondary).toMatchObject({
      isOpen: true,
      activeTabId: expect.stringContaining("navigation"),
    });
    expect(initialized.secondary.tabs).toHaveLength(1);

    const hidden = {
      ...initialized,
      secondary: { ...initialized.secondary, isOpen: false },
    };
    expect(ensurePluginRightPanelDefaultView(hidden, rightPanelSlot)).toBe(
      hidden,
    );
  });

  it("reconciles removed views and revoked host tools", () => {
    const browser = browserTab();
    const removedView = {
      id: "plugin-panel:docs:removed:null",
      kind: "plugin-panel" as const,
      pluginId: "docs",
      actionId: "removed",
      title: "Removed",
      paramsJson: null,
    };
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        tabs: [removedView, browser],
        activeTabId: removedView.id,
        isOpen: true,
      },
    });

    const reconciled = reconcilePluginRightPanelState(state, rightPanelSlot);

    expect(reconciled.secondary.tabs).toHaveLength(0);
    expect(reconciled.secondary.activeTabId).toBeNull();
    expect(reconciled.secondary.isOpen).toBe(false);
  });

  it("selects the nearest following tab when reconciliation removes the active tab", () => {
    const before = browserTab("https://before.example");
    const removedView = {
      id: "plugin-panel:docs:removed:null",
      kind: "plugin-panel" as const,
      pluginId: "docs",
      actionId: "removed",
      title: "Removed",
      paramsJson: null,
    };
    const after = {
      ...browserTab("https://after.example"),
      id: "browser-after",
    };
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        tabs: [before, removedView, after],
        activeTabId: removedView.id,
        isOpen: true,
      },
    });

    const panelWithBrowser = {
      ...rightPanelSlot,
      experimental_rightPanel: {
        ...rightPanelSlot.experimental_rightPanel!,
        tools: ["browser"] as const,
      },
    };
    expect(
      reconcilePluginRightPanelState(state, panelWithBrowser).secondary
        .activeTabId,
    ).toBe("browser:browser-after:none");
  });

  it("updates a pinned default view title without changing visibility", () => {
    const initialized = ensurePluginRightPanelDefaultView(
      createEmptyFixedPanelTabsState(),
      rightPanelSlot,
    );
    const hidden = {
      ...initialized,
      secondary: {
        ...initialized.secondary,
        isOpen: false,
        tabs: initialized.secondary.tabs.map((tab) => ({
          ...tab,
          title: "Old navigation",
        })),
      },
    };

    const reconciled = ensurePluginRightPanelDefaultView(
      hidden,
      rightPanelSlot,
    );

    expect(reconciled.secondary.tabs[0]).toMatchObject({
      title: "Navigation",
    });
    expect(reconciled.secondary.isOpen).toBe(false);
  });

  it("keeps a hidden panel hidden when a removed default is replaced", () => {
    const previousPanel = {
      ...rightPanelSlot,
      experimental_rightPanel: {
        views: [
          {
            id: "previous",
            title: "Previous",
            component: () => null,
          },
        ],
        defaultViewId: "previous",
      },
    } satisfies PluginNavPanelSlot;
    const initialized = ensurePluginRightPanelDefaultView(
      createEmptyFixedPanelTabsState(),
      previousPanel,
    );
    const hidden = {
      ...initialized,
      secondary: { ...initialized.secondary, isOpen: false },
    };
    const reconciled = reconcilePluginRightPanelState(hidden, rightPanelSlot);

    const migrated = ensurePluginRightPanelDefaultView(
      reconciled,
      rightPanelSlot,
      hidden.secondary.isOpen,
    );

    expect(migrated.secondary.activeTabId).toContain("navigation");
    expect(migrated.secondary.isOpen).toBe(false);
  });

  it("keeps the compact drawer closed until an explicit interaction", () => {
    hostState.compact = true;
    const tab = browserTab();
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];

    render(<HostFixture url="https://example.com" />);

    expect(screen.getByTestId("drawer").dataset.open).toBe("false");
  });

  it("closes the compact drawer from native panel chrome without changing wide visibility", () => {
    hostState.compact = true;
    hostState.panelOpen = false;
    const tab = browserTab();
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];
    const view = render(<HostFixture />);

    fireEvent.click(screen.getByRole("button", { name: "Open Browser" }));
    expect(screen.getByTestId("drawer").dataset.open).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close right panel" }));
    expect(screen.getByTestId("drawer").dataset.open).toBe("false");

    hostState.compact = false;
    view.rerender(<HostFixture />);
    expect(
      screen
        .getByTestId("browser-deck")
        .getAttribute("data-can-show-native-browser-view"),
    ).toBe("false");
  });

  it("does not mount revoked Browser content", () => {
    hostState.tools = [];
    const tab = browserTab();
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];

    render(<HostFixture url="https://example.com" />);

    expect(screen.getByTestId("browser-deck").dataset.browserTabCount).toBe(
      "0",
    );
  });

  it("adds a newly registered default without stealing an existing active tab", () => {
    const tab = browserTab();
    const state = createEmptyFixedPanelTabsState({
      secondary: { tabs: [tab], activeTabId: tab.id, isOpen: true },
    });
    const migrated = ensurePluginRightPanelDefaultView(state, rightPanelSlot);
    expect(migrated.secondary.activeTabId).toBe(state.secondary.activeTabId);
    expect(migrated.secondary.tabs).toHaveLength(2);
  });

  it.each(["https://", "not a URL", `https://example.com/${"x".repeat(4096)}`])(
    "rejects malformed or oversized Browser URLs: %s",
    (url) => {
      render(<HostFixture url={url} />);

      fireEvent.click(screen.getByRole("button", { name: "Open Browser" }));

      expect(document.body.dataset.browserRequestAccepted).toBe("false");
      expect(openTab).not.toHaveBeenCalled();
    },
  );

  it("accepts a valid HTTP(S) Browser URL", () => {
    render(<HostFixture url="https://example.com/path" />);

    fireEvent.click(screen.getByRole("button", { name: "Open Browser" }));

    expect(document.body.dataset.browserRequestAccepted).toBe("true");
    expect(openTab).toHaveBeenCalledWith({
      kind: "browser",
      url: "https://example.com/path",
    });
  });

  it("reopens an existing Browser tab in a hidden wide panel", () => {
    const tab = browserTab("https://example.com/path");
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];
    hostState.panelOpen = false;
    render(<HostFixture url={tab.url} />);
    updatePanelState.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Open Browser" }));

    const update = updatePanelState.mock.calls.at(-1)?.[0];
    const next = update(
      createEmptyFixedPanelTabsState({
        secondary: { tabs: [tab], activeTabId: tab.id, isOpen: false },
      }),
    );
    expect(next.secondary).toMatchObject({
      activeTabId: tab.id,
      isOpen: true,
    });
  });

  it("opens scoped Browser popups only for tabs owned by this plugin pane", () => {
    const tab = browserTab();
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];
    render(<HostFixture />);

    act(() => {
      desktopBrowserApiState.onScopedOpenTab?.({
        tabId: "foreign-browser-tab",
        url: "https://foreign.example/popup",
      });
    });
    expect(openTab).not.toHaveBeenCalled();

    act(() => {
      desktopBrowserApiState.onScopedOpenTab?.({
        tabId: tab.id,
        url: "https://example.com/popup",
      });
    });
    expect(openTab).toHaveBeenCalledWith({
      kind: "browser",
      url: "https://example.com/popup",
    });
  });

  it("falls back to legacy popups only from the focused plugin Browser host", () => {
    hostState.desktopBrowserApiMode = "legacy";
    const tab = browserTab();
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];
    render(
      <>
        <HostFixture
          paneContext={{
            ...basePaneContext,
            paneId: "inactive",
            isFocused: false,
          }}
        />
        <HostFixture
          paneContext={{
            ...basePaneContext,
            paneId: "focused",
            isFocused: true,
          }}
        />
      </>,
    );

    expect(onOpenTab).toHaveBeenCalledTimes(1);
    act(() => {
      for (const handler of desktopBrowserApiState.onOpenTab) {
        handler({ url: "https://example.com/legacy-popup" });
      }
    });
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledWith({
      kind: "browser",
      url: "https://example.com/legacy-popup",
    });

    act(() => {
      for (const handler of desktopBrowserApiState.onOpenTab) {
        handler({ url: "/plugins/docs/docs" });
      }
    });
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("opens registered custom views with persisted JSON params", () => {
    render(<HostFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open View" }));
    expect(document.body.dataset.viewRequestAccepted).toBe("true");
    expect(openPluginPanel).toHaveBeenCalledWith({
      pluginId: "docs",
      actionId: "navigation",
      title: "Navigation",
      paramsJson: '{"selected":"today"}',
    });
  });

  it("renders a persisted custom view with route context in flush framing", () => {
    hostState.activePluginPanelTab = {
      actionId: "navigation",
      id: "plugin-panel:docs:navigation:params",
      kind: "plugin-panel",
      paramsJson: '{"selected":"today"}',
      pluginId: "docs",
      title: "Navigation",
    };

    render(<HostFixture subPath="vault/note.md" />);

    const view = screen.getByTestId("custom-view");
    expect(view.textContent).toBe('vault/note.md:{"selected":"today"}');
    expect(view.parentElement?.parentElement?.className).toContain("h-full");
    expect(view.parentElement?.parentElement?.className).not.toContain("p-4");
  });

  it("creates an enabled Terminal and records its target on the panel tab", () => {
    render(<HostFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open Terminal" }));
    expect(document.body.dataset.terminalRequestAccepted).toBe("true");
    expect(createTerminalMutate).toHaveBeenCalledWith(
      {
        cols: 100,
        rows: 30,
        target: { kind: "host_path", hostId: "host-1", cwd: null },
        title: "Plugin shell",
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    const onSuccess = createTerminalMutate.mock.calls.at(-1)?.[1].onSuccess;
    updatePanelState.mockClear();
    onSuccess({ id: "terminal-1" });
    const update = updatePanelState.mock.calls[0]?.[0];
    const next = update(createEmptyFixedPanelTabsState());
    expect(next.secondary).toMatchObject({
      isOpen: true,
      tabs: [
        expect.objectContaining({
          kind: "terminal",
          terminalId: "terminal-1",
          target: { kind: "host_path", hostId: "host-1", cwd: null },
        }),
      ],
    });
  });

  it("rejects a malformed runtime Terminal request without throwing", () => {
    render(<HostFixture />);

    expect(() =>
      fireEvent.click(
        screen.getByRole("button", { name: "Open malformed Terminal" }),
      ),
    ).not.toThrow();
    expect(document.body.dataset.malformedTerminalRequestAccepted).toBe(
      "false",
    );
    expect(createTerminalMutate).not.toHaveBeenCalled();
  });

  it("removes a restored Terminal tab after its target reports it missing", async () => {
    hostState.activeTerminalTab = {
      id: "terminal:terminal-missing",
      kind: "terminal",
      terminalId: "terminal-missing",
      target: { kind: "host_path", hostId: "host-1", cwd: null },
    };
    hostState.terminalSessions = [];

    render(<HostFixture />);

    await waitFor(() =>
      expect(closeTab).toHaveBeenCalledWith("terminal:terminal-missing"),
    );
  });

  it("queries and prunes a missing Terminal while a compact drawer is open over a hidden wide panel", async () => {
    hostState.compact = true;
    hostState.panelOpen = false;
    const view = render(<HostFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Open Terminal" }));
    const onSuccess = createTerminalMutate.mock.calls.at(-1)?.[1].onSuccess;
    onSuccess({ id: "terminal-missing" });
    hostState.activeTerminalTab = {
      id: "terminal:terminal-missing",
      kind: "terminal",
      terminalId: "terminal-missing",
      target: { kind: "host_path", hostId: "host-1", cwd: null },
    };
    hostState.terminalSessions = [];

    view.rerender(<HostFixture />);

    expect(hostState.terminalQueryEnabled).toBe(true);
    await waitFor(() =>
      expect(closeTab).toHaveBeenCalledWith("terminal:terminal-missing"),
    );
  });

  it("closes sessions whose Terminal tool registration is revoked", async () => {
    hostState.tools = [];
    hostState.activeTerminalTab = {
      id: "terminal:terminal-revoked",
      kind: "terminal",
      terminalId: "terminal-revoked",
      target: { kind: "host_path", hostId: "host-1", cwd: null },
    };

    render(<HostFixture />);

    await waitFor(() =>
      expect(closeTerminalMutate).toHaveBeenCalledWith(
        { mode: "force", terminalId: "terminal-revoked" },
        expect.objectContaining({
          onSettled: expect.any(Function),
          onSuccess: expect.any(Function),
        }),
      ),
    );
  });

  it("keeps a revoked Terminal tab and its controls until its host process closes", async () => {
    hostState.rightPanelAvailable = false;
    hostState.activeTerminalTab = {
      id: "terminal:terminal-removed",
      kind: "terminal",
      terminalId: "terminal-removed",
      target: { kind: "host_path", hostId: "host-1", cwd: null },
    };
    render(<HostFixture />);

    expect(await screen.findByTestId("terminal-panel")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close right panel" }),
    ).toBeTruthy();

    const update = updatePanelState.mock.calls[0]?.[0];
    const browser = browserTab();
    const terminal = {
      id: "terminal:terminal-removed",
      kind: "terminal" as const,
      terminalId: "terminal-removed",
      target: { kind: "host_path" as const, hostId: "host-1", cwd: null },
    };
    const state = createEmptyFixedPanelTabsState({
      secondary: {
        tabs: [browser, terminal],
        activeTabId: terminal.id,
        isOpen: true,
      },
    });
    const next = update(state);

    expect(next.secondary.tabs).toEqual([state.secondary.tabs[1]]);
    expect(next.secondary.activeTabId).toBe(state.secondary.tabs[1]?.id);
    expect(next.secondary.isOpen).toBe(true);
  });

  it("retries a failed revoked Terminal close and removes the tab on success", async () => {
    hostState.tools = [];
    hostState.activeTerminalTab = {
      id: "terminal:terminal-retry",
      kind: "terminal",
      terminalId: "terminal-retry",
      target: { kind: "host_path", hostId: "host-1", cwd: null },
    };
    const view = render(<HostFixture />);
    await waitFor(() => expect(closeTerminalMutate).toHaveBeenCalledTimes(1));

    closeTerminalMutate.mock.calls[0]?.[1].onSettled();
    view.rerender(<HostFixture />);
    await waitFor(() => expect(closeTerminalMutate).toHaveBeenCalledTimes(2));
    expect(closeTab).not.toHaveBeenCalledWith("terminal:terminal-retry");

    closeTerminalMutate.mock.calls[1]?.[1].onSuccess();
    expect(closeTab).toHaveBeenCalledWith("terminal:terminal-retry");
  });

  it("closes a persisted Terminal when an observed panel registration disappears", async () => {
    hostState.activeTerminalTab = {
      id: "terminal:terminal-panel-removed",
      kind: "terminal",
      terminalId: "terminal-panel-removed",
      target: { kind: "host_path", hostId: "host-1", cwd: null },
    };
    const view = render(<HostFixture />);
    expect(closeTerminalMutate).not.toHaveBeenCalled();

    hostState.panelAvailable = false;
    view.rerender(<HostFixture />);

    await waitFor(() =>
      expect(closeTerminalMutate).toHaveBeenCalledWith(
        { mode: "force", terminalId: "terminal-panel-removed" },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      ),
    );
  });

  it("does not close restored sessions while the plugin slot is still loading", () => {
    hostState.panelAvailable = false;
    hostState.activeTerminalTab = {
      id: "terminal:terminal-restoring",
      kind: "terminal",
      terminalId: "terminal-restoring",
      target: { kind: "host_path", hostId: "host-1", cwd: null },
    };

    render(<HostFixture />);

    expect(closeTerminalMutate).not.toHaveBeenCalled();
    expect(updatePanelState).not.toHaveBeenCalled();
  });

  it("closes a restored Terminal once frontend loading settles without its plugin", async () => {
    hostState.panelAvailable = false;
    hostState.activeTerminalTab = {
      id: "terminal:terminal-disabled-before-start",
      kind: "terminal",
      terminalId: "terminal-disabled-before-start",
      target: { kind: "host_path", hostId: "host-1", cwd: null },
    };
    const view = render(<HostFixture />);
    expect(closeTerminalMutate).not.toHaveBeenCalled();

    hostState.frontendLoadState = "settled";
    view.rerender(<HostFixture />);

    await waitFor(() =>
      expect(closeTerminalMutate).toHaveBeenCalledWith(
        { mode: "force", terminalId: "terminal-disabled-before-start" },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      ),
    );
  });

  it("keeps the Browser deck mounted when the final tab is removed", () => {
    const tab = browserTab();
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];
    const view = render(<HostFixture />);
    expect(screen.getByTestId("browser-deck").dataset.browserTabCount).toBe(
      "1",
    );

    hostState.activeBrowserTab = null;
    hostState.browserTabs = [];
    view.rerender(<HostFixture />);

    expect(screen.getByTestId("browser-deck").dataset.browserTabCount).toBe(
      "0",
    );
  });

  it("hides the native view when focus leaves or a sibling pane is maximized", () => {
    const tab = browserTab();
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];
    const view = render(<HostFixture />);
    const canShow = () =>
      screen
        .getByTestId("browser-deck")
        .getAttribute("data-can-show-native-browser-view");
    expect(canShow()).toBe("true");

    view.rerender(
      <HostFixture paneContext={{ ...basePaneContext, isFocused: false }} />,
    );
    expect(canShow()).toBe("false");

    view.rerender(
      <HostFixture
        paneContext={{ ...basePaneContext, isFocused: true, isMaximized: true }}
      />,
    );
    expect(canShow()).toBe("true");

    view.rerender(
      <HostFixture
        paneContext={{
          ...basePaneContext,
          isFocused: false,
          isMaximized: false,
        }}
      />,
    );
    expect(canShow()).toBe("false");
  });

  it("does not let stale drawer settle work reveal a quick reopen", () => {
    const frames = installFrameController();
    const tab = browserTab();
    hostState.compact = true;
    hostState.activeBrowserTab = tab;
    hostState.browserTabs = [tab];
    const view = render(<HostFixture />);
    const canShow = () =>
      screen
        .getByTestId("browser-deck")
        .getAttribute("data-can-show-native-browser-view");
    expect(canShow()).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Open Browser" }));
    act(() => drawerState.onContentAnimationEnd?.(true));
    view.rerender(<HostFixture subPath="next" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Browser" }));
    act(() => frames.flushAll());

    expect(canShow()).toBe("false");
    expect(dispatchBrowserViewBoundsSync).not.toHaveBeenCalled();

    act(() => drawerState.onContentAnimationEnd?.(true));
    act(() => frames.flushAll());
    expect(canShow()).toBe("true");
    expect(dispatchBrowserViewBoundsSync).toHaveBeenCalledTimes(1);
  });
});
