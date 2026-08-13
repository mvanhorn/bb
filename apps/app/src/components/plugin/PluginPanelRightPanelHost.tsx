import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Panel, PanelGroup } from "react-resizable-panels";
import { atom, useAtom } from "jotai";
import { atomFamily } from "jotai-family";
import type {
  BbNavigate,
  PluginNavPanelRightPanelTerminalTarget,
} from "@bb/plugin-sdk";
import { BB_DESKTOP_BROWSER_MAX_URL_LENGTH } from "@bb/desktop-contract";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  PersistentResponsiveDrawerShell,
  useResponsiveDrawerRealization,
} from "@bb/shared-ui/responsive-overlay";
import { Icon } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { BrowserTabDeck } from "@/components/secondary-panel/BrowserTabDeck";
import { useThreadFileTabs } from "@/components/secondary-panel/useThreadFileTabs";
import { PANEL_COLLAPSE_TRANSITION_CLASS } from "@/components/secondary-panel/panelTransitionTokens";
import { terminalStatusLabel } from "@/components/thread/terminal/useThreadTerminalController";
import {
  useCloseFixedSecondaryPanel,
  useFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import {
  createPluginPanelFixedPanelTab,
  createTerminalFixedPanelTab,
  type FixedPanelTabsState,
  type TerminalFixedPanelTarget,
} from "@/lib/fixed-panel-tabs-state";
import {
  useCreateTerminal,
  useCloseTerminal,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import {
  getDesktopBrowserApi,
  isDesktopBrowserAvailable,
} from "@/lib/bb-desktop";
import { dispatchBrowserViewBoundsSync } from "@/lib/browser-view-bounds-sync";
import {
  parsePersistedPluginPanelParams,
  serializePluginPanelParams,
} from "@/lib/plugin-json-value";
import { usePluginSlots, type PluginNavPanelSlot } from "@/lib/plugin-slots";
import { isRoutePath } from "@/lib/route-paths";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import {
  getPluginPanelRightPanelStateId,
  PluginRightPanelNavigationProvider,
  useRegisterPluginRightPanelOpenHandler,
} from "./plugin-right-panel-navigation";
import { PluginSlotMount } from "./PluginSlotMount";
import { PluginIcon } from "./PluginIcon";

export { getPluginPanelRightPanelStateId } from "./plugin-right-panel-navigation";

const MAIN_PANEL_MIN_SIZE_PERCENT = 30;
const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 30;
// Match AppPageHeader's reduced-glyph action without importing the eager page
// header implementation into this on-demand panel chunk.
const RIGHT_PANEL_TOGGLE_CLASS =
  "h-[28px] w-[28px] rounded-md p-0 max-md:pointer-coarse:h-[36px] max-md:pointer-coarse:w-[36px] [&_svg]:size-[13px] max-md:pointer-coarse:[&_svg]:size-[16px] text-subtle-foreground/75 hover:text-muted-foreground data-[state=open]:text-subtle-foreground/75";
const LazyThreadSecondaryPanel = lazy(() =>
  import("@/components/secondary-panel/ThreadSecondaryPanel").then(
    ({ ThreadSecondaryPanel }) => ({ default: ThreadSecondaryPanel }),
  ),
);
const LazyThreadTerminalPanel = lazy(() =>
  import("@/components/thread/terminal/ThreadTerminalPanel").then(
    ({ ThreadTerminalPanel }) => ({ default: ThreadTerminalPanel }),
  ),
);
const compactDrawerOpenAtomFamily = atomFamily((_panelStateId: string) =>
  atom(false),
);

function parsePluginBrowserUrl(url: string): URL | null {
  if (url.length > BB_DESKTOP_BROWSER_MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function findPluginRightPanelTogglePortal(
  panelStateId: string,
): HTMLElement | null {
  for (const candidate of document.querySelectorAll<HTMLElement>(
    "[data-plugin-right-panel-toggle-portal]",
  )) {
    if (
      candidate.getAttribute("data-plugin-right-panel-toggle-portal") ===
      panelStateId
    ) {
      return candidate;
    }
  }
  return null;
}

function normalizeTerminalTarget(
  target: PluginNavPanelRightPanelTerminalTarget | null | undefined,
): TerminalFixedPanelTarget | null {
  if (target === null || typeof target !== "object") return null;
  switch (target.kind) {
    case "thread": {
      if (typeof target.threadId !== "string") return null;
      const threadId = target.threadId.trim();
      return threadId ? { kind: "thread", threadId } : null;
    }
    case "environment": {
      if (typeof target.environmentId !== "string") return null;
      const environmentId = target.environmentId.trim();
      return environmentId ? { kind: "environment", environmentId } : null;
    }
    case "host_path": {
      if (
        typeof target.hostId !== "string" ||
        (target.cwd !== undefined &&
          target.cwd !== null &&
          typeof target.cwd !== "string")
      ) {
        return null;
      }
      const hostId = target.hostId.trim();
      const cwd = target.cwd?.trim() || null;
      return hostId ? { kind: "host_path", hostId, cwd } : null;
    }
    default:
      return null;
  }
}

function defaultViewTab(panel: PluginNavPanelSlot) {
  const rightPanel = panel.experimental_rightPanel;
  const view = rightPanel?.views?.find(
    (candidate) => candidate.id === rightPanel.defaultViewId,
  );
  return view
    ? createPluginPanelFixedPanelTab({
        actionId: view.id,
        paramsJson: null,
        pluginId: panel.pluginId,
        title: view.title,
      })
    : null;
}

export function ensurePluginRightPanelDefaultView(
  state: FixedPanelTabsState,
  panel: PluginNavPanelSlot,
  openWhenAdded = true,
): FixedPanelTabsState {
  const tab = defaultViewTab(panel);
  if (tab === null) return state;
  const existingIndex = state.secondary.tabs.findIndex(
    ({ id }) => id === tab.id,
  );
  if (existingIndex !== -1) {
    const existing = state.secondary.tabs[existingIndex];
    if (existing?.kind !== "plugin-panel" || existing.title === tab.title) {
      return state;
    }
    const tabs = [...state.secondary.tabs];
    tabs[existingIndex] = tab;
    return { ...state, secondary: { ...state.secondary, tabs } };
  }
  const activatesAddedView = state.secondary.tabs.length === 0;
  return {
    ...state,
    secondary: {
      ...state.secondary,
      tabs: [tab, ...state.secondary.tabs],
      activeTabId: activatesAddedView ? tab.id : state.secondary.activeTabId,
      isOpen: activatesAddedView ? openWhenAdded : state.secondary.isOpen,
    },
  };
}

export function reconcilePluginRightPanelState(
  state: FixedPanelTabsState,
  panel: PluginNavPanelSlot,
): FixedPanelTabsState {
  const rightPanel = panel.experimental_rightPanel;
  const viewIds = new Set(rightPanel?.views?.map((view) => view.id) ?? []);
  const permitsBrowser = rightPanel?.tools?.includes("browser") ?? false;
  const tabs = state.secondary.tabs.filter((tab) => {
    if (tab.kind === "plugin-panel") {
      return tab.pluginId === panel.pluginId && viewIds.has(tab.actionId);
    }
    if (tab.kind === "browser") return permitsBrowser;
    // Revoked Terminal tabs remain until the host process confirms closure.
    // Removing them here would strand a session if closeTerminal fails.
    if (tab.kind === "terminal") return true;
    return false;
  });
  if (tabs.length === state.secondary.tabs.length) return state;
  const activeIndex = state.secondary.tabs.findIndex(
    (tab) => tab.id === state.secondary.activeTabId,
  );
  const activeTabId = tabs.some((tab) => tab.id === state.secondary.activeTabId)
    ? state.secondary.activeTabId
    : (state.secondary.tabs
        .slice(Math.max(activeIndex + 1, 0))
        .find((candidate) => tabs.some((tab) => tab.id === candidate.id))?.id ??
      state.secondary.tabs
        .slice(0, Math.max(activeIndex, 0))
        .reverse()
        .find((candidate) => tabs.some((tab) => tab.id === candidate.id))?.id ??
      tabs[0]?.id ??
      null);
  return {
    ...state,
    secondary: {
      ...state.secondary,
      tabs,
      activeTabId,
      isOpen: state.secondary.isOpen && activeTabId !== null,
    },
  };
}

function openPluginRightPanelState(
  state: FixedPanelTabsState,
  panel: PluginNavPanelSlot,
  persistOpen = true,
): FixedPanelTabsState {
  const withDefault = ensurePluginRightPanelDefaultView(state, panel);
  const activeTabId =
    withDefault.secondary.activeTabId ??
    withDefault.secondary.tabs[0]?.id ??
    null;
  if (activeTabId === null) return withDefault;
  return {
    ...withDefault,
    secondary: {
      ...withDefault.secondary,
      activeTabId,
      isOpen: persistOpen ? true : state.secondary.isOpen,
    },
  };
}

export function PluginPanelRightPanelHost({
  children,
  panelPath,
  pluginId,
  subPath,
  flushPageInsets = false,
  paneId,
}: {
  children: ReactNode;
  panelPath: string;
  pluginId: string;
  subPath: string;
  flushPageInsets?: boolean;
  paneId?: string;
}) {
  const { frontendLoadState, navPanels } = usePluginSlots();
  const panel =
    navPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.path === panelPath,
    ) ?? null;
  const rightPanel = panel?.experimental_rightPanel;
  const shouldFlushPageInsets = flushPageInsets && rightPanel !== undefined;
  const paneContext = useOptionalPaneContext();
  const panelStateId = getPluginPanelRightPanelStateId({
    panelPath,
    paneId: paneId ?? paneContext?.paneId,
    pluginId,
  });
  const panelState = useFixedPanelTabsState(panelStateId, null);
  const updatePanelState = useUpdateFixedPanelTabsState(panelStateId, null);
  const closePanel = useCloseFixedSecondaryPanel(panelStateId, null);
  const activeTab =
    panelState.secondary.tabs.find(
      (tab) => tab.id === panelState.secondary.activeTabId,
    ) ?? null;
  const activeTerminalTab =
    activeTab?.kind === "terminal" && activeTab.target !== undefined
      ? activeTab
      : null;
  const renderAsDrawer = useIsCompactViewport();
  const [isCompactDrawerOpen, setCompactDrawerOpen] = useAtom(
    compactDrawerOpenAtomFamily(panelStateId),
  );
  const terminalTarget = activeTerminalTab?.target ?? null;
  const terminalScope =
    terminalTarget?.kind === "host_path"
      ? {
          kind: "host_path" as const,
          hostId: terminalTarget.hostId,
          ...(terminalTarget.cwd === null ? {} : { cwd: terminalTarget.cwd }),
        }
      : terminalTarget;
  const terminalQuery = useTerminals(terminalScope, {
    enabled:
      (renderAsDrawer ? isCompactDrawerOpen : panelState.secondary.isOpen) &&
      terminalTarget !== null,
  });
  const terminalSessions = terminalQuery.data?.sessions;
  const terminalsById = useMemo(
    () =>
      new Map((terminalSessions ?? []).map((session) => [session.id, session])),
    [terminalSessions],
  );
  const {
    activateTab,
    activeBrowserTab,
    activePluginPanelTab,
    browserTabs,
    closeTab,
    openPluginPanel,
    openTab,
    orderedSecondaryFileTabs,
    reorderFileTab,
    updateBrowserTab,
  } = useThreadFileTabs({
    panelStateId,
    syncThreadId: null,
    environmentId: null,
    storageFiles: undefined,
    terminalSessions: undefined,
  });
  const createTerminal = useCreateTerminal();
  const { mutate: closeTerminalMutate } = useCloseTerminal();
  const isOpen =
    (rightPanel !== undefined || activeTerminalTab !== null) &&
    (renderAsDrawer ? isCompactDrawerOpen : panelState.secondary.isOpen) &&
    activeTab !== null;
  const canToggle =
    panel !== null &&
    (defaultViewTab(panel) !== null || panelState.secondary.tabs.length > 0);
  const toggleRightPanel = useCallback(() => {
    if (panel === null || rightPanel === undefined) return;
    if (renderAsDrawer) {
      if (isCompactDrawerOpen) {
        setCompactDrawerOpen(false);
      } else {
        updatePanelState((current) =>
          openPluginRightPanelState(current, panel, false),
        );
        setCompactDrawerOpen(true);
      }
      return;
    }
    updatePanelState((current) =>
      current.secondary.isOpen
        ? {
            ...current,
            secondary: { ...current.secondary, isOpen: false },
          }
        : openPluginRightPanelState(current, panel),
    );
  }, [
    isCompactDrawerOpen,
    panel,
    renderAsDrawer,
    rightPanel,
    setCompactDrawerOpen,
    updatePanelState,
  ]);
  const [togglePortalTarget, setTogglePortalTarget] =
    useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setTogglePortalTarget(findPluginRightPanelTogglePortal(panelStateId));
  }, [panel, panelStateId, rightPanel]);
  const canShowWideNativeBrowserView =
    paneContext === null || !paneContext.isSplitPane || paneContext.isFocused;
  const hasObservedPanelRef = useRef(panel !== null);
  const closedRevokedTerminalIdsRef = useRef(new Set<string>());
  const closingRevokedTerminalIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (panel !== null) hasObservedPanelRef.current = true;
  }, [panel]);

  useEffect(() => {
    const revokedTerminalTabs = panelState.secondary.tabs.flatMap((tab) =>
      tab.kind === "terminal" &&
      ((panel === null &&
        (hasObservedPanelRef.current || frontendLoadState === "settled")) ||
        (panel !== null &&
          (!rightPanel?.tools?.includes("terminal") ||
            tab.target === undefined)))
        ? [{ tabId: tab.id, terminalId: tab.terminalId }]
        : [],
    );
    for (const { tabId, terminalId } of revokedTerminalTabs) {
      if (
        closedRevokedTerminalIdsRef.current.has(terminalId) ||
        closingRevokedTerminalIdsRef.current.has(terminalId)
      ) {
        continue;
      }
      closingRevokedTerminalIdsRef.current.add(terminalId);
      closeTerminalMutate(
        { mode: "force", terminalId },
        {
          onSuccess: () => {
            closedRevokedTerminalIdsRef.current.add(terminalId);
            closeTab(tabId);
          },
          onSettled: () => {
            closingRevokedTerminalIdsRef.current.delete(terminalId);
          },
        },
      );
    }
    const revokedTerminalIds = new Set(
      revokedTerminalTabs.map(({ terminalId }) => terminalId),
    );
    for (const terminalId of closedRevokedTerminalIdsRef.current) {
      if (!revokedTerminalIds.has(terminalId)) {
        closedRevokedTerminalIdsRef.current.delete(terminalId);
      }
    }
  }, [
    closeTab,
    closeTerminalMutate,
    frontendLoadState,
    panel,
    panelState.secondary.tabs,
    rightPanel,
  ]);

  useEffect(() => {
    if (panel === null) return;
    updatePanelState((state) => {
      const hadRegisteredTabs = state.secondary.tabs.length > 0;
      const reconciled = reconcilePluginRightPanelState(state, panel);
      if (rightPanel === undefined) return reconciled;
      return ensurePluginRightPanelDefaultView(
        reconciled,
        panel,
        !hadRegisteredTabs || state.secondary.isOpen,
      );
    });
  }, [panel, rightPanel, updatePanelState]);

  useEffect(() => {
    if (
      activeTerminalTab === null ||
      terminalQuery.isLoading ||
      terminalQuery.error !== null ||
      terminalSessions === undefined ||
      terminalsById.has(activeTerminalTab.terminalId)
    ) {
      return;
    }
    closeTab(activeTerminalTab.id);
  }, [
    activeTerminalTab,
    closeTab,
    terminalQuery.error,
    terminalQuery.isLoading,
    terminalSessions,
    terminalsById,
  ]);

  useEffect(() => {
    setCompactDrawerOpen(false);
  }, [renderAsDrawer, setCompactDrawerOpen, subPath]);

  const drawerBrowserSessionKey =
    renderAsDrawer && isOpen ? (activeBrowserTab?.id ?? null) : null;
  const [settledDrawerSessionKey, setSettledDrawerSessionKey] = useState<
    string | null
  >(null);
  const isDrawerBrowserSettled =
    drawerBrowserSessionKey !== null &&
    settledDrawerSessionKey === drawerBrowserSessionKey;
  const { isContentRealized: isPanelRealized, realizeContent: realizePanel } =
    useResponsiveDrawerRealization({ open: isOpen, enabled: renderAsDrawer });
  const drawerSettleFrameRef = useRef<number | null>(null);
  const drawerSettleGenerationRef = useRef(0);
  const drawerSettleStateRef = useRef({
    drawerBrowserSessionKey,
    isOpen,
    renderAsDrawer,
  });

  useLayoutEffect(() => {
    drawerSettleStateRef.current = {
      drawerBrowserSessionKey,
      isOpen,
      renderAsDrawer,
    };
  }, [drawerBrowserSessionKey, isOpen, renderAsDrawer]);

  const cancelDrawerSettleFrame = useCallback(() => {
    drawerSettleGenerationRef.current += 1;
    if (drawerSettleFrameRef.current === null) return;
    window.cancelAnimationFrame(drawerSettleFrameRef.current);
    drawerSettleFrameRef.current = null;
  }, []);

  useLayoutEffect(() => {
    cancelDrawerSettleFrame();
    setSettledDrawerSessionKey(null);
  }, [
    cancelDrawerSettleFrame,
    drawerBrowserSessionKey,
    isOpen,
    renderAsDrawer,
  ]);

  useLayoutEffect(
    () => () => {
      cancelDrawerSettleFrame();
    },
    [cancelDrawerSettleFrame],
  );

  const handleDrawerContentAnimationEnd = useCallback(
    (open: boolean) => {
      if (!open) return;
      const current = drawerSettleStateRef.current;
      if (
        !current.isOpen ||
        !current.renderAsDrawer ||
        current.drawerBrowserSessionKey === null
      ) {
        realizePanel();
        return;
      }
      cancelDrawerSettleFrame();
      const generation = drawerSettleGenerationRef.current;
      const sessionKey = current.drawerBrowserSessionKey;
      drawerSettleFrameRef.current = window.requestAnimationFrame(() => {
        drawerSettleFrameRef.current = null;
        const latest = drawerSettleStateRef.current;
        if (
          drawerSettleGenerationRef.current !== generation ||
          !latest.isOpen ||
          !latest.renderAsDrawer ||
          latest.drawerBrowserSessionKey !== sessionKey
        ) {
          return;
        }
        dispatchBrowserViewBoundsSync();
        setSettledDrawerSessionKey(sessionKey);
        realizePanel();
      });
    },
    [cancelDrawerSettleFrame, realizePanel],
  );

  const experimentalOpenRightPanel = useCallback<
    BbNavigate["experimental_openRightPanel"]
  >(
    (request) => {
      if (
        panel === null ||
        rightPanel === undefined ||
        request === null ||
        typeof request !== "object" ||
        typeof request.kind !== "string"
      ) {
        return false;
      }
      if (request.kind === "view") {
        if (
          typeof request.viewId !== "string" ||
          (request.title !== undefined && typeof request.title !== "string")
        ) {
          return false;
        }
        const view = rightPanel.views?.find(
          (candidate) => candidate.id === request.viewId,
        );
        if (view === undefined) return false;
        let paramsJson: string | null;
        try {
          paramsJson = serializePluginPanelParams(request.params);
        } catch {
          return false;
        }
        const preserveWideVisibility = panelState.secondary.isOpen;
        openPluginPanel({
          pluginId,
          actionId: view.id,
          title: request.title?.trim() || view.title,
          paramsJson,
        });
        if (renderAsDrawer) {
          updatePanelState((state) => ({
            ...state,
            secondary: {
              ...state.secondary,
              isOpen: preserveWideVisibility,
            },
          }));
          setCompactDrawerOpen(true);
        }
        return true;
      }
      if (!rightPanel.tools?.includes(request.kind)) return false;
      if (request.kind === "browser") {
        if (
          typeof request.url !== "string" ||
          !isDesktopBrowserAvailable() ||
          parsePluginBrowserUrl(request.url) === null
        ) {
          return false;
        }
        const existing = browserTabs.find((tab) => tab.url === request.url);
        const preserveWideVisibility = panelState.secondary.isOpen;
        if (existing) {
          updatePanelState((state) => ({
            ...state,
            secondary: {
              ...state.secondary,
              activeTabId: existing.id,
              isOpen: renderAsDrawer ? state.secondary.isOpen : true,
            },
          }));
        } else {
          openTab({ kind: "browser", url: request.url });
        }
        if (renderAsDrawer) {
          updatePanelState((state) => ({
            ...state,
            secondary: {
              ...state.secondary,
              isOpen: preserveWideVisibility,
            },
          }));
          setCompactDrawerOpen(true);
        }
        return true;
      }
      if (request.title !== undefined && typeof request.title !== "string") {
        return false;
      }
      const target = normalizeTerminalTarget(request.target);
      if (target === null || createTerminal.isPending) return false;
      createTerminal.mutate(
        {
          cols: TERMINAL_COLS,
          rows: TERMINAL_ROWS,
          target,
          ...(request.title?.trim() ? { title: request.title.trim() } : {}),
        },
        {
          onSuccess: (session) => {
            const tab = createTerminalFixedPanelTab({
              terminalId: session.id,
              target,
            });
            updatePanelState((state) => ({
              ...state,
              secondary: {
                ...state.secondary,
                tabs: [...state.secondary.tabs, tab],
                activeTabId: tab.id,
                isOpen: renderAsDrawer ? state.secondary.isOpen : true,
              },
            }));
            if (renderAsDrawer) setCompactDrawerOpen(true);
          },
        },
      );
      return true;
    },
    [
      browserTabs,
      createTerminal,
      openPluginPanel,
      openTab,
      panel,
      panelState.secondary.isOpen,
      pluginId,
      rightPanel,
      renderAsDrawer,
      setCompactDrawerOpen,
      updatePanelState,
    ],
  );
  useRegisterPluginRightPanelOpenHandler(
    panelStateId,
    experimentalOpenRightPanel,
  );
  const browserTabIds = useMemo(
    () => new Set(browserTabs.map((tab) => tab.id)),
    [browserTabs],
  );
  useEffect(() => {
    const browserApi = getDesktopBrowserApi();
    if (browserApi === null) return;
    if (browserApi.onScopedOpenTab) {
      return browserApi.onScopedOpenTab(({ tabId, url }) => {
        if (browserTabIds.has(tabId)) {
          experimentalOpenRightPanel({ kind: "browser", url });
        }
      });
    }
    if (activeBrowserTab === null || !canShowWideNativeBrowserView) return;
    return browserApi.onOpenTab(({ url }) => {
      if (!isRoutePath({ path: url })) {
        experimentalOpenRightPanel({ kind: "browser", url });
      }
    });
  }, [
    activeBrowserTab,
    browserTabIds,
    canShowWideNativeBrowserView,
    experimentalOpenRightPanel,
  ]);

  const browserDeck = useMemo(
    () => (
      <BrowserTabDeck
        browserTabs={rightPanel?.tools?.includes("browser") ? browserTabs : []}
        activeBrowserTabId={
          rightPanel?.tools?.includes("browser")
            ? (activeBrowserTab?.id ?? null)
            : null
        }
        environmentId={null}
        canShowNativeBrowserView={
          isOpen &&
          (renderAsDrawer
            ? isDrawerBrowserSettled
            : canShowWideNativeBrowserView)
        }
        threadId={panelStateId}
        onUpdate={updateBrowserTab}
      />
    ),
    [
      activeBrowserTab?.id,
      browserTabs,
      canShowWideNativeBrowserView,
      isDrawerBrowserSettled,
      isOpen,
      panelStateId,
      renderAsDrawer,
      rightPanel,
      updateBrowserTab,
    ],
  );

  const activeView =
    activePluginPanelTab === null
      ? undefined
      : rightPanel?.views?.find(
          (view) =>
            activePluginPanelTab.pluginId === pluginId &&
            view.id === activePluginPanelTab.actionId,
        );
  const activeViewParams = useMemo(
    () =>
      activePluginPanelTab === null
        ? null
        : parsePersistedPluginPanelParams(activePluginPanelTab.paramsJson),
    [activePluginPanelTab],
  );
  const activeViewContent =
    activeView && activePluginPanelTab && panel ? (
      <div
        className={
          activeView.layout === "flush"
            ? "flex h-full min-h-0 flex-col"
            : "h-full overflow-auto p-4"
        }
      >
        <PluginSlotMount
          key={`${panel.pluginId}/${panel.id}/right-panel/${activeView.id}/${activePluginPanelTab.id}/${panel.generation}`}
          pluginId={panel.pluginId}
          slotKind="navPanelRightPanel"
          slotId={`${panel.id}:${activeView.id}`}
        >
          <activeView.component subPath={subPath} params={activeViewParams} />
        </PluginSlotMount>
      </div>
    ) : activePluginPanelTab ? (
      <EmptyStatePanel className="m-4 p-4 text-sm">
        This right-panel view is no longer available.
      </EmptyStatePanel>
    ) : null;
  const terminalContent =
    activeTerminalTab && terminalTarget ? (
      <Suspense fallback={null}>
        <LazyThreadTerminalPanel
          canCreateTerminal={rightPanel?.tools?.includes("terminal") === true}
          fixedPanelTarget={terminalTarget}
          fixedTerminalId={activeTerminalTab.terminalId}
          isPanelOpen={isOpen}
          isPanelPersistedOpen={panelState.secondary.isOpen}
          panelStateId={panelStateId}
          target={terminalTarget}
        />
      </Suspense>
    ) : null;

  const fileTabs = useMemo(
    () =>
      orderedSecondaryFileTabs.flatMap((tab) => {
        if (tab.kind === "browser") {
          if (!rightPanel?.tools?.includes("browser")) return [];
          return [
            {
              id: tab.id,
              filename:
                tab.title ??
                (parsePluginBrowserUrl(tab.url)?.hostname || "Browser"),
              isActive: tab.id === activeTab?.id,
              leadingVisual: (
                <Icon name="Globe" className="size-3.5" aria-hidden />
              ),
              statusLabel: null,
              onSelect: () => activateTab(tab.id),
              onClose: () => closeTab(tab.id),
            },
          ];
        }
        if (tab.kind === "plugin-panel") {
          const view = rightPanel?.views?.find(
            (candidate) =>
              tab.pluginId === pluginId && candidate.id === tab.actionId,
          );
          if (view === undefined) return [];
          return [
            {
              id: tab.id,
              filename: tab.title,
              isActive: tab.id === activeTab?.id,
              isPinned:
                view.id === rightPanel?.defaultViewId &&
                tab.paramsJson === null,
              leadingVisual: (
                <PluginIcon
                  pluginId={pluginId}
                  icon={view.icon ?? panel?.icon ?? "PanelRight"}
                  className="size-3.5"
                />
              ),
              statusLabel: null,
              onSelect: () => activateTab(tab.id),
              onClose: () => closeTab(tab.id),
            },
          ];
        }
        if (tab.kind === "terminal" && tab.target !== undefined) {
          const session = terminalsById.get(tab.terminalId);
          return [
            {
              id: tab.id,
              filename: session?.title ?? "Terminal",
              isActive: tab.id === activeTab?.id,
              leadingVisual: (
                <Icon name="Terminal" className="size-3.5" aria-hidden />
              ),
              statusLabel:
                session === undefined || session.status === "running"
                  ? null
                  : terminalStatusLabel(session),
              onSelect: () => activateTab(tab.id),
              onClose: () => {
                closeTerminalMutate(
                  { mode: "force", terminalId: tab.terminalId },
                  { onSuccess: () => closeTab(tab.id) },
                );
              },
            },
          ];
        }
        return [];
      }),
    [
      activateTab,
      activeTab?.id,
      closeTab,
      closeTerminalMutate,
      orderedSecondaryFileTabs,
      panel?.icon,
      pluginId,
      rightPanel,
      terminalsById,
    ],
  );

  const rightPanelMarkup =
    fileTabs.length > 0 ? (
      <Suspense fallback={browserDeck}>
        <LazyThreadSecondaryPanel
          activeTab={activeTab}
          canUseGitUi={false}
          metadataContent={null}
          fileTabs={fileTabs}
          fileTabContent={terminalContent ?? activeViewContent}
          fileTabContentFillsRegion={
            terminalContent !== null || activeView?.layout === "flush"
          }
          onFileTabReorder={reorderFileTab}
          browserDeck={browserDeck}
          isBrowserTabActive={activeBrowserTab !== null}
          isOpen={isOpen}
          showConversationCollapseControl={false}
          showGitDiffTab={false}
          showInfoTab={false}
          showNewTabButton={false}
          topChromeSurface="page"
          onPanelFocus={() => {}}
          onPanelChange={() => {}}
          onCollapse={() =>
            renderAsDrawer ? setCompactDrawerOpen(false) : closePanel()
          }
          onClose={() =>
            renderAsDrawer ? setCompactDrawerOpen(false) : closePanel()
          }
          onOpenNewTab={() => {}}
          isConversationCollapsed={false}
          onToggleConversationCollapse={() => {}}
          renderAsDrawer={renderAsDrawer}
        />
      </Suspense>
    ) : (
      browserDeck
    );

  return (
    <PluginRightPanelNavigationProvider
      experimentalOpenRightPanel={experimentalOpenRightPanel}
    >
      <>
        {canToggle && togglePortalTarget
          ? createPortal(
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={RIGHT_PANEL_TOGGLE_CLASS}
                    aria-label={
                      isOpen ? "Hide right panel" : "Show right panel"
                    }
                    aria-pressed={isOpen}
                    onClick={toggleRightPanel}
                  >
                    <Icon name="PanelRight" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isOpen ? "Hide right panel" : "Show right panel"}
                </TooltipContent>
              </Tooltip>,
              togglePortalTarget,
            )
          : null}
        <div
          className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${
            shouldFlushPageInsets
              ? "-m-4 h-[calc(100%+2rem)] md:-m-5 md:h-[calc(100%+2.5rem)]"
              : "h-full"
          }`}
        >
          {renderAsDrawer ? (
            children
          ) : (
            <PanelGroup
              direction="horizontal"
              className="@container h-full min-w-0 flex-1"
              style={{ overflow: "clip" }}
            >
              <Panel
                id={`plugin-panel-main-${pluginId}-${panelPath}`}
                defaultSize={isOpen ? 65 : 100}
                minSize={MAIN_PANEL_MIN_SIZE_PERCENT}
                order={1}
                className={`min-w-0 overflow-clip transition-[flex-grow,flex-basis] ${PANEL_COLLAPSE_TRANSITION_CLASS}`}
              >
                {children}
              </Panel>
              {rightPanelMarkup}
            </PanelGroup>
          )}
          {renderAsDrawer ? (
            <PersistentResponsiveDrawerShell
              open={isOpen}
              onOpenChange={(open) => {
                if (!open) setCompactDrawerOpen(false);
              }}
              srLabel="Right panel"
              contentClassName="h-[92dvh] max-h-[92dvh]"
              onContentAnimationEnd={handleDrawerContentAnimationEnd}
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {isPanelRealized ? rightPanelMarkup : null}
              </div>
            </PersistentResponsiveDrawerShell>
          ) : null}
        </div>
      </>
    </PluginRightPanelNavigationProvider>
  );
}
